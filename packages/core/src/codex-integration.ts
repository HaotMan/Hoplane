import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AppError } from "../../shared/src/index.js";

const MANAGED_START = "# BEGIN HOPLANE MANAGED MCP";
const MANAGED_END = "# END HOPLANE MANAGED MCP";

export interface StdioRuntime {
  command: string;
  adapterEntry: string;
  diagnoseEntry: string;
  electronRunAsNode: boolean;
}

export interface CodexIntegrationState {
  installed: boolean;
  skillInstalled: boolean;
  mcpConfigured: boolean;
  restartRequired: boolean;
  codexHome: string;
  skillPath: string;
  configPath: string;
  runtimeCommand: string;
  configSnippet: string;
  canInstall: boolean;
  candidates: CodexHomeCandidate[];
}

export interface CodexHomeCandidate {
  path: string;
  label: string;
  source: "SELECTED" | "ENVIRONMENT" | "DEFAULT" | "COMMON";
  exists: boolean;
  isDirectory: boolean;
  configStatus: "VALID" | "MISSING" | "INVALID";
  configDetail: string;
  writable: boolean;
  selected: boolean;
}

interface CodexIntegrationOptions {
  codexHome?: string;
  skillSource?: string;
  runtime?: StdioRuntime;
  candidateHomes?: Array<{ path: string; label: string; source?: CodexHomeCandidate["source"] }>;
  userHome?: string;
  environment?: NodeJS.ProcessEnv;
}

export type JsonAgentKind = "cursor" | "claude-code";

export interface JsonAgentIntegrationState {
  agent: JsonAgentKind;
  installed: boolean;
  skillInstalled: boolean;
  mcpConfigured: boolean;
  restartRequired: boolean;
  configDirectory: string;
  agentHome: string;
  skillPath: string;
  configPath: string;
  runtimeCommand: string;
  configSnippet: string;
  canInstall: boolean;
  configError: string | null;
  candidates: JsonAgentHomeCandidate[];
}

export interface JsonAgentHomeCandidate {
  path: string;
  label: string;
  source: "SELECTED" | "ENVIRONMENT" | "DEFAULT" | "COMMON";
  exists: boolean;
  isDirectory: boolean;
  configStatus: "VALID" | "MISSING" | "INVALID";
  configDetail: string;
  writable: boolean;
  selected: boolean;
}

interface JsonAgentIntegrationOptions {
  configDirectory?: string;
  userHome?: string;
  skillSource?: string;
  runtime?: StdioRuntime;
  candidateDirectories?: Array<{ path: string; label: string; source?: JsonAgentHomeCandidate["source"] }>;
  environment?: NodeJS.ProcessEnv;
}

export class CodexIntegrationService {
  private selectedCodexHome?: string;
  private readonly skillSource: string;
  private readonly runtime: StdioRuntime;
  private readonly candidateHomes?: CodexIntegrationOptions["candidateHomes"];
  private readonly userHome: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: CodexIntegrationOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.userHome = options.userHome ?? homedir();
    this.selectedCodexHome = options.codexHome ? normalizeCodexHome(options.codexHome, this.userHome) : undefined;
    this.candidateHomes = options.candidateHomes;
    this.skillSource = options.skillSource ?? process.env.HOPLANE_CODEX_SKILL_SOURCE ?? join(process.cwd(), "integrations", "codex", "hoplane");
    this.runtime = options.runtime ?? resolveStdioRuntime();
  }

  async getState(): Promise<CodexIntegrationState> {
    const discovered = await this.discoverCodexHomes();
    const preferred = this.selectedCodexHome
      ?? normalizeOptionalCodexHome(this.environment.CODEX_HOME, this.userHome)
      ?? discovered.find((candidate) => candidate.configStatus === "VALID")?.path
      ?? join(this.userHome, ".codex");
    const codexHome = normalizeCodexHome(preferred, this.userHome);
    if (!discovered.some((candidate) => candidate.path === codexHome)) {
      discovered.unshift(await inspectCodexHome(codexHome, "已选择的目录", "SELECTED"));
    }
    const candidates = discovered.map((candidate) => ({ ...candidate, selected: candidate.path === codexHome }));
    const selectedCandidate = candidates.find((candidate) => candidate.selected)!;
    const skillPath = join(codexHome, "skills", "hoplane");
    const configPath = join(codexHome, "config.toml");
    const configSnippet = renderMcpConfig(this.runtime);
    const [skillInstalled, config] = await Promise.all([
      access(join(skillPath, "SKILL.md"), constants.R_OK).then(() => true).catch(() => false),
      readFile(configPath, "utf8").catch(() => "")
    ]);
    const mcpConfigured = config.includes(MANAGED_START) && config.includes(configSnippet);
    return {
      installed: skillInstalled && mcpConfigured,
      skillInstalled,
      mcpConfigured,
      restartRequired: false,
      codexHome,
      skillPath,
      configPath,
      runtimeCommand: this.runtime.command,
      configSnippet,
      canInstall: selectedCandidate.isDirectory && selectedCandidate.writable && selectedCandidate.configStatus !== "INVALID"
        || !selectedCandidate.exists && selectedCandidate.writable,
      candidates
    };
  }

  async selectCodexHome(path: string): Promise<CodexIntegrationState> {
    const normalized = normalizeCodexHome(path, this.userHome);
    const candidate = await inspectCodexHome(normalized, "手动选择", "SELECTED");
    if (candidate.configStatus === "INVALID") {
      throw new AppError("CODEX_HOME_INVALID", candidate.configDetail, false, undefined, { path: normalized }, 409);
    }
    if (!candidate.writable) {
      throw new AppError("CODEX_HOME_NOT_WRITABLE", "Codex directory or its nearest existing parent is not writable", false, undefined, { path: normalized }, 409);
    }
    this.selectedCodexHome = normalized;
    return this.getState();
  }

  async discoverCodexHomes(): Promise<CodexHomeCandidate[]> {
    const seeds: Array<{ path: string; label: string; source: CodexHomeCandidate["source"] }> = [];
    if (this.selectedCodexHome) seeds.push({ path: this.selectedCodexHome, label: "已选择的目录", source: "SELECTED" });
    const environmentHome = normalizeOptionalCodexHome(this.environment.CODEX_HOME, this.userHome);
    if (environmentHome) seeds.push({ path: environmentHome, label: "CODEX_HOME 环境变量", source: "ENVIRONMENT" });
    if (this.candidateHomes) {
      seeds.push(...this.candidateHomes.map((candidate) => ({ ...candidate, source: candidate.source ?? "COMMON" as const })));
    } else {
      seeds.push(
        { path: join(this.userHome, ".codex"), label: "用户默认目录", source: "DEFAULT" },
        { path: join(this.userHome, ".config", "codex"), label: "XDG 常见目录", source: "COMMON" },
        { path: join(this.userHome, "Library", "Application Support", "Codex"), label: "macOS 应用数据目录", source: "COMMON" }
      );
      if (this.environment.APPDATA) seeds.push({ path: join(this.environment.APPDATA, "Codex"), label: "Windows Roaming 配置", source: "COMMON" });
      if (this.environment.LOCALAPPDATA) seeds.push({ path: join(this.environment.LOCALAPPDATA, "Codex"), label: "Windows Local 配置", source: "COMMON" });
    }
    const unique = new Map<string, typeof seeds[number]>();
    for (const seed of seeds) {
      const path = normalizeCodexHome(seed.path, this.userHome);
      if (!unique.has(path)) unique.set(path, { ...seed, path });
    }
    return Promise.all([...unique.values()].map((seed) => inspectCodexHome(seed.path, seed.label, seed.source)));
  }

  async install(): Promise<CodexIntegrationState> {
    await this.validateRuntime();
    const state = await this.getState();
    if (!state.canInstall) throw new AppError("CODEX_HOME_INVALID", "Selected Codex directory is not ready for installation", false, undefined, { path: state.codexHome }, 409);
    const skillPath = join(state.codexHome, "skills", "hoplane");
    await rejectSymlink(skillPath);
    await mkdir(skillPath, { recursive: true, mode: 0o700 });
    await copyDirectory(this.skillSource, skillPath);
    await this.writeDiagnosticLaunchers(skillPath);

    const configPath = join(state.codexHome, "config.toml");
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    const current = await readFile(configPath, "utf8").catch(() => "");
    const next = upsertHoplaneMcpConfig(current, this.runtime);
    if (next !== current) {
      if (current) await writeFile(`${configPath}.hoplane-backup`, current, { mode: 0o600, flag: "wx" }).catch(() => undefined);
      const temporary = `${configPath}.hoplane-${process.pid}-${Date.now()}.tmp`;
      await writeFile(temporary, next, { mode: 0o600 });
      await rename(temporary, configPath);
      await chmod(configPath, 0o600);
    }
    return { ...await this.getState(), restartRequired: true };
  }

  async diagnose(): Promise<{ ok: boolean; toolNames: string[]; checks: Array<{ name: string; ok: boolean; detail: string }> }> {
    const state = await this.getState();
    const checks = [
      { name: "Skill", ok: state.skillInstalled, detail: state.skillInstalled ? state.skillPath : "Hoplane Skill is not installed" },
      { name: "Codex config", ok: state.mcpConfigured, detail: state.mcpConfigured ? state.configPath : "Hoplane stdio MCP config is missing or stale" }
    ];
    try {
      await this.validateRuntime();
      checks.push({ name: "Runtime", ok: true, detail: this.runtime.command });
    } catch (error) {
      checks.push({ name: "Runtime", ok: false, detail: error instanceof Error ? error.message : String(error) });
      return { ok: false, toolNames: [], checks };
    }

    const transport = new StdioClientTransport({
      command: this.runtime.command,
      args: [this.runtime.adapterEntry],
      env: runtimeEnvironment(this.runtime),
      stderr: "pipe"
    });
    const client = new Client({ name: "hoplane-app-diagnostic", version: "0.1.0" });
    try {
      await withTimeout(client.connect(transport), 15_000, "Hoplane stdio MCP initialization timed out");
      const tools = await withTimeout(client.listTools(), 5_000, "Hoplane MCP tool listing timed out");
      const toolNames = tools.tools.map((tool) => tool.name);
      const expected = ["list_hosts", "test_host", "execute_command", "upload_file", "download_file"];
      const complete = expected.every((name) => toolNames.includes(name));
      checks.push({ name: "stdio MCP", ok: complete, detail: complete ? `${toolNames.length} tools loaded` : `Missing tools: ${expected.filter((name) => !toolNames.includes(name)).join(", ")}` });
      return { ok: checks.every((check) => check.ok), toolNames, checks };
    } catch (error) {
      checks.push({ name: "stdio MCP", ok: false, detail: error instanceof Error ? error.message : String(error) });
      return { ok: false, toolNames: [], checks };
    } finally {
      await client.close().catch(() => transport.close().catch(() => undefined));
    }
  }

  private async validateRuntime(): Promise<void> {
    await access(this.runtime.command, constants.X_OK).catch(() => {
      throw new AppError("CODEX_INTEGRATION_RUNTIME_MISSING", `Hoplane runtime is not executable: ${this.runtime.command}`, false, undefined, undefined, 409);
    });
    await access(this.runtime.adapterEntry, constants.R_OK).catch(() => {
      throw new AppError("CODEX_INTEGRATION_ENTRY_MISSING", `Hoplane MCP entry is missing: ${this.runtime.adapterEntry}`, false, undefined, undefined, 409);
    });
    await access(this.runtime.diagnoseEntry, constants.R_OK).catch(() => {
      throw new AppError("CODEX_INTEGRATION_DIAGNOSE_MISSING", `Hoplane diagnostic entry is missing: ${this.runtime.diagnoseEntry}`, false, undefined, undefined, 409);
    });
    await access(join(this.skillSource, "SKILL.md"), constants.R_OK).catch(() => {
      throw new AppError("CODEX_SKILL_MISSING", `Bundled Hoplane Skill is missing: ${this.skillSource}`, false, undefined, undefined, 409);
    });
  }

  private async writeDiagnosticLaunchers(skillPath: string): Promise<void> {
    const scripts = join(skillPath, "scripts");
    await mkdir(scripts, { recursive: true, mode: 0o700 });
    const envPrefix = this.runtime.electronRunAsNode ? "ELECTRON_RUN_AS_NODE=1 " : "";
    const posix = `#!/bin/sh\n${envPrefix}exec ${shellQuote(this.runtime.command)} ${shellQuote(this.runtime.diagnoseEntry)}\n`;
    await writeFile(join(scripts, "diagnose"), posix, { mode: 0o700 });
    const windowsEnv = this.runtime.electronRunAsNode ? "set \"ELECTRON_RUN_AS_NODE=1\"\r\n" : "";
    const windows = `@echo off\r\n${windowsEnv}${cmdQuote(this.runtime.command)} ${cmdQuote(this.runtime.diagnoseEntry)}\r\n`;
    await writeFile(join(scripts, "diagnose.cmd"), windows, { mode: 0o600 });
  }
}

export class JsonAgentIntegrationService {
  private selectedConfigDirectory?: string;
  private readonly userHome: string;
  private readonly skillSource: string;
  private readonly runtime: StdioRuntime;
  private readonly candidateDirectories?: JsonAgentIntegrationOptions["candidateDirectories"];
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly agent: JsonAgentKind, options: JsonAgentIntegrationOptions = {}) {
    this.userHome = options.userHome ?? homedir();
    this.environment = options.environment ?? process.env;
    this.selectedConfigDirectory = options.configDirectory ? normalizeAgentConfigDirectory(options.configDirectory, this.userHome, this.agent) : undefined;
    this.candidateDirectories = options.candidateDirectories;
    this.skillSource = options.skillSource ?? process.env.HOPLANE_CODEX_SKILL_SOURCE ?? join(process.cwd(), "integrations", "codex", "hoplane");
    this.runtime = options.runtime ?? resolveStdioRuntime();
  }

  async getState(): Promise<JsonAgentIntegrationState> {
    const discovered = await this.discoverConfigDirectories();
    const preferred = this.selectedConfigDirectory
      ?? discovered.find((candidate) => candidate.configStatus === "VALID")?.path
      ?? defaultAgentConfigDirectory(this.agent, this.userHome);
    const configDirectory = normalizeAgentConfigDirectory(preferred, this.userHome, this.agent);
    if (!discovered.some((candidate) => candidate.path === configDirectory)) {
      discovered.unshift(await inspectJsonAgentDirectory(this.agent, configDirectory, "已选择的目录", "SELECTED", this.runtime));
    }
    const candidates = discovered.map((candidate) => ({ ...candidate, selected: candidate.path === configDirectory }));
    const selectedCandidate = candidates.find((candidate) => candidate.selected)!;
    const { agentHome, skillPath, configPath } = jsonAgentPaths(this.agent, configDirectory);
    const [skillInstalled, configInspection] = await Promise.all([
      access(join(skillPath, "SKILL.md"), constants.R_OK).then(() => true).catch(() => false),
      inspectJsonAgentConfig(configPath, this.runtime)
    ]);
    return {
      agent: this.agent,
      installed: skillInstalled && configInspection.configured,
      skillInstalled,
      mcpConfigured: configInspection.configured,
      restartRequired: false,
      configDirectory,
      agentHome,
      skillPath,
      configPath,
      runtimeCommand: this.runtime.command,
      configSnippet: renderJsonMcpConfig(this.runtime),
      canInstall: selectedCandidate.writable && selectedCandidate.configStatus !== "INVALID",
      configError: configInspection.error,
      candidates
    };
  }

  async selectConfigDirectory(path: string): Promise<JsonAgentIntegrationState> {
    const normalized = normalizeAgentConfigDirectory(path, this.userHome, this.agent);
    const candidate = await inspectJsonAgentDirectory(this.agent, normalized, "手动选择", "SELECTED", this.runtime);
    if (candidate.configStatus === "INVALID") {
      throw new AppError("AGENT_INTEGRATION_DIRECTORY_INVALID", candidate.configDetail, false, undefined, { agent: this.agent, path: normalized }, 409);
    }
    if (!candidate.writable) {
      throw new AppError("AGENT_INTEGRATION_DIRECTORY_NOT_WRITABLE", "配置目录或其最近的现有父目录不可写", false, undefined, { agent: this.agent, path: normalized }, 409);
    }
    this.selectedConfigDirectory = normalized;
    return this.getState();
  }

  async discoverConfigDirectories(): Promise<JsonAgentHomeCandidate[]> {
    const seeds: Array<{ path: string; label: string; source: JsonAgentHomeCandidate["source"] }> = [];
    if (this.selectedConfigDirectory) seeds.push({ path: this.selectedConfigDirectory, label: "已选择的目录", source: "SELECTED" });
    if (this.candidateDirectories) {
      seeds.push(...this.candidateDirectories.map((candidate) => ({ ...candidate, source: candidate.source ?? "COMMON" as const })));
    } else if (this.agent === "cursor") {
      seeds.push(
        { path: join(this.userHome, ".cursor"), label: "Cursor 用户目录", source: "DEFAULT" },
        { path: join(this.userHome, ".config", "cursor"), label: "XDG 常见目录", source: "COMMON" }
      );
      if (this.environment.APPDATA) seeds.push({ path: join(this.environment.APPDATA, ".cursor"), label: "Windows Roaming 用户目录", source: "COMMON" });
    } else {
      seeds.push({ path: this.userHome, label: "用户主目录", source: "DEFAULT" });
      if (this.environment.USERPROFILE) seeds.push({ path: this.environment.USERPROFILE, label: "Windows 用户目录", source: "COMMON" });
    }
    const unique = new Map<string, typeof seeds[number]>();
    for (const seed of seeds) {
      const path = normalizeAgentConfigDirectory(seed.path, this.userHome, this.agent);
      if (!unique.has(path)) unique.set(path, { ...seed, path });
    }
    return Promise.all([...unique.values()].map((seed) => inspectJsonAgentDirectory(this.agent, seed.path, seed.label, seed.source, this.runtime)));
  }

  async install(): Promise<JsonAgentIntegrationState> {
    await this.validateRuntime();
    const state = await this.getState();
    if (!state.canInstall) {
      throw new AppError("AGENT_INTEGRATION_CONFIG_INVALID", state.configError ?? "Agent configuration directory is not writable", false, undefined, { agent: this.agent, path: state.configPath }, 409);
    }
    await rejectSymlink(state.skillPath);
    await mkdir(state.skillPath, { recursive: true, mode: 0o700 });
    await copyDirectory(this.skillSource, state.skillPath);
    await writeDiagnosticLaunchers(state.skillPath, this.runtime);

    await rejectSymlink(state.configPath);
    await mkdir(dirname(state.configPath), { recursive: true, mode: 0o700 });
    const currentText = await readFile(state.configPath, "utf8").catch(() => "");
    const current = parseJsonAgentConfig(currentText, state.configPath);
    const currentServers = asPlainObject(current.mcpServers) ?? {};
    const next = {
      ...current,
      mcpServers: {
        ...currentServers,
        hoplane: renderJsonMcpServer(this.runtime)
      }
    };
    const nextText = `${JSON.stringify(next, null, 2)}\n`;
    if (nextText !== currentText) {
      if (currentText) await writeFile(`${state.configPath}.hoplane-backup`, currentText, { mode: 0o600, flag: "wx" }).catch(() => undefined);
      const temporary = `${state.configPath}.hoplane-${process.pid}-${Date.now()}.tmp`;
      await writeFile(temporary, nextText, { mode: 0o600 });
      await rename(temporary, state.configPath);
      await chmod(state.configPath, 0o600);
    }
    return { ...await this.getState(), restartRequired: true };
  }

  private async validateRuntime(): Promise<void> {
    await access(this.runtime.command, constants.X_OK).catch(() => {
      throw new AppError("AGENT_INTEGRATION_RUNTIME_MISSING", `Hoplane runtime is not executable: ${this.runtime.command}`, false, undefined, { agent: this.agent }, 409);
    });
    await access(this.runtime.adapterEntry, constants.R_OK).catch(() => {
      throw new AppError("AGENT_INTEGRATION_ENTRY_MISSING", `Hoplane MCP entry is missing: ${this.runtime.adapterEntry}`, false, undefined, { agent: this.agent }, 409);
    });
    await access(this.runtime.diagnoseEntry, constants.R_OK).catch(() => {
      throw new AppError("AGENT_INTEGRATION_DIAGNOSE_MISSING", `Hoplane diagnostic entry is missing: ${this.runtime.diagnoseEntry}`, false, undefined, { agent: this.agent }, 409);
    });
    await access(join(this.skillSource, "SKILL.md"), constants.R_OK).catch(() => {
      throw new AppError("AGENT_SKILL_MISSING", `Bundled Hoplane Skill is missing: ${this.skillSource}`, false, undefined, { agent: this.agent }, 409);
    });
  }
}

function jsonAgentPaths(agent: JsonAgentKind, configDirectory: string): { agentHome: string; skillPath: string; configPath: string } {
  const agentHome = agent === "cursor" ? configDirectory : join(configDirectory, ".claude");
  return {
    agentHome,
    skillPath: join(agentHome, "skills", "hoplane"),
    configPath: agent === "cursor" ? join(configDirectory, "mcp.json") : join(configDirectory, ".claude.json")
  };
}

function defaultAgentConfigDirectory(agent: JsonAgentKind, userHome: string): string {
  return agent === "cursor" ? join(userHome, ".cursor") : userHome;
}

async function inspectJsonAgentDirectory(
  agent: JsonAgentKind,
  path: string,
  label: string,
  source: JsonAgentHomeCandidate["source"],
  runtime: StdioRuntime
): Promise<JsonAgentHomeCandidate> {
  const info = await stat(path).catch(() => null);
  const exists = info !== null;
  const isDirectory = Boolean(info?.isDirectory());
  const { agentHome, configPath } = jsonAgentPaths(agent, path);
  let configStatus: JsonAgentHomeCandidate["configStatus"] = "MISSING";
  let configDetail = `未找到 ${agent === "cursor" ? "mcp.json" : ".claude.json"}，安装时将创建`;
  if (exists && !isDirectory) {
    configStatus = "INVALID";
    configDetail = "候选路径不是目录";
  } else {
    const configInfo = await stat(configPath).catch(() => null);
    if (configInfo) {
      const inspection = await inspectJsonAgentConfig(configPath, runtime);
      configStatus = inspection.error ? "INVALID" : "VALID";
      configDetail = inspection.error ?? `${agent === "cursor" ? "mcp.json" : ".claude.json"} 可读取并通过 JSON 结构检查`;
    }
  }
  const writable = (!exists || isDirectory)
    && await pathReadyForWrite(path)
    && await pathReadyForWrite(agentHome)
    && await pathReadyForWrite(dirname(configPath));
  return { path, label, source, exists, isDirectory, configStatus, configDetail, writable, selected: false };
}

function normalizeAgentConfigDirectory(path: string, userHome: string, agent: JsonAgentKind): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > 4096) {
    throw new AppError("AGENT_INTEGRATION_DIRECTORY_INVALID", `${agent === "cursor" ? "Cursor" : "Claude Code"} 配置目录路径无效`, false, undefined, { agent }, 400);
  }
  const expanded = trimmed === "~" ? userHome : trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? join(userHome, trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) {
    throw new AppError("AGENT_INTEGRATION_DIRECTORY_INVALID", "配置目录必须使用绝对路径", false, undefined, { agent, path: trimmed }, 400);
  }
  return normalize(expanded);
}

async function inspectCodexHome(path: string, label: string, source: CodexHomeCandidate["source"]): Promise<CodexHomeCandidate> {
  const info = await stat(path).catch(() => null);
  const exists = info !== null;
  const isDirectory = Boolean(info?.isDirectory());
  const writable = isDirectory
    ? await access(path, constants.W_OK).then(() => true).catch(() => false)
    : !exists && await nearestExistingParentWritable(path);
  let configStatus: CodexHomeCandidate["configStatus"] = "MISSING";
  let configDetail = "未找到 config.toml，安装时将创建";
  if (exists && !isDirectory) {
    configStatus = "INVALID";
    configDetail = "候选路径不是目录";
  } else if (isDirectory) {
    const configPath = join(path, "config.toml");
    const configInfo = await stat(configPath).catch(() => null);
    if (configInfo) {
      if (!configInfo.isFile()) {
        configStatus = "INVALID";
        configDetail = "config.toml 不是普通文件";
      } else if (configInfo.size > 2 * 1024 * 1024) {
        configStatus = "INVALID";
        configDetail = "config.toml 超过 2 MiB 安全上限";
      } else {
        try {
          const content = await readFile(configPath, "utf8");
          const error = validateTomlSafety(content);
          configStatus = error ? "INVALID" : "VALID";
          configDetail = error ?? "config.toml 可读取并通过基础结构检查";
        } catch {
          configStatus = "INVALID";
          configDetail = "config.toml 无法读取";
        }
      }
    }
  }
  return { path, label, source, exists, isDirectory, configStatus, configDetail, writable, selected: false };
}

async function nearestExistingParentWritable(path: string): Promise<boolean> {
  let current = dirname(path);
  const root = parse(current).root;
  while (true) {
    const info = await stat(current).catch(() => null);
    if (info) return info.isDirectory() && await access(current, constants.W_OK).then(() => true).catch(() => false);
    if (current === root) return false;
    current = dirname(current);
  }
}

function validateTomlSafety(content: string): string | null {
  if (content.includes("\0") || content.includes("\uFFFD")) return "config.toml 包含无效文本编码";
  const managedStarts = content.split(MANAGED_START).length - 1;
  const managedEnds = content.split(MANAGED_END).length - 1;
  if (managedStarts !== managedEnds || managedStarts > 1) return "config.toml 中的 Hoplane 托管区块不完整";
  for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && !/^\[\[?[^\]\r\n]+\]\]?(?:\s*#.*)?$/u.test(trimmed)) return "config.toml 包含格式异常的表头";
  }
  return null;
}

function normalizeOptionalCodexHome(path: string | undefined, userHome: string): string | undefined {
  if (!path?.trim()) return undefined;
  return normalizeCodexHome(path, userHome);
}

function normalizeCodexHome(path: string, userHome: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > 4096) {
    throw new AppError("CODEX_HOME_INVALID", "Codex directory path is invalid", false, undefined, undefined, 400);
  }
  const expanded = trimmed === "~" ? userHome : trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? join(userHome, trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) throw new AppError("CODEX_HOME_INVALID", "Codex directory must be an absolute path", false, undefined, { path: trimmed }, 400);
  return normalize(expanded);
}

export function upsertHoplaneMcpConfig(current: string, runtime: StdioRuntime): string {
  const lines = current.replaceAll("\r\n", "\n").split("\n");
  const kept: string[] = [];
  let managed = false;
  let hoplaneTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === MANAGED_START) { managed = true; hoplaneTable = false; continue; }
    if (managed) {
      if (trimmed === MANAGED_END) managed = false;
      continue;
    }
    if (isTableHeader(trimmed)) {
      if (isHoplaneTable(trimmed)) { hoplaneTable = true; continue; }
      hoplaneTable = false;
    }
    if (!hoplaneTable) kept.push(line);
  }
  while (kept.length && kept[kept.length - 1]?.trim() === "") kept.pop();
  const prefix = kept.length ? `${kept.join("\n")}\n\n` : "";
  return `${prefix}${MANAGED_START}\n${renderMcpConfig(runtime)}\n${MANAGED_END}\n`;
}

export function renderMcpConfig(runtime: StdioRuntime): string {
  const lines = [
    "[mcp_servers.hoplane]",
    `command = ${tomlString(runtime.command)}`,
    `args = [${tomlString(runtime.adapterEntry)}]`,
    ...(runtime.electronRunAsNode ? ["env = { ELECTRON_RUN_AS_NODE = \"1\" }"] : []),
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 310"
  ];
  return lines.join("\n");
}

function resolveStdioRuntime(): StdioRuntime {
  const compiledAdapter = fileURLToPath(new URL("../../mcp-adapter/src/index.js", import.meta.url));
  const compiledDiagnose = fileURLToPath(new URL("../../mcp-adapter/src/diagnose.js", import.meta.url));
  return {
    command: process.env.HOPLANE_MCP_RUNTIME ?? process.execPath,
    adapterEntry: process.env.HOPLANE_MCP_ENTRY ?? compiledAdapter,
    diagnoseEntry: process.env.HOPLANE_MCP_DIAGNOSE_ENTRY ?? compiledDiagnose,
    electronRunAsNode: process.env.HOPLANE_MCP_RUNTIME_IS_ELECTRON === "1"
  };
}

export function renderJsonMcpConfig(runtime: StdioRuntime): string {
  return JSON.stringify({ mcpServers: { hoplane: renderJsonMcpServer(runtime) } }, null, 2);
}

function renderJsonMcpServer(runtime: StdioRuntime): Record<string, unknown> {
  return {
    type: "stdio",
    command: runtime.command,
    args: [runtime.adapterEntry],
    ...(runtime.electronRunAsNode ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {})
  };
}

async function inspectJsonAgentConfig(configPath: string, runtime: StdioRuntime): Promise<{ configured: boolean; error: string | null }> {
  const info = await stat(configPath).catch(() => null);
  if (!info) return { configured: false, error: null };
  if (!info.isFile()) return { configured: false, error: "配置路径不是普通文件" };
  if (info.size > 2 * 1024 * 1024) return { configured: false, error: "配置文件超过 2 MiB 安全上限" };
  try {
    const config = parseJsonAgentConfig(await readFile(configPath, "utf8"), configPath);
    const servers = asPlainObject(config.mcpServers);
    if (config.mcpServers !== undefined && !servers) return { configured: false, error: "mcpServers 必须是 JSON 对象" };
    const hoplane = asPlainObject(servers?.hoplane);
    return { configured: Boolean(hoplane && jsonMcpServerMatches(hoplane, runtime)), error: null };
  } catch (error) {
    return { configured: false, error: error instanceof Error ? error.message : "配置文件无法读取" };
  }
}

function parseJsonAgentConfig(content: string, configPath: string): Record<string, unknown> {
  if (!content.trim()) return {};
  if (content.includes("\0") || content.includes("\uFFFD")) {
    throw new AppError("AGENT_INTEGRATION_CONFIG_INVALID", `${configPath} 包含无效文本编码`, false, undefined, { path: configPath }, 409);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new AppError("AGENT_INTEGRATION_CONFIG_INVALID", `${configPath} 不是有效的 JSON`, false, undefined, { path: configPath }, 409); }
  const object = asPlainObject(parsed);
  if (!object) throw new AppError("AGENT_INTEGRATION_CONFIG_INVALID", `${configPath} 的根节点必须是 JSON 对象`, false, undefined, { path: configPath }, 409);
  if (object.mcpServers !== undefined && !asPlainObject(object.mcpServers)) {
    throw new AppError("AGENT_INTEGRATION_CONFIG_INVALID", `${configPath} 的 mcpServers 必须是 JSON 对象`, false, undefined, { path: configPath }, 409);
  }
  return object;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jsonMcpServerMatches(server: Record<string, unknown>, runtime: StdioRuntime): boolean {
  const env = asPlainObject(server.env);
  return server.type === "stdio"
    && server.command === runtime.command
    && Array.isArray(server.args)
    && server.args.length === 1
    && server.args[0] === runtime.adapterEntry
    && (!runtime.electronRunAsNode || env?.ELECTRON_RUN_AS_NODE === "1");
}

async function pathReadyForWrite(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (info) return info.isDirectory() && await access(path, constants.W_OK).then(() => true).catch(() => false);
  return nearestExistingParentWritable(path);
}

function runtimeEnvironment(runtime: StdioRuntime): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) result[key] = value;
  if (runtime.electronRunAsNode) result.ELECTRON_RUN_AS_NODE = "1";
  return result;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

async function writeDiagnosticLaunchers(skillPath: string, runtime: StdioRuntime): Promise<void> {
  const scripts = join(skillPath, "scripts");
  await mkdir(scripts, { recursive: true, mode: 0o700 });
  const envPrefix = runtime.electronRunAsNode ? "ELECTRON_RUN_AS_NODE=1 " : "";
  const posix = `#!/bin/sh\n${envPrefix}exec ${shellQuote(runtime.command)} ${shellQuote(runtime.diagnoseEntry)}\n`;
  await writeFile(join(scripts, "diagnose"), posix, { mode: 0o700 });
  const windowsEnv = runtime.electronRunAsNode ? "set \"ELECTRON_RUN_AS_NODE=1\"\r\n" : "";
  const windows = `@echo off\r\n${windowsEnv}${cmdQuote(runtime.command)} ${cmdQuote(runtime.diagnoseEntry)}\r\n`;
  await writeFile(join(scripts, "diagnose.cmd"), windows, { mode: 0o600 });
}

async function rejectSymlink(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (info?.isSymbolicLink()) throw new AppError("CODEX_SKILL_PATH_UNSAFE", "The existing Hoplane Skill path is a symbolic link", false, undefined, undefined, 409);
}

function isTableHeader(value: string): boolean { return /^\[\[?.+\]\]?$/u.test(value); }
function isHoplaneTable(value: string): boolean { return /^\[\[?\s*mcp_servers\.(?:hoplane|"hoplane"|'hoplane')(?:\.|\s*\])/u.test(value); }
function tomlString(value: string): string { return JSON.stringify(value); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function cmdQuote(value: string): string {
  if (value.includes('"')) throw new AppError("CODEX_INTEGRATION_PATH_UNSAFE", "Hoplane integration paths cannot contain quote characters");
  return `"${value}"`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
