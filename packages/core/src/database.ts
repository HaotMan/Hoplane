import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AuditLog, Credential, CredentialType, Host, OperationStatus, Policy, PolicyDecision, PolicyDocument, PolicySourceStatus } from "../../shared/src/index.js";
import { AppError, DEFAULT_POLICY_TEMPLATE, POLICY_TEMPLATES } from "../../shared/src/index.js";

type Row = Record<string, unknown>;

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('PASSWORD', 'PRIVATE_KEY', 'SSH_AGENT')),
    secret_ref TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    policy_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22 CHECK(port BETWEEN 1 AND 65535),
    username TEXT NOT NULL,
    credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
    policy_id TEXT REFERENCES policies(id) ON DELETE RESTRICT,
    group_name TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    default_directory TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    ai_access_enabled INTEGER NOT NULL DEFAULT 0,
    monitor_output_enabled INTEGER NOT NULL DEFAULT 0,
    config_revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS host_keys (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    algorithm TEXT NOT NULL DEFAULT 'sha256',
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PENDING', 'TRUSTED', 'REVOKED')),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    trusted_at TEXT,
    UNIQUE(host_id, fingerprint)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    client_type TEXT NOT NULL,
    client_id TEXT,
    host_id TEXT,
    host_name_snapshot TEXT,
    operation_type TEXT NOT NULL,
    request_summary TEXT,
    policy_id TEXT,
    policy_version INTEGER,
    policy_decision TEXT,
    decision_reason_code TEXT,
    status TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER,
    bytes_transferred INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_host_created ON audit_logs(host_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_status_created ON audit_logs(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_host_keys_host ON host_keys(host_id, status);
  `,
  `
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE policies ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 2;
  ALTER TABLE policies ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE policies ADD COLUMN source_path TEXT;
  ALTER TABLE policies ADD COLUMN source_status TEXT NOT NULL DEFAULT 'MISSING';
  ALTER TABLE policies ADD COLUMN source_error TEXT;
  ALTER TABLE policies ADD COLUMN source_hash TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_source_path ON policies(source_path) WHERE source_path IS NOT NULL;
  `
];

const POLICY_V2_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["schema_version", "INTEGER NOT NULL DEFAULT 3"],
  ["enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["source_path", "TEXT"],
  ["source_status", "TEXT NOT NULL DEFAULT 'MISSING'"],
  ["source_error", "TEXT"],
  ["source_hash", "TEXT"]
];

const POLICY_V2_STRUCTURAL_MIGRATION = 4;
const HOST_MONITOR_OUTPUT_MIGRATION = 5;
const POLICY_BLACKLIST_MIGRATION = 6;
const POLICY_TEMPLATE_CONSOLIDATION_MIGRATION = 7;
export const POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING = "policy.v3TemplateConsolidationCleanup";
const LEGACY_READONLY_TEMPLATE_NAMES = new Set(["Docker 排障（只读）", "Kubernetes 排障（只读）"]);
const LEGACY_OPERATIONS_TEMPLATE_NAMES = new Set(["Docker 运维（受限）", "Kubernetes 应用运维（受限）"]);

type CreateHostInput = Omit<Host, "id" | "createdAt" | "updatedAt" | "configRevision" | "status" | "monitorOutputEnabled"> & {
  monitorOutputEnabled?: boolean;
};

export class HoplaneDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const resetToV2 = this.migrate();
    this.seed(resetToV2);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): boolean {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set((this.db.prepare("SELECT version FROM schema_migrations").all() as Row[]).map((row) => Number(row.version)));
    let resetToV2 = false;
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, now());
        if (version === 3) resetToV2 = true;
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });

    // Migration version 3 existed in an earlier build for a different schema
    // change. Never trust the version row alone: repair the actual table shape.
    const columns = new Set((this.db.prepare("PRAGMA table_info(policies)").all() as Row[]).map((row) => String(row.name)));
    const missingColumns = POLICY_V2_COLUMNS.filter(([name]) => !columns.has(name));
    if (missingColumns.length > 0 || !applied.has(POLICY_V2_STRUCTURAL_MIGRATION)) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const [name, definition] of missingColumns) this.db.exec(`ALTER TABLE policies ADD COLUMN ${name} ${definition}`);
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_source_path ON policies(source_path) WHERE source_path IS NOT NULL");
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(POLICY_V2_STRUCTURAL_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (missingColumns.length > 0 || this.hasLegacyPolicyDocuments()) resetToV2 = true;

    const hostColumns = new Set((this.db.prepare("PRAGMA table_info(hosts)").all() as Row[]).map((row) => String(row.name)));
    if (!hostColumns.has("monitor_output_enabled") || !applied.has(HOST_MONITOR_OUTPUT_MIGRATION)) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!hostColumns.has("monitor_output_enabled")) this.db.exec("ALTER TABLE hosts ADD COLUMN monitor_output_enabled INTEGER NOT NULL DEFAULT 0");
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(HOST_MONITOR_OUTPUT_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (!applied.has(POLICY_BLACKLIST_MIGRATION)) {
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(POLICY_BLACKLIST_MIGRATION, now());
      resetToV2 = true;
    }
    return resetToV2;
  }

  private hasLegacyPolicyDocuments(): boolean {
    const rows = this.db.prepare("SELECT policy_json FROM policies").all() as Row[];
    return rows.some((row) => {
      try { return (JSON.parse(String(row.policy_json)) as { schemaVersion?: unknown }).schemaVersion !== 3; }
      catch { return true; }
    });
  }

  private seed(resetToV2: boolean): void {
    const consolidateTemplates = !this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(POLICY_TEMPLATE_CONSOLIDATION_MIGRATION);
    this.transaction(() => {
      if (resetToV2) {
        const legacyPaths = this.listPolicies().filter((policy) => LEGACY_READONLY_TEMPLATE_NAMES.has(policy.name) || LEGACY_OPERATIONS_TEMPLATE_NAMES.has(policy.name)).flatMap((policy) => policy.sourcePath ? [policy.sourcePath] : []);
        if (legacyPaths.length > 0) this.setSetting(POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING, legacyPaths);
        this.db.prepare("UPDATE hosts SET policy_id=NULL").run();
        this.db.prepare("DELETE FROM policies").run();
      }
      const existingNames = new Set(this.listPolicies().map((policy) => policy.name));
      for (const template of POLICY_TEMPLATES) if (!existingNames.has(template.name)) this.createPolicy(template.name, template.document);
      if (consolidateTemplates && !resetToV2) this.consolidateLegacyPolicyTemplates();
      if (resetToV2) {
        const defaultPolicy = this.listPolicies().find((policy) => policy.name === DEFAULT_POLICY_TEMPLATE.name)!;
        this.db.prepare("UPDATE hosts SET policy_id=?,updated_at=? WHERE policy_id IS NULL").run(defaultPolicy.id, now());
        this.setSetting("policy.v3BlacklistUpgradeNotice", { appliedAt: now(), reboundPolicyId: defaultPolicy.id });
      }
      if (consolidateTemplates) this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)").run(POLICY_TEMPLATE_CONSOLIDATION_MIGRATION, now());
    });
  }

  private consolidateLegacyPolicyTemplates(): void {
    const policies = this.listPolicies();
    const readonlyTarget = policies.find((policy) => policy.name === "容器排障（只读）");
    const operationsTarget = policies.find((policy) => policy.name === "容器运维（受限）");
    if (!readonlyTarget || !operationsTarget) throw new Error("Consolidated policy templates were not seeded");
    const legacyReadonly = policies.filter((policy) => LEGACY_READONLY_TEMPLATE_NAMES.has(policy.name));
    const legacyOperations = policies.filter((policy) => LEGACY_OPERATIONS_TEMPLATE_NAMES.has(policy.name));
    this.rebindAndDeletePolicies(legacyReadonly, readonlyTarget.id);
    this.rebindAndDeletePolicies(legacyOperations, operationsTarget.id);
    const paths = [...legacyReadonly, ...legacyOperations].flatMap((policy) => policy.sourcePath ? [policy.sourcePath] : []);
    if (paths.length > 0) {
      const pending = this.getSetting<string[]>(POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING, []);
      this.setSetting(POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING, [...new Set([...pending, ...paths])]);
    }
  }

  private rebindAndDeletePolicies(policies: Policy[], targetId: string): void {
    if (policies.length === 0) return;
    const timestamp = now();
    for (const policy of policies) {
      this.db.prepare("UPDATE hosts SET policy_id=?,config_revision=config_revision+1,updated_at=? WHERE policy_id=?").run(targetId, timestamp, policy.id);
      this.db.prepare("DELETE FROM policies WHERE id=?").run(policy.id);
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key) as Row | undefined;
    if (!row) return fallback;
    try { return JSON.parse(String(row.value_json)) as T; }
    catch { return fallback; }
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), now());
  }

  listHosts(aiOnly = false): Host[] {
    const sql = aiOnly
      ? "SELECT * FROM hosts WHERE enabled = 1 AND ai_access_enabled = 1 ORDER BY name"
      : "SELECT * FROM hosts ORDER BY name";
    return (this.db.prepare(sql).all() as Row[]).map(mapHost);
  }

  getHost(id: string): Host | null {
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as Row | undefined;
    return row ? mapHost(row) : null;
  }

  createHost(input: CreateHostInput): Host {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO hosts
      (id,name,hostname,port,username,credential_id,policy_id,group_name,tags_json,default_directory,enabled,ai_access_enabled,monitor_output_enabled,config_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
      id, input.name, input.hostname, input.port, input.username, input.credentialId, input.policyId,
      input.groupName, JSON.stringify(input.tags), input.defaultDirectory, bool(input.enabled), bool(input.aiAccessEnabled), bool(input.monitorOutputEnabled ?? false), timestamp, timestamp
    );
    return this.requireHost(id);
  }

  updateHost(id: string, patch: Partial<Omit<Host, "id" | "createdAt" | "updatedAt" | "configRevision" | "status">>): Host {
    const current = this.requireHost(id);
    const next = { ...current, ...patch, id: current.id };
    const connectionChanged = current.hostname !== next.hostname || current.port !== next.port || current.username !== next.username || current.credentialId !== next.credentialId;
    this.db.prepare(`UPDATE hosts SET name=?,hostname=?,port=?,username=?,credential_id=?,policy_id=?,group_name=?,tags_json=?,default_directory=?,enabled=?,ai_access_enabled=?,monitor_output_enabled=?,config_revision=config_revision+?,updated_at=? WHERE id=?`).run(
      next.name, next.hostname, next.port, next.username, next.credentialId, next.policyId, next.groupName,
      JSON.stringify(next.tags), next.defaultDirectory, bool(next.enabled), bool(next.aiAccessEnabled), bool(next.monitorOutputEnabled), connectionChanged ? 1 : 0, now(), id
    );
    return this.requireHost(id);
  }

  deleteHost(id: string): void {
    const result = this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
    if (result.changes === 0) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
  }

  private requireHost(id: string): Host {
    const host = this.getHost(id);
    if (!host) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    return host;
  }

  listCredentials(): Credential[] {
    return (this.db.prepare("SELECT * FROM credentials ORDER BY name").all() as Row[]).map(mapCredential);
  }

  getCredential(id: string): Credential | null {
    const row = this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as Row | undefined;
    return row ? mapCredential(row) : null;
  }

  createCredential(name: string, type: CredentialType, secretRef: string | null, metadata: Credential["metadata"]): Credential {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare("INSERT INTO credentials(id,name,type,secret_ref,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, name, type, secretRef, JSON.stringify(metadata), timestamp, timestamp);
    return this.getCredential(id)!;
  }

  updateCredential(id: string, name: string, type: CredentialType, secretRef: string | null, metadata: Credential["metadata"]): Credential {
    const current = this.getCredential(id);
    if (!current) throw new AppError("CREDENTIAL_NOT_FOUND", "Credential not found", false, undefined, undefined, 404);
    const result = this.db.prepare("UPDATE credentials SET name=?,type=?,secret_ref=?,metadata_json=?,updated_at=? WHERE id=?")
      .run(name, type, secretRef, JSON.stringify(metadata), now(), id);
    if (result.changes === 0) throw new AppError("CREDENTIAL_NOT_FOUND", "Credential not found", false, undefined, undefined, 404);
    this.db.prepare("UPDATE hosts SET config_revision=config_revision+1,updated_at=? WHERE credential_id=?").run(now(), id);
    return this.getCredential(id)!;
  }

  deleteCredential(id: string): Credential {
    const credential = this.getCredential(id);
    if (!credential) throw new AppError("CREDENTIAL_NOT_FOUND", "Credential not found", false, undefined, undefined, 404);
    try {
      this.db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
    } catch {
      throw new AppError("CREDENTIAL_IN_USE", "Credential is still assigned to a host", false, undefined, undefined, 409);
    }
    return credential;
  }

  credentialUsageCount(id: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM hosts WHERE credential_id = ?").get(id) as Row;
    return Number(row.count);
  }

  listPolicies(): Policy[] {
    return (this.db.prepare("SELECT * FROM policies ORDER BY name").all() as Row[]).map(mapPolicy);
  }

  getPolicy(id: string): Policy | null {
    const row = this.db.prepare("SELECT * FROM policies WHERE id = ?").get(id) as Row | undefined;
    return row ? mapPolicy(row) : null;
  }

  createPolicy(name: string, document: PolicyDocument, options: { id?: string; sourcePath?: string | null; sourceStatus?: PolicySourceStatus; sourceHash?: string | null } = {}): Policy {
    validateRegexes(document);
    const id = options.id ?? randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO policies(id,name,version,policy_json,schema_version,enabled,source_path,source_status,source_error,source_hash,created_at,updated_at)
      VALUES (?,?,1,?,3,1,?,?,NULL,?,?,?)`)
      .run(id, name, JSON.stringify(document), options.sourcePath ?? null, options.sourceStatus ?? "SYNCED", options.sourceHash ?? null, timestamp, timestamp);
    return this.getPolicy(id)!;
  }

  updatePolicy(id: string, name: string, document: PolicyDocument, options: { expectedVersion?: number; sourcePath?: string | null; sourceStatus?: PolicySourceStatus; sourceHash?: string | null; enabled?: boolean } = {}): Policy {
    validateRegexes(document);
    const current = this.getPolicy(id);
    if (!current) throw new AppError("POLICY_NOT_FOUND", "Policy not found", false, undefined, undefined, 404);
    if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new AppError("POLICY_VERSION_CONFLICT", `Policy version changed from ${options.expectedVersion} to ${current.version}`, false, undefined, { currentVersion: current.version }, 409);
    }
    this.db.prepare(`UPDATE policies SET name=?,policy_json=?,version=version+1,schema_version=3,enabled=?,source_path=?,source_status=?,source_error=NULL,source_hash=?,updated_at=? WHERE id=?`)
      .run(name, JSON.stringify(document), bool(options.enabled ?? true), options.sourcePath === undefined ? current.sourcePath : options.sourcePath,
        options.sourceStatus ?? "SYNCED", options.sourceHash === undefined ? current.sourceHash : options.sourceHash, now(), id);
    return this.getPolicy(id)!;
  }

  updatePolicySourceState(id: string, patch: { enabled?: boolean; sourcePath?: string | null; sourceStatus?: PolicySourceStatus; sourceError?: string | null; sourceHash?: string | null }): Policy {
    const current = this.getPolicy(id);
    if (!current) throw new AppError("POLICY_NOT_FOUND", "Policy not found", false, undefined, undefined, 404);
    this.db.prepare("UPDATE policies SET enabled=?,source_path=?,source_status=?,source_error=?,source_hash=?,updated_at=? WHERE id=?").run(
      bool(patch.enabled ?? current.enabled), patch.sourcePath === undefined ? current.sourcePath : patch.sourcePath,
      patch.sourceStatus ?? current.sourceStatus, patch.sourceError === undefined ? current.sourceError : patch.sourceError,
      patch.sourceHash === undefined ? current.sourceHash : patch.sourceHash, now(), id
    );
    return this.getPolicy(id)!;
  }

  findPolicyBySourcePath(path: string): Policy | null {
    const row = this.db.prepare("SELECT * FROM policies WHERE source_path=?").get(path) as Row | undefined;
    return row ? mapPolicy(row) : null;
  }

  deletePolicy(id: string): void {
    try {
      const result = this.db.prepare("DELETE FROM policies WHERE id = ?").run(id);
      if (result.changes === 0) throw new AppError("POLICY_NOT_FOUND", "Policy not found", false, undefined, undefined, 404);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("POLICY_IN_USE", "Policy is still assigned to a host", false, undefined, undefined, 409);
    }
  }

  getTrustedHostKey(hostId: string): string | null {
    const row = this.db.prepare("SELECT fingerprint FROM host_keys WHERE host_id=? AND status='TRUSTED' ORDER BY trusted_at DESC LIMIT 1").get(hostId) as Row | undefined;
    return row ? String(row.fingerprint) : null;
  }

  observeHostKey(hostId: string, fingerprint: string): void {
    const timestamp = now();
    this.db.prepare(`INSERT INTO host_keys(id,host_id,algorithm,fingerprint,status,first_seen_at,last_seen_at)
      VALUES (?,?,?,?, 'PENDING', ?, ?)
      ON CONFLICT(host_id,fingerprint) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(randomUUID(), hostId, "sha256", fingerprint, timestamp, timestamp);
  }

  trustHostKey(hostId: string, fingerprint: string): void {
    this.requireHost(hostId);
    this.transaction(() => {
      this.db.prepare("UPDATE host_keys SET status='REVOKED' WHERE host_id=? AND status='TRUSTED'").run(hostId);
      const result = this.db.prepare("UPDATE host_keys SET status='TRUSTED',trusted_at=?,last_seen_at=? WHERE host_id=? AND fingerprint=?")
        .run(now(), now(), hostId, fingerprint);
      if (result.changes === 0) throw new AppError("HOST_KEY_NOT_OBSERVED", "Host key must be observed before it can be trusted", false, undefined, undefined, 409);
    });
  }

  createAudit(input: {
    id: string; clientType: string; clientId?: string; hostId?: string; hostNameSnapshot?: string;
    operationType: string; requestSummary?: string;
  }): void {
    this.db.prepare(`INSERT INTO audit_logs
      (id,client_type,client_id,host_id,host_name_snapshot,operation_type,request_summary,status,created_at)
      VALUES (?,?,?,?,?,?,?,'RECEIVED',?)`).run(
      input.id, input.clientType, input.clientId ?? null, input.hostId ?? null, input.hostNameSnapshot ?? null,
      input.operationType, input.requestSummary ?? null, now()
    );
  }

  updateAudit(id: string, patch: {
    policyId?: string | null; policyVersion?: number | null; policyDecision?: PolicyDecision | null;
    decisionReasonCode?: string | null; status?: OperationStatus; exitCode?: number | null;
    durationMs?: number | null; bytesTransferred?: number | null; errorCode?: string | null; errorMessage?: string | null;
    finished?: boolean;
  }): void {
    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    const mapping: Record<string, string> = {
      policyId: "policy_id", policyVersion: "policy_version", policyDecision: "policy_decision",
      decisionReasonCode: "decision_reason_code", status: "status", exitCode: "exit_code", durationMs: "duration_ms",
      bytesTransferred: "bytes_transferred", errorCode: "error_code", errorMessage: "error_message"
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (key in patch) {
        fields.push(`${column}=?`);
        values.push(patch[key as keyof typeof patch] as SQLInputValue);
      }
    }
    if (patch.finished) {
      fields.push("finished_at=?");
      values.push(now());
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE audit_logs SET ${fields.join(",")} WHERE id=?`).run(...values);
  }

  interruptStaleOperations(): void {
    const timestamp = now();
    this.db.prepare("UPDATE audit_logs SET status='INTERRUPTED',error_code='CORE_INTERRUPTED',finished_at=? WHERE status IN ('RECEIVED','EXECUTING')")
      .run(timestamp);
  }

  listAudit(filters: { hostId?: string; status?: string; limit?: number; offset?: number }): AuditLog[] {
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    if (filters.hostId) { where.push("host_id=?"); values.push(filters.hostId); }
    if (filters.status) { where.push("status=?"); values.push(filters.status); }
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    values.push(limit, offset);
    const sql = `SELECT * FROM audit_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...values) as Row[]).map(mapAudit);
  }
}

function now(): string { return new Date().toISOString(); }
function bool(value: boolean): number { return value ? 1 : 0; }

function mapHost(row: Row): Host {
  return {
    id: String(row.id), name: String(row.name), hostname: String(row.hostname), port: Number(row.port), username: String(row.username),
    credentialId: nullable(row.credential_id), policyId: nullable(row.policy_id), groupName: nullable(row.group_name),
    tags: JSON.parse(String(row.tags_json)) as string[], defaultDirectory: nullable(row.default_directory),
    enabled: Boolean(row.enabled), aiAccessEnabled: Boolean(row.ai_access_enabled), monitorOutputEnabled: Boolean(row.monitor_output_enabled), configRevision: Number(row.config_revision),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function mapCredential(row: Row): Credential {
  return {
    id: String(row.id), name: String(row.name), type: String(row.type) as CredentialType,
    secretRef: nullable(row.secret_ref), metadata: JSON.parse(String(row.metadata_json)) as Credential["metadata"],
    hasSecret: Boolean(row.secret_ref), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function mapPolicy(row: Row): Policy {
  return {
    id: String(row.id), name: String(row.name), version: Number(row.version),
    document: JSON.parse(String(row.policy_json)) as PolicyDocument, schemaVersion: 3, enabled: Boolean(row.enabled),
    sourcePath: nullable(row.source_path), sourceStatus: String(row.source_status) as PolicySourceStatus,
    sourceError: nullable(row.source_error), sourceHash: nullable(row.source_hash),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function mapAudit(row: Row): AuditLog {
  return {
    id: String(row.id), clientType: String(row.client_type), clientId: nullable(row.client_id), hostId: nullable(row.host_id),
    hostNameSnapshot: nullable(row.host_name_snapshot), operationType: String(row.operation_type), requestSummary: nullable(row.request_summary),
    policyId: nullable(row.policy_id), policyVersion: row.policy_version == null ? null : Number(row.policy_version),
    policyDecision: nullable(row.policy_decision) as PolicyDecision | null, decisionReasonCode: nullable(row.decision_reason_code),
    status: String(row.status) as OperationStatus, exitCode: row.exit_code == null ? null : Number(row.exit_code),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms), bytesTransferred: row.bytes_transferred == null ? null : Number(row.bytes_transferred),
    errorCode: nullable(row.error_code), errorMessage: nullable(row.error_message), createdAt: String(row.created_at), finishedAt: nullable(row.finished_at)
  };
}

function nullable(value: unknown): string | null { return value == null ? null : String(value); }

function validateRegexes(document: PolicyDocument): void {
  const patterns = document.commandBlacklist.map((rule) => rule.pattern);
  for (const pattern of patterns) {
    try { new RegExp(pattern, "u"); }
    catch { throw new AppError("INVALID_POLICY_REGEX", `Invalid regular expression: ${pattern}`); }
  }
}
