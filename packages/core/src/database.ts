import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AuditLog, Credential, CredentialType, Host, HostLogin, OperationStatus, Policy, PolicyDecision, PolicyDocument, PolicySourceStatus, SudoAuthMode } from "../../shared/src/index.js";
import { AppError, DEFAULT_POLICY_TEMPLATE, POLICY_TEMPLATES, policyDocumentSchema } from "../../shared/src/index.js";

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
    sudo_mode TEXT NOT NULL DEFAULT 'NONE',
    sudo_secret_ref TEXT,
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
    host_transfer_enabled INTEGER NOT NULL DEFAULT 0,
    monitor_output_enabled INTEGER NOT NULL DEFAULT 0,
    proxy_enabled INTEGER NOT NULL DEFAULT 0,
    proxy_local_host TEXT NOT NULL DEFAULT '127.0.0.1',
    proxy_local_port INTEGER NOT NULL DEFAULT 7890 CHECK(proxy_local_port BETWEEN 1 AND 65535),
    proxy_remote_port INTEGER NOT NULL DEFAULT 7890 CHECK(proxy_remote_port BETWEEN 1 AND 65535),
    jump_host_id TEXT REFERENCES hosts(id) ON DELETE RESTRICT,
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
const SUDO_AUTH_MIGRATION = 8;
const HOST_LOGINS_MIGRATION = 9;
const POLICY_V4_MIGRATION = 10;
const AUDIT_PEER_HOST_MIGRATION = 11;
const HOST_TRANSFER_ENABLED_MIGRATION = 12;
const HOST_PROXY_MIGRATION = 13;
const HOST_PROXY_ENDPOINT_MIGRATION = 14;
const HOST_JUMP_MIGRATION = 15;
export const POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING = "policy.v3TemplateConsolidationCleanup";
const LEGACY_READONLY_TEMPLATE_NAMES = new Set(["Docker 排障（只读）", "Kubernetes 排障（只读）"]);
const LEGACY_OPERATIONS_TEMPLATE_NAMES = new Set(["Docker 运维（受限）", "Kubernetes 应用运维（受限）"]);

type CreateHostInput = Omit<Host, "id" | "createdAt" | "updatedAt" | "configRevision" | "status" | "proxyState" | "monitorOutputEnabled" | "hostTransferEnabled" | "proxyEnabled" | "proxyLocalHost" | "proxyLocalPort" | "proxyRemotePort" | "activeLoginId" | "jumpHostId"> & {
  monitorOutputEnabled?: boolean;
  hostTransferEnabled?: boolean;
  proxyEnabled?: boolean;
  proxyLocalHost?: string;
  proxyLocalPort?: number;
  proxyRemotePort?: number;
  jumpHostId?: string | null;
  activeLoginId?: string | null;
  sudoEnabled?: boolean;
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

    if (missingColumns.length > 0 || this.hasPreV3PolicyDocuments()) resetToV2 = true;

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
    this.db.exec(`CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('PASSWORD', 'PRIVATE_KEY', 'SSH_AGENT')),
      secret_ref TEXT, sudo_mode TEXT NOT NULL DEFAULT 'NONE', sudo_secret_ref TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const credentialColumns = new Set((this.db.prepare("PRAGMA table_info(credentials)").all() as Row[]).map((row) => String(row.name)));
    if (!credentialColumns.has("sudo_mode") || !credentialColumns.has("sudo_secret_ref") || !applied.has(SUDO_AUTH_MIGRATION)) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!credentialColumns.has("sudo_mode")) this.db.exec("ALTER TABLE credentials ADD COLUMN sudo_mode TEXT NOT NULL DEFAULT 'NONE'");
        if (!credentialColumns.has("sudo_secret_ref")) this.db.exec("ALTER TABLE credentials ADD COLUMN sudo_secret_ref TEXT");
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(SUDO_AUTH_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const hostColumnsAfterSudo = new Set((this.db.prepare("PRAGMA table_info(hosts)").all() as Row[]).map((row) => String(row.name)));
    if (!hostColumnsAfterSudo.has("active_login_id") || !applied.has(HOST_LOGINS_MIGRATION)) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!hostColumnsAfterSudo.has("active_login_id")) this.db.exec("ALTER TABLE hosts ADD COLUMN active_login_id TEXT");
        this.db.exec(`CREATE TABLE IF NOT EXISTS host_logins (
          id TEXT PRIMARY KEY,
          host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
          username TEXT NOT NULL,
          credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
          sudo_enabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(host_id, username)
        );
        CREATE INDEX IF NOT EXISTS idx_host_logins_host ON host_logins(host_id);`);
        const hosts = this.db.prepare("SELECT id,username,credential_id,active_login_id FROM hosts").all() as Row[];
        for (const host of hosts) {
          if (host.active_login_id) continue;
          const id = randomUUID();
          const timestamp = now();
          this.db.prepare("INSERT INTO host_logins(id,host_id,username,credential_id,sudo_enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)")
            .run(id, String(host.id), String(host.username), host.credential_id as SQLInputValue, timestamp, timestamp);
          this.db.prepare("UPDATE hosts SET active_login_id=? WHERE id=?").run(id, String(host.id));
        }
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(HOST_LOGINS_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!applied.has(POLICY_V4_MIGRATION) || this.hasPolicyV3Documents()) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const rows = this.db.prepare("SELECT id,policy_json FROM policies").all() as Row[];
        for (const row of rows) {
          let raw: { schemaVersion?: unknown };
          try { raw = JSON.parse(String(row.policy_json)) as { schemaVersion?: unknown }; }
          catch { continue; } // Leave corrupted rows alone; reads degrade them to fail-closed documents.
          if (raw.schemaVersion !== 3) continue;
          const upgraded = policyDocumentSchema.parse(raw);
          this.db.prepare("UPDATE policies SET policy_json=?,schema_version=4,version=version+1,updated_at=? WHERE id=?")
            .run(JSON.stringify(upgraded), now(), String(row.id));
        }
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(POLICY_V4_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    this.db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, client_type TEXT NOT NULL, client_id TEXT,
      host_id TEXT, host_name_snapshot TEXT, peer_host_id TEXT, peer_host_name_snapshot TEXT,
      operation_type TEXT NOT NULL, request_summary TEXT,
      policy_id TEXT, policy_version INTEGER, peer_policy_id TEXT, peer_policy_version INTEGER,
      policy_decision TEXT, decision_reason_code TEXT, status TEXT NOT NULL,
      exit_code INTEGER, duration_ms INTEGER, bytes_transferred INTEGER,
      error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_host_created ON audit_logs(host_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_status_created ON audit_logs(status, created_at DESC);`);
    const auditColumns = new Set((this.db.prepare("PRAGMA table_info(audit_logs)").all() as Row[]).map((row) => String(row.name)));
    if (!applied.has(AUDIT_PEER_HOST_MIGRATION) || ["peer_host_id", "peer_host_name_snapshot", "peer_policy_id", "peer_policy_version"].some((column) => !auditColumns.has(column))) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!auditColumns.has("peer_host_id")) this.db.exec("ALTER TABLE audit_logs ADD COLUMN peer_host_id TEXT");
        if (!auditColumns.has("peer_host_name_snapshot")) this.db.exec("ALTER TABLE audit_logs ADD COLUMN peer_host_name_snapshot TEXT");
        if (!auditColumns.has("peer_policy_id")) this.db.exec("ALTER TABLE audit_logs ADD COLUMN peer_policy_id TEXT");
        if (!auditColumns.has("peer_policy_version")) this.db.exec("ALTER TABLE audit_logs ADD COLUMN peer_policy_version INTEGER");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_audit_peer_host_created ON audit_logs(peer_host_id, created_at DESC)");
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(AUDIT_PEER_HOST_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const hostTransferColumns = new Set((this.db.prepare("PRAGMA table_info(hosts)").all() as Row[]).map((row) => String(row.name)));
    if (!applied.has(HOST_TRANSFER_ENABLED_MIGRATION) || !hostTransferColumns.has("host_transfer_enabled")) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!hostTransferColumns.has("host_transfer_enabled")) this.db.exec("ALTER TABLE hosts ADD COLUMN host_transfer_enabled INTEGER NOT NULL DEFAULT 0");
        const policies = this.db.prepare("SELECT id,policy_json FROM policies").all() as Row[];
        for (const policy of policies) {
          let raw: { files?: unknown };
          try { raw = JSON.parse(String(policy.policy_json)) as { files?: unknown }; }
          catch { continue; }
          if (typeof raw.files !== "object" || raw.files === null || Array.isArray(raw.files) || !("allowHostTransfer" in raw.files)) continue;
          const parsed = policyDocumentSchema.safeParse(raw);
          if (!parsed.success) continue;
          const normalized = parsed.data;
          const serialized = JSON.stringify(normalized);
          if (serialized !== JSON.stringify(raw)) this.db.prepare("UPDATE policies SET policy_json=?,updated_at=? WHERE id=?").run(serialized, now(), String(policy.id));
        }
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(HOST_TRANSFER_ENABLED_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const hostProxyColumns = new Set((this.db.prepare("PRAGMA table_info(hosts)").all() as Row[]).map((row) => String(row.name)));
    if (!applied.has(HOST_PROXY_MIGRATION) || ["proxy_enabled", "proxy_local_port", "proxy_remote_port"].some((column) => !hostProxyColumns.has(column))) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!hostProxyColumns.has("proxy_enabled")) this.db.exec("ALTER TABLE hosts ADD COLUMN proxy_enabled INTEGER NOT NULL DEFAULT 0");
        if (!hostProxyColumns.has("proxy_local_port")) this.db.exec("ALTER TABLE hosts ADD COLUMN proxy_local_port INTEGER NOT NULL DEFAULT 7890 CHECK(proxy_local_port BETWEEN 1 AND 65535)");
        if (!hostProxyColumns.has("proxy_remote_port")) this.db.exec("ALTER TABLE hosts ADD COLUMN proxy_remote_port INTEGER NOT NULL DEFAULT 7890 CHECK(proxy_remote_port BETWEEN 1 AND 65535)");
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(HOST_PROXY_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const hostProxyEndpointColumns = new Set((this.db.prepare("PRAGMA table_info(hosts)").all() as Row[]).map((row) => String(row.name)));
    if (!applied.has(HOST_PROXY_ENDPOINT_MIGRATION) || !hostProxyEndpointColumns.has("proxy_local_host")) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!hostProxyEndpointColumns.has("proxy_local_host")) this.db.exec("ALTER TABLE hosts ADD COLUMN proxy_local_host TEXT NOT NULL DEFAULT '127.0.0.1'");
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(HOST_PROXY_ENDPOINT_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const hostJumpColumns = new Set((this.db.prepare("PRAGMA table_info(hosts)").all() as Row[]).map((row) => String(row.name)));
    if (!applied.has(HOST_JUMP_MIGRATION) || !hostJumpColumns.has("jump_host_id")) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!hostJumpColumns.has("jump_host_id")) this.db.exec("ALTER TABLE hosts ADD COLUMN jump_host_id TEXT REFERENCES hosts(id) ON DELETE RESTRICT");
        this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(HOST_JUMP_MIGRATION, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return resetToV2;
  }

  private hasPreV3PolicyDocuments(): boolean {
    const rows = this.db.prepare("SELECT policy_json FROM policies").all() as Row[];
    return rows.some((row) => {
      let schemaVersion: unknown;
      try { schemaVersion = (JSON.parse(String(row.policy_json)) as { schemaVersion?: unknown }).schemaVersion; }
      catch { return false; } // Corrupted JSON is not legacy data; the row degrades to a fail-closed document instead of triggering the reset.
      // Legacy means "older than v3" (including documents without a schemaVersion);
      // documents from any newer schema (e.g. a future v5) must never trigger the destructive reset.
      return !(Number(schemaVersion) >= 3);
    });
  }

  private hasPolicyV3Documents(): boolean {
    const rows = this.db.prepare("SELECT policy_json FROM policies").all() as Row[];
    return rows.some((row) => {
      try { return (JSON.parse(String(row.policy_json)) as { schemaVersion?: unknown }).schemaVersion === 3; }
      catch { return false; }
    });
  }

  private seed(resetToV2: boolean): void {
    const consolidateTemplates = !this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(POLICY_TEMPLATE_CONSOLIDATION_MIGRATION);
    this.transaction(() => {
      if (resetToV2) {
        const legacyPaths = (this.db.prepare("SELECT name,source_path FROM policies").all() as Row[])
          .filter((row) => LEGACY_READONLY_TEMPLATE_NAMES.has(String(row.name)) || LEGACY_OPERATIONS_TEMPLATE_NAMES.has(String(row.name)))
          .flatMap((row) => row.source_path ? [String(row.source_path)] : []);
        if (legacyPaths.length > 0) this.setSetting(POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING, legacyPaths);
        // The reset replaces every policy, so keep a recoverable copy first —
        // schema_migrations policy_reset_backup always survives it.
        this.db.exec(`CREATE TABLE IF NOT EXISTS policy_reset_backup (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, source_path TEXT, policy_json TEXT NOT NULL,
          schema_version INTEGER, enabled INTEGER, backed_up_at TEXT NOT NULL)`);
        this.db.prepare(`INSERT OR REPLACE INTO policy_reset_backup
          (id,name,source_path,policy_json,schema_version,enabled,backed_up_at)
          SELECT id,name,source_path,policy_json,schema_version,enabled,? FROM policies`).run(now());
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
    this.assertValidJumpHost(id, input.jumpHostId ?? null);
    this.db.prepare(`INSERT INTO hosts
      (id,name,hostname,port,username,credential_id,active_login_id,jump_host_id,policy_id,group_name,tags_json,default_directory,enabled,ai_access_enabled,host_transfer_enabled,monitor_output_enabled,proxy_enabled,proxy_local_host,proxy_local_port,proxy_remote_port,config_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
      id, input.name, input.hostname, input.port, input.username, input.credentialId, input.jumpHostId ?? null, input.policyId,
      input.groupName, JSON.stringify(input.tags), input.defaultDirectory, bool(input.enabled), bool(input.aiAccessEnabled), bool(input.hostTransferEnabled ?? false), bool(input.monitorOutputEnabled ?? false),
      bool(input.proxyEnabled ?? false), input.proxyLocalHost ?? "127.0.0.1", input.proxyLocalPort ?? 7890, input.proxyRemotePort ?? 7890, timestamp, timestamp
    );
    const login = this.createHostLogin(id, input.username, input.credentialId, input.sudoEnabled ?? input.username === "root");
    this.db.prepare("UPDATE hosts SET active_login_id=? WHERE id=?").run(login.id, id);
    return this.requireHost(id);
  }

  updateHost(id: string, patch: Partial<Omit<Host, "id" | "createdAt" | "updatedAt" | "configRevision" | "status">>): Host {
    const current = this.requireHost(id);
    const next = { ...current, ...patch, id: current.id };
    this.assertValidJumpHost(id, next.jumpHostId);
    const connectionChanged = current.hostname !== next.hostname || current.port !== next.port || current.username !== next.username || current.credentialId !== next.credentialId || current.jumpHostId !== next.jumpHostId;
    this.db.prepare(`UPDATE hosts SET name=?,hostname=?,port=?,username=?,credential_id=?,active_login_id=?,jump_host_id=?,policy_id=?,group_name=?,tags_json=?,default_directory=?,enabled=?,ai_access_enabled=?,host_transfer_enabled=?,monitor_output_enabled=?,proxy_enabled=?,proxy_local_host=?,proxy_local_port=?,proxy_remote_port=?,config_revision=config_revision+?,updated_at=? WHERE id=?`).run(
      next.name, next.hostname, next.port, next.username, next.credentialId, next.activeLoginId, next.jumpHostId, next.policyId, next.groupName,
      JSON.stringify(next.tags), next.defaultDirectory, bool(next.enabled), bool(next.aiAccessEnabled), bool(next.hostTransferEnabled), bool(next.monitorOutputEnabled),
      bool(next.proxyEnabled), next.proxyLocalHost, next.proxyLocalPort, next.proxyRemotePort, connectionChanged ? 1 : 0, now(), id
    );
    if (current.activeLoginId && (current.username !== next.username || current.credentialId !== next.credentialId)) {
      this.db.prepare("UPDATE host_logins SET username=?,credential_id=?,updated_at=? WHERE id=?")
        .run(next.username, next.credentialId, now(), current.activeLoginId);
    }
    return this.requireHost(id);
  }

  deleteHost(id: string): void {
    this.assertHostDeletable(id);
    const result = this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
    if (result.changes === 0) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
  }

  assertHostDeletable(id: string): void {
    const dependents = this.db.prepare("SELECT id,name FROM hosts WHERE jump_host_id=? ORDER BY name").all(id) as Row[];
    if (dependents.length > 0) {
      throw new AppError("JUMP_HOST_IN_USE", "Host is still configured as a jump host", false, undefined, {
        dependentHosts: dependents.map((row) => ({ id: String(row.id), name: String(row.name) }))
      }, 409);
    }
  }

  private requireHost(id: string): Host {
    const host = this.getHost(id);
    if (!host) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    return host;
  }

  private assertValidJumpHost(hostId: string, jumpHostId: string | null): void {
    if (!jumpHostId) return;
    const visited = new Set<string>();
    let currentId: string | null = jumpHostId;
    while (currentId) {
      if (currentId === hostId || visited.has(currentId)) {
        throw new AppError("JUMP_HOST_CYCLE", "Jump host configuration contains a cycle", false, undefined, { hostId, jumpHostId }, 409);
      }
      visited.add(currentId);
      const current = this.getHost(currentId);
      if (!current) throw new AppError("JUMP_HOST_NOT_FOUND", "Configured jump host does not exist", false, undefined, { jumpHostId: currentId }, 409);
      currentId = current.jumpHostId;
    }
  }

  listHostLogins(hostId?: string): HostLogin[] {
    const rows = hostId
      ? this.db.prepare("SELECT l.*,h.active_login_id FROM host_logins l JOIN hosts h ON h.id=l.host_id WHERE l.host_id=? ORDER BY l.username").all(hostId)
      : this.db.prepare("SELECT l.*,h.active_login_id FROM host_logins l JOIN hosts h ON h.id=l.host_id ORDER BY l.host_id,l.username").all();
    return (rows as Row[]).map(mapHostLogin);
  }

  getHostLogin(id: string): HostLogin | null {
    const row = this.db.prepare("SELECT l.*,h.active_login_id FROM host_logins l JOIN hosts h ON h.id=l.host_id WHERE l.id=?").get(id) as Row | undefined;
    return row ? mapHostLogin(row) : null;
  }

  getActiveHostLogin(hostId: string): HostLogin | null {
    const host = this.getHost(hostId);
    return host?.activeLoginId ? this.getHostLogin(host.activeLoginId) : null;
  }

  createHostLogin(hostId: string, username: string, credentialId: string | null, sudoEnabled: boolean): HostLogin {
    this.requireHost(hostId);
    const id = randomUUID();
    const timestamp = now();
    try {
      this.db.prepare("INSERT INTO host_logins(id,host_id,username,credential_id,sudo_enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, hostId, username, credentialId, bool(sudoEnabled), timestamp, timestamp);
    } catch {
      throw new AppError("HOST_LOGIN_EXISTS", "A login with this username already exists on the host", false, undefined, undefined, 409);
    }
    return this.getHostLogin(id)!;
  }

  updateHostLogin(id: string, patch: { username?: string; credentialId?: string | null; sudoEnabled?: boolean }): HostLogin {
    const current = this.getHostLogin(id);
    if (!current) throw new AppError("HOST_LOGIN_NOT_FOUND", "Host login not found", false, undefined, undefined, 404);
    const next = { ...current, ...patch };
    try {
      this.db.prepare("UPDATE host_logins SET username=?,credential_id=?,sudo_enabled=?,updated_at=? WHERE id=?")
        .run(next.username, next.credentialId, bool(next.sudoEnabled), now(), id);
    } catch {
      throw new AppError("HOST_LOGIN_EXISTS", "A login with this username already exists on the host", false, undefined, undefined, 409);
    }
    if (current.active) {
      this.db.prepare("UPDATE hosts SET username=?,credential_id=?,config_revision=config_revision+1,updated_at=? WHERE id=?")
        .run(next.username, next.credentialId, now(), current.hostId);
    }
    return this.getHostLogin(id)!;
  }

  activateHostLogin(hostId: string, loginId: string): Host {
    const login = this.getHostLogin(loginId);
    if (!login || login.hostId !== hostId) throw new AppError("HOST_LOGIN_NOT_FOUND", "Host login not found", false, undefined, undefined, 404);
    this.db.prepare("UPDATE hosts SET active_login_id=?,username=?,credential_id=?,config_revision=config_revision+1,updated_at=? WHERE id=?")
      .run(login.id, login.username, login.credentialId, now(), hostId);
    return this.requireHost(hostId);
  }

  deleteHostLogin(hostId: string, loginId: string): HostLogin {
    const login = this.getHostLogin(loginId);
    if (!login || login.hostId !== hostId) throw new AppError("HOST_LOGIN_NOT_FOUND", "Host login not found", false, undefined, undefined, 404);
    if (login.active) throw new AppError("HOST_LOGIN_ACTIVE", "Switch to another login before deleting the active login", false, undefined, undefined, 409);
    const count = this.listHostLogins(hostId).length;
    if (count <= 1) throw new AppError("HOST_LOGIN_REQUIRED", "A host must keep at least one login", false, undefined, undefined, 409);
    this.db.prepare("DELETE FROM host_logins WHERE id=?").run(loginId);
    return login;
  }

  renameHostGroup(oldName: string, newName: string): number {
    const result = this.db.prepare("UPDATE hosts SET group_name=?,updated_at=? WHERE group_name=?").run(newName, now(), oldName);
    if (result.changes === 0) throw new AppError("HOST_GROUP_NOT_FOUND", "Host group not found", false, undefined, undefined, 404);
    return Number(result.changes);
  }

  hostOwnsCredential(hostId: string, credentialId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM host_logins WHERE host_id=? AND credential_id=?").get(hostId, credentialId));
  }

  listCredentials(): Credential[] {
    return (this.db.prepare("SELECT * FROM credentials ORDER BY name").all() as Row[]).map(mapCredential);
  }

  getCredential(id: string): Credential | null {
    const row = this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as Row | undefined;
    return row ? mapCredential(row) : null;
  }

  createCredential(name: string, type: CredentialType, secretRef: string | null, metadata: Credential["metadata"], sudoMode: SudoAuthMode = "NONE", sudoSecretRef: string | null = null): Credential {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare("INSERT INTO credentials(id,name,type,secret_ref,sudo_mode,sudo_secret_ref,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, name, type, secretRef, sudoMode, sudoSecretRef, JSON.stringify(metadata), timestamp, timestamp);
    return this.getCredential(id)!;
  }

  upsertImportedCredential(input: {
    id: string; name: string; type: CredentialType; secretRef: string | null; sudoMode: SudoAuthMode;
    sudoSecretRef: string | null; metadata: Credential["metadata"];
  }): Credential {
    if (this.getCredential(input.id)) {
      return this.updateCredential(input.id, input.name, input.type, input.secretRef, input.metadata, input.sudoMode, input.sudoSecretRef);
    }
    const timestamp = now();
    this.db.prepare("INSERT INTO credentials(id,name,type,secret_ref,sudo_mode,sudo_secret_ref,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(input.id, input.name, input.type, input.secretRef, input.sudoMode, input.sudoSecretRef, JSON.stringify(input.metadata), timestamp, timestamp);
    return this.getCredential(input.id)!;
  }

  upsertImportedHost(input: {
    id: string; name: string; hostname: string; port: number; username: string; credentialId: string | null;
    activeLoginId: string | null; jumpHostId: string | null; policyId: string | null; groupName: string | null;
    tags: string[]; defaultDirectory: string | null; enabled: boolean; aiAccessEnabled: boolean;
    hostTransferEnabled: boolean; monitorOutputEnabled: boolean; proxyEnabled: boolean;
    proxyLocalHost: string; proxyLocalPort: number; proxyRemotePort: number;
  }): "created" | "updated" {
    this.assertValidJumpHost(input.id, input.jumpHostId);
    const timestamp = now();
    if (this.getHost(input.id)) {
      this.db.prepare(`UPDATE hosts SET name=?,hostname=?,port=?,username=?,credential_id=?,active_login_id=?,jump_host_id=?,policy_id=?,group_name=?,tags_json=?,default_directory=?,enabled=?,ai_access_enabled=?,host_transfer_enabled=?,monitor_output_enabled=?,proxy_enabled=?,proxy_local_host=?,proxy_local_port=?,proxy_remote_port=?,config_revision=config_revision+1,updated_at=? WHERE id=?`).run(
        input.name, input.hostname, input.port, input.username, input.credentialId, input.activeLoginId, input.jumpHostId,
        input.policyId, input.groupName, JSON.stringify(input.tags), input.defaultDirectory, bool(input.enabled),
        bool(input.aiAccessEnabled), bool(input.hostTransferEnabled), bool(input.monitorOutputEnabled), bool(input.proxyEnabled),
        input.proxyLocalHost, input.proxyLocalPort, input.proxyRemotePort, timestamp, input.id
      );
      return "updated";
    }
    this.db.prepare(`INSERT INTO hosts
      (id,name,hostname,port,username,credential_id,active_login_id,jump_host_id,policy_id,group_name,tags_json,default_directory,enabled,ai_access_enabled,host_transfer_enabled,monitor_output_enabled,proxy_enabled,proxy_local_host,proxy_local_port,proxy_remote_port,config_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
      input.id, input.name, input.hostname, input.port, input.username, input.credentialId, input.activeLoginId, input.jumpHostId,
      input.policyId, input.groupName, JSON.stringify(input.tags), input.defaultDirectory, bool(input.enabled),
      bool(input.aiAccessEnabled), bool(input.hostTransferEnabled), bool(input.monitorOutputEnabled), bool(input.proxyEnabled),
      input.proxyLocalHost, input.proxyLocalPort, input.proxyRemotePort, timestamp, timestamp
    );
    return "created";
  }

  upsertImportedLogin(input: { id: string; hostId: string; username: string; credentialId: string | null; sudoEnabled: boolean }): { id: string; created: boolean } {
    this.requireHost(input.hostId);
    const timestamp = now();
    if (this.getHostLogin(input.id)) {
      this.updateHostLogin(input.id, { username: input.username, credentialId: input.credentialId, sudoEnabled: input.sudoEnabled });
      return { id: input.id, created: false };
    }
    const existing = this.listHostLogins(input.hostId).find((login) => login.username === input.username);
    if (existing) {
      this.updateHostLogin(existing.id, { credentialId: input.credentialId, sudoEnabled: input.sudoEnabled });
      return { id: existing.id, created: false };
    }
    this.db.prepare("INSERT INTO host_logins(id,host_id,username,credential_id,sudo_enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(input.id, input.hostId, input.username, input.credentialId, bool(input.sudoEnabled), timestamp, timestamp);
    return { id: input.id, created: true };
  }

  listTrustedHostKeys(): Array<{ hostId: string; algorithm: string; fingerprint: string }> {
    return (this.db.prepare("SELECT host_id,algorithm,fingerprint FROM host_keys WHERE status='TRUSTED' ORDER BY host_id").all() as Row[])
      .map((row) => ({ hostId: String(row.host_id), algorithm: String(row.algorithm), fingerprint: String(row.fingerprint) }));
  }

  importTrustedHostKey(hostId: string, fingerprint: string, algorithm = "sha256"): void {
    this.requireHost(hostId);
    const timestamp = now();
    this.db.prepare("UPDATE host_keys SET status='REVOKED' WHERE host_id=? AND status='TRUSTED' AND fingerprint!=?").run(hostId, fingerprint);
    this.db.prepare(`INSERT INTO host_keys(id,host_id,algorithm,fingerprint,status,first_seen_at,last_seen_at,trusted_at)
      VALUES (?,?,?,?,'TRUSTED',?,?,?)
      ON CONFLICT(host_id,fingerprint) DO UPDATE SET status='TRUSTED',algorithm=excluded.algorithm,last_seen_at=excluded.last_seen_at,trusted_at=excluded.trusted_at`)
      .run(randomUUID(), hostId, algorithm, fingerprint, timestamp, timestamp, timestamp);
  }

  updateCredential(id: string, name: string, type: CredentialType, secretRef: string | null, metadata: Credential["metadata"], sudoMode?: SudoAuthMode, sudoSecretRef?: string | null): Credential {
    const current = this.getCredential(id);
    if (!current) throw new AppError("CREDENTIAL_NOT_FOUND", "Credential not found", false, undefined, undefined, 404);
    const result = this.db.prepare("UPDATE credentials SET name=?,type=?,secret_ref=?,sudo_mode=?,sudo_secret_ref=?,metadata_json=?,updated_at=? WHERE id=?")
      .run(name, type, secretRef, sudoMode ?? current.sudoMode, sudoSecretRef === undefined ? current.sudoSecretRef : sudoSecretRef, JSON.stringify(metadata), now(), id);
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
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM host_logins WHERE credential_id = ?").get(id) as Row;
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
      VALUES (?,?,1,?,4,1,?,?,NULL,?,?,?)`)
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
    this.db.prepare(`UPDATE policies SET name=?,policy_json=?,version=version+1,schema_version=4,enabled=?,source_path=?,source_status=?,source_error=NULL,source_hash=?,updated_at=? WHERE id=?`)
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
    peerHostId?: string; peerHostNameSnapshot?: string;
    operationType: string; requestSummary?: string;
  }): void {
    this.db.prepare(`INSERT INTO audit_logs
      (id,client_type,client_id,host_id,host_name_snapshot,peer_host_id,peer_host_name_snapshot,operation_type,request_summary,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'RECEIVED',?)`).run(
      input.id, input.clientType, input.clientId ?? null, input.hostId ?? null, input.hostNameSnapshot ?? null,
      input.peerHostId ?? null, input.peerHostNameSnapshot ?? null, input.operationType, input.requestSummary ?? null, now()
    );
  }

  updateAudit(id: string, patch: {
    policyId?: string | null; policyVersion?: number | null; peerPolicyId?: string | null; peerPolicyVersion?: number | null;
    policyDecision?: PolicyDecision | null;
    decisionReasonCode?: string | null; status?: OperationStatus; exitCode?: number | null;
    durationMs?: number | null; bytesTransferred?: number | null; errorCode?: string | null; errorMessage?: string | null;
    finished?: boolean;
  }): void {
    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    const mapping: Record<string, string> = {
      policyId: "policy_id", policyVersion: "policy_version", peerPolicyId: "peer_policy_id", peerPolicyVersion: "peer_policy_version",
      policyDecision: "policy_decision",
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
    if (filters.hostId) { where.push("(host_id=? OR peer_host_id=?)"); values.push(filters.hostId, filters.hostId); }
    if (filters.status) { where.push("status=?"); values.push(filters.status); }
    // Coerce non-finite values (e.g. a caller passing Number("abc")) to the
    // defaults: node:sqlite rejects NaN bindings outright.
    const limit = Number.isFinite(filters.limit) ? Math.min(Math.max(Math.trunc(filters.limit as number), 1), 500) : 100;
    const offset = Number.isFinite(filters.offset) ? Math.max(Math.trunc(filters.offset as number), 0) : 0;
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
    credentialId: nullable(row.credential_id), activeLoginId: nullable(row.active_login_id), jumpHostId: nullable(row.jump_host_id), policyId: nullable(row.policy_id), groupName: nullable(row.group_name),
    tags: parseJsonColumn(row.tags_json, []), defaultDirectory: nullable(row.default_directory),
    enabled: Boolean(row.enabled), aiAccessEnabled: Boolean(row.ai_access_enabled), hostTransferEnabled: Boolean(row.host_transfer_enabled), monitorOutputEnabled: Boolean(row.monitor_output_enabled),
    proxyEnabled: Boolean(row.proxy_enabled), proxyLocalHost: String(row.proxy_local_host), proxyLocalPort: Number(row.proxy_local_port), proxyRemotePort: Number(row.proxy_remote_port), configRevision: Number(row.config_revision),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function mapHostLogin(row: Row): HostLogin {
  return {
    id: String(row.id), hostId: String(row.host_id), username: String(row.username),
    credentialId: nullable(row.credential_id), sudoEnabled: Boolean(row.sudo_enabled),
    active: String(row.id) === String(row.active_login_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function mapCredential(row: Row): Credential {
  return {
    id: String(row.id), name: String(row.name), type: String(row.type) as CredentialType,
    secretRef: nullable(row.secret_ref), sudoMode: String(row.sudo_mode ?? "NONE") as SudoAuthMode, sudoSecretRef: nullable(row.sudo_secret_ref),
    metadata: parseJsonColumn(row.metadata_json, {} as Credential["metadata"]),
    hasSecret: Boolean(row.secret_ref), hasSudoSecret: Boolean(row.sudo_secret_ref), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

/** Deny-everything placeholder for corrupted policy documents: a broken row must fail closed, not vanish or crash the list. */
const FAIL_CLOSED_POLICY_DOCUMENT: PolicyDocument = {
  schemaVersion: 4,
  commandBlacklist: [{ pattern: "[\\s\\S]*", description: "策略数据已损坏，所有命令均被拒绝" }],
  files: {
    allowUpload: false, allowDownload: false, allowOverwrite: false,
    maxUploadBytes: 0, maxDownloadBytes: 0,
    allowedLocalPaths: [], allowedRemoteUploadPaths: [], allowedRemoteDownloadPaths: []
  }
};

function mapPolicy(row: Row): Policy {
  let document: PolicyDocument;
  try { document = policyDocumentSchema.parse(JSON.parse(String(row.policy_json))); }
  catch { document = FAIL_CLOSED_POLICY_DOCUMENT; }
  return {
    id: String(row.id), name: String(row.name), version: Number(row.version),
    document, schemaVersion: 4, enabled: Boolean(row.enabled),
    sourcePath: nullable(row.source_path), sourceStatus: String(row.source_status) as PolicySourceStatus,
    sourceError: nullable(row.source_error), sourceHash: nullable(row.source_hash),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function mapAudit(row: Row): AuditLog {
  return {
    id: String(row.id), clientType: String(row.client_type), clientId: nullable(row.client_id), hostId: nullable(row.host_id),
    hostNameSnapshot: nullable(row.host_name_snapshot), peerHostId: nullable(row.peer_host_id), peerHostNameSnapshot: nullable(row.peer_host_name_snapshot),
    operationType: String(row.operation_type), requestSummary: nullable(row.request_summary),
    policyId: nullable(row.policy_id), policyVersion: row.policy_version == null ? null : Number(row.policy_version),
    peerPolicyId: nullable(row.peer_policy_id), peerPolicyVersion: row.peer_policy_version == null ? null : Number(row.peer_policy_version),
    policyDecision: nullable(row.policy_decision) as PolicyDecision | null, decisionReasonCode: nullable(row.decision_reason_code),
    status: String(row.status) as OperationStatus, exitCode: row.exit_code == null ? null : Number(row.exit_code),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms), bytesTransferred: row.bytes_transferred == null ? null : Number(row.bytes_transferred),
    errorCode: nullable(row.error_code), errorMessage: nullable(row.error_message), createdAt: String(row.created_at), finishedAt: nullable(row.finished_at)
  };
}

function nullable(value: unknown): string | null { return value == null ? null : String(value); }

/** Parses a JSON column with a fallback so one corrupted row cannot take down every listing API. */
function parseJsonColumn<T>(value: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(value)) as T;
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
    return parsed !== null && typeof parsed === typeof fallback ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function validateRegexes(document: PolicyDocument): void {
  const patterns = document.commandBlacklist.map((rule) => rule.pattern);
  for (const pattern of patterns) {
    try { new RegExp(pattern, "u"); }
    catch { throw new AppError("INVALID_POLICY_REGEX", `Invalid regular expression: ${pattern}`); }
  }
}
