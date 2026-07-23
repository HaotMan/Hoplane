import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { parseDocument, stringify } from "yaml";
import { AppError, policySourceSchema, type Policy, type PolicyDocument } from "../../shared/src/index.js";
import type { CoreConfig } from "./config.js";
import { POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING, type HoplaneDatabase } from "./database.js";

export interface PolicySourceView {
  id: string;
  yaml: string;
  path: string;
  version: number;
  status: Policy["sourceStatus"];
  error: string | null;
}

export class PolicySourceService {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly selfWrites = new Map<string, string>();

  constructor(private readonly config: CoreConfig, private readonly database: HoplaneDatabase, private readonly options: { watch?: boolean } = {}) {}

  async initialize(): Promise<void> {
    await mkdir(this.config.policyDir, { recursive: true, mode: 0o700 });
    await chmod(this.config.policyDir, 0o700).catch(() => undefined);
    await this.removeConsolidatedTemplateSources();
    for (const policy of this.database.listPolicies()) {
      if (!policy.sourcePath) await this.persistExisting(policy);
    }
    await this.rescan();
    if (this.options.watch !== false) {
      this.watcher = chokidar.watch(this.config.policyDir, { depth: 0, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 } });
      this.watcher.on("add", (path) => { if (/\.ya?ml$/iu.test(path)) this.schedule(path, "change"); });
      this.watcher.on("change", (path) => { if (/\.ya?ml$/iu.test(path)) this.schedule(path, "change"); });
      this.watcher.on("unlink", (path) => { if (/\.ya?ml$/iu.test(path)) this.schedule(path, "unlink"); });
      this.watcher.on("error", (error) => process.stderr.write(`Hoplane policy watcher error: ${errorMessage(error)}\n`));
    }
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = null;
  }

  async getSource(id: string): Promise<PolicySourceView> {
    const policy = this.requirePolicy(id);
    const path = policy.sourcePath ?? this.pathFor(policy);
    const yaml = await readFile(path, "utf8").catch(() => serializePolicy(policy));
    return { id, yaml, path, version: policy.version, status: policy.sourceStatus, error: policy.sourceError };
  }

  async create(name: string, document: PolicyDocument): Promise<Policy> {
    const id = randomUUID();
    const path = this.pathFor({ id, name });
    const yaml = serializeSource(id, name, document);
    await this.atomicWrite(path, yaml);
    try {
      return this.database.createPolicy(name, document, { id, sourcePath: path, sourceStatus: "SYNCED", sourceHash: hash(yaml) });
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  async saveDocument(id: string, name: string, document: PolicyDocument, expectedVersion: number): Promise<Policy> {
    return this.saveSource(id, serializeSource(id, name, document), expectedVersion);
  }

  async saveSource(id: string, yaml: string, expectedVersion: number): Promise<Policy> {
    const current = this.requirePolicy(id);
    if (current.version !== expectedVersion) throw versionConflict(expectedVersion, current.version);
    const parsed = parseSource(yaml);
    if (parsed.id && parsed.id !== id) throw new AppError("POLICY_ID_IMMUTABLE", "YAML id does not match the selected policy", false, undefined, undefined, 409);
    const path = current.sourcePath ?? this.pathFor(current);
    const canonicalYaml = serializeSource(id, parsed.name, parsed.document);
    await this.atomicWrite(path, canonicalYaml);
    return this.database.updatePolicy(id, parsed.name, parsed.document, {
      expectedVersion, sourcePath: path, sourceStatus: "SYNCED", sourceHash: hash(canonicalYaml), enabled: true
    });
  }

  async restore(id: string): Promise<Policy> {
    const current = this.requirePolicy(id);
    const path = current.sourcePath ?? this.pathFor(current);
    const yaml = serializePolicy(current);
    await this.atomicWrite(path, yaml);
    return this.database.updatePolicySourceState(id, { enabled: true, sourcePath: path, sourceStatus: "SYNCED", sourceError: null, sourceHash: hash(yaml) });
  }

  async rescan(): Promise<{ scanned: number; updated: number; errors: number }> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(this.config.policyDir, { withFileTypes: true });
    let updated = 0; let errors = 0;
    const files = entries.filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name)).map((entry) => join(this.config.policyDir, entry.name));
    for (const path of files) {
      try { if (await this.reconcile(path)) updated += 1; }
      catch { errors += 1; }
    }
    const existingFiles = new Set(files.map((path) => resolve(path)));
    for (const policy of this.database.listPolicies()) {
      if (policy.sourcePath && !existingFiles.has(resolve(policy.sourcePath))) this.database.updatePolicySourceState(policy.id, { enabled: false, sourceStatus: "MISSING", sourceError: "策略 YAML 文件不存在" });
    }
    return { scanned: files.length, updated, errors };
  }

  private schedule(path: string, kind: "change" | "unlink"): void {
    const resolved = resolve(path);
    const previous = this.timers.get(resolved);
    if (previous) clearTimeout(previous);
    this.timers.set(resolved, setTimeout(() => {
      this.timers.delete(resolved);
      if (kind === "unlink") {
        const policy = this.database.findPolicyBySourcePath(resolved);
        if (policy) this.database.updatePolicySourceState(policy.id, { enabled: false, sourceStatus: "MISSING", sourceError: "策略 YAML 文件已被删除" });
      } else void this.reconcile(resolved).catch(() => undefined);
    }, 300));
  }

  private async reconcile(path: string): Promise<boolean> {
    const resolved = resolve(path);
    const yaml = await readFile(resolved, "utf8");
    const contentHash = hash(yaml);
    if (this.selfWrites.get(resolved) === contentHash) { this.selfWrites.delete(resolved); return false; }
    let parsed: ReturnType<typeof parseSource>;
    try { parsed = parseSource(yaml); }
    catch (error) {
      const existing = this.database.findPolicyBySourcePath(resolved);
      if (existing) this.database.updatePolicySourceState(existing.id, { sourceStatus: "ERROR", sourceError: errorMessage(error) });
      throw error;
    }
    const existing = parsed.id ? this.database.getPolicy(parsed.id) : this.database.findPolicyBySourcePath(resolved);
    if (existing) {
      if (existing.sourcePath && resolve(existing.sourcePath) !== resolved) throw new AppError("POLICY_DUPLICATE_ID", `Policy id ${existing.id} already belongs to ${existing.sourcePath}`);
      if (existing.sourceHash === contentHash && existing.sourceStatus === "SYNCED") return false;
      this.database.updatePolicy(existing.id, parsed.name, parsed.document, { sourcePath: resolved, sourceStatus: "SYNCED", sourceHash: contentHash, enabled: true });
      return true;
    }
    const id = parsed.id ?? randomUUID();
    let finalYaml = yaml;
    if (!parsed.id) {
      finalYaml = serializeSource(id, parsed.name, parsed.document);
      await this.atomicWrite(resolved, finalYaml);
    }
    this.database.createPolicy(parsed.name, parsed.document, { id, sourcePath: resolved, sourceStatus: "SYNCED", sourceHash: hash(finalYaml) });
    return true;
  }

  private async persistExisting(policy: Policy): Promise<void> {
    const path = this.pathFor(policy);
    const yaml = serializePolicy(policy);
    await this.atomicWrite(path, yaml);
    this.database.updatePolicySourceState(policy.id, { sourcePath: path, sourceStatus: "SYNCED", sourceError: null, sourceHash: hash(yaml), enabled: true });
  }

  private async removeConsolidatedTemplateSources(): Promise<void> {
    const pending = this.database.getSetting<string[]>(POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING, []);
    if (pending.length === 0) return;
    const policyRoot = resolve(this.config.policyDir);
    const failed: string[] = [];
    for (const sourcePath of pending) {
      const resolved = resolve(sourcePath);
      const pathFromRoot = relative(policyRoot, resolved);
      const insidePolicyDirectory = pathFromRoot !== "" && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
      if (!insidePolicyDirectory) continue;
      try {
        await unlink(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed.push(sourcePath);
      }
    }
    this.database.setSetting(POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING, failed);
    if (failed.length > 0) throw new AppError("POLICY_TEMPLATE_CLEANUP_FAILED", `无法删除 ${failed.length} 个旧内置策略文件`);
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    this.selfWrites.set(resolve(path), hash(content));
  }

  private pathFor(policy: Pick<Policy, "id" | "name">): string { return join(this.config.policyDir, `${slug(policy.name)}--${policy.id}.yaml`); }
  private requirePolicy(id: string): Policy { const policy = this.database.getPolicy(id); if (!policy) throw new AppError("POLICY_NOT_FOUND", "Policy not found", false, undefined, undefined, 404); return policy; }
}

function parseSource(yaml: string): { id?: string; name: string; document: PolicyDocument } {
  const source = parseDocument(yaml, { prettyErrors: true, strict: true });
  if (source.errors.length > 0) throw new AppError("INVALID_POLICY_YAML", source.errors.map((error) => error.message).join("; "));
  const result = policySourceSchema.safeParse(source.toJS());
  if (!result.success) throw new AppError("INVALID_POLICY_YAML", result.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`).join("; "));
  const { id, name, ...document } = result.data;
  validatePatterns(document);
  return { ...(id ? { id } : {}), name, document };
}

function validatePatterns(document: PolicyDocument): void {
  const patterns = document.commandBlacklist.map((rule) => rule.pattern);
  for (const pattern of patterns) { try { new RegExp(pattern, "u"); } catch { throw new AppError("INVALID_POLICY_REGEX", `Invalid regular expression: ${pattern}`); } }
}

function serializePolicy(policy: Policy): string { return serializeSource(policy.id, policy.name, policy.document); }
function serializeSource(id: string, name: string, document: PolicyDocument): string { return stringify({ id, name, ...document }, { indent: 2, lineWidth: 0 }); }
function hash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function slug(value: string): string { const normalized = value.normalize("NFKD").replace(/[^A-Za-z0-9\u4e00-\u9fff]+/gu, "-").replace(/^-|-$/gu, "").toLowerCase(); return normalized.slice(0, 60) || "policy"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function versionConflict(expected: number, actual: number): AppError { return new AppError("POLICY_VERSION_CONFLICT", `Policy version changed from ${expected} to ${actual}`, false, undefined, { currentVersion: actual }, 409); }
