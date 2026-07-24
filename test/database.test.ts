import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { HoplaneDatabase, POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING } from "../packages/core/src/database.js";
import { POLICY_TEMPLATES } from "../packages/shared/src/index.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

async function database() {
  const dir = await mkdtemp(join(tmpdir(), "hoplane-test-")); dirs.push(dir);
  return new HoplaneDatabase(join(dir, "test.sqlite3"));
}

describe("HoplaneDatabase", () => {
  it("seeds all built-in scenario policies", async () => {
    const db = await database();
    const policies = db.listPolicies();
    expect(policies.map((policy) => policy.name).sort()).toEqual(POLICY_TEMPLATES.map((template) => template.name).sort());
    const diagnostic = policies.find((policy) => policy.name === "错误追溯（推荐）")!;
    expect(diagnostic.document).toMatchObject({ schemaVersion: 3, files: { allowUpload: false, allowDownload: false } });
    expect(diagnostic.document.commandBlacklist.length).toBeGreaterThan(0);
    const fullAccess = policies.find((policy) => policy.name === "全权限（高风险）")!;
    expect(fullAccess.document).toMatchObject({ schemaVersion: 3, commandBlacklist: [], files: { allowUpload: true, allowDownload: true } });
    db.close();
  });
  it("merges legacy Docker and Kubernetes templates and rebinds their hosts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoplane-test-")); dirs.push(dir);
    const path = join(dir, "merge.sqlite3");
    const db = new HoplaneDatabase(path);
    const document = db.listPolicies()[0]!.document;
    const sourcePaths = [
      join(dir, "policies", "docker-readonly.yaml"),
      join(dir, "policies", "kubernetes-readonly.yaml"),
      join(dir, "policies", "docker-operations.yaml"),
      join(dir, "policies", "kubernetes-operations.yaml")
    ];
    const legacyPolicies = [
      db.createPolicy("Docker 排障（只读）", document, { sourcePath: sourcePaths[0] }),
      db.createPolicy("Kubernetes 排障（只读）", document, { sourcePath: sourcePaths[1] }),
      db.createPolicy("Docker 运维（受限）", document, { sourcePath: sourcePaths[2] }),
      db.createPolicy("Kubernetes 应用运维（受限）", document, { sourcePath: sourcePaths[3] })
    ];
    const hosts = legacyPolicies.map((policy, index) => db.createHost({
      name: `legacy-${index}`, hostname: "127.0.0.1", port: 22, username: "root", credentialId: null,
      policyId: policy.id, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: true
    }));
    db.close();

    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM schema_migrations WHERE version = 7").run();
    raw.close();

    const migrated = new HoplaneDatabase(path);
    expect(migrated.listPolicies().map((policy) => policy.name)).not.toEqual(expect.arrayContaining([
      "Docker 排障（只读）", "Kubernetes 排障（只读）", "Docker 运维（受限）", "Kubernetes 应用运维（受限）"
    ]));
    expect(hosts.slice(0, 2).map((host) => migrated.getHost(host.id)?.policyId)).toEqual([
      migrated.listPolicies().find((policy) => policy.name === "容器排障（只读）")!.id,
      migrated.listPolicies().find((policy) => policy.name === "容器排障（只读）")!.id
    ]);
    expect(hosts.slice(2).map((host) => migrated.getHost(host.id)?.policyId)).toEqual([
      migrated.listPolicies().find((policy) => policy.name === "容器运维（受限）")!.id,
      migrated.listPolicies().find((policy) => policy.name === "容器运维（受限）")!.id
    ]);
    expect(hosts.map((host) => migrated.getHost(host.id)?.configRevision)).toEqual(hosts.map((host) => host.configRevision + 1));
    expect(migrated.getSetting(POLICY_TEMPLATE_CONSOLIDATION_CLEANUP_SETTING, [])).toEqual(sourcePaths);
    migrated.close();
  });
  it("repairs a legacy database whose migration record is ahead of its policy table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoplane-test-")); dirs.push(dir);
    const path = join(dir, "legacy.sqlite3");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'old'), (2, 'old'), (3, 'old');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE policies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        policy_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE hosts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL, port INTEGER NOT NULL,
        username TEXT NOT NULL, credential_id TEXT, policy_id TEXT, group_name TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]', default_directory TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        ai_access_enabled INTEGER NOT NULL DEFAULT 0, config_revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO policies(id,name,policy_json,created_at,updated_at)
        VALUES ('legacy-policy','Legacy','{\"defaultDecision\":\"DENY\"}','old','old');
      INSERT INTO hosts(id,name,hostname,port,username,policy_id,created_at,updated_at)
        VALUES ('legacy-host','Legacy host','127.0.0.1',22,'root','legacy-policy','old','old');
    `);
    legacy.close();

    const db = new HoplaneDatabase(path);
    const policies = db.listPolicies();
    expect(policies).toHaveLength(POLICY_TEMPLATES.length);
    expect(policies.every((policy) => policy.schemaVersion === 3 && policy.document.schemaVersion === 3)).toBe(true);
    const host = db.getHost("legacy-host")!;
    expect(host.policyId).not.toBe("legacy-policy");
    expect(policies.find((policy) => policy.id === host.policyId)?.name).toBe("错误追溯（推荐）");
    const columns = db.db.prepare("PRAGMA table_info(policies)").all().map((row) => String((row as { name: unknown }).name));
    expect(columns).toEqual(expect.arrayContaining(["schema_version", "enabled", "source_path", "source_status", "source_error", "source_hash"]));
    const hostColumns = db.db.prepare("PRAGMA table_info(hosts)").all().map((row) => String((row as { name: unknown }).name));
    expect(hostColumns).toContain("monitor_output_enabled");
    const credentialColumns = db.db.prepare("PRAGMA table_info(credentials)").all().map((row) => String((row as { name: unknown }).name));
    expect(credentialColumns).toEqual(expect.arrayContaining(["sudo_mode", "sudo_secret_ref"]));
    db.close();
  });
  it("does not rotate connection revision for label-only changes", async () => {
    const db = await database();
    const policy = db.listPolicies()[0]!;
    const host = db.createHost({ name: "dev", hostname: "127.0.0.1", port: 22, username: "dev", credentialId: null, policyId: policy.id, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: false });
    const renamed = db.updateHost(host.id, { name: "development" });
    expect(renamed.configRevision).toBe(host.configRevision);
    const moved = db.updateHost(host.id, { port: 2222 });
    expect(moved.configRevision).toBe(host.configRevision + 1);
    db.close();
  });
  it("requires a host key to be observed before trust", async () => {
    const db = await database(); const policy = db.listPolicies()[0]!;
    const host = db.createHost({ name: "dev", hostname: "host", port: 22, username: "dev", credentialId: null, policyId: policy.id, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: false });
    db.observeHostKey(host.id, "abc123456789"); db.trustHostKey(host.id, "abc123456789");
    expect(db.getTrustedHostKey(host.id)).toBe("abc123456789"); db.close();
  });
  it("creates a new policy with version one", async () => {
    const db = await database();
    const template = db.listPolicies()[0]!.document;
    const created = db.createPolicy("Production read-only", { ...template, commandBlacklist: [{ pattern: "^rm(?:\\s|$)" }] });
    expect(created).toMatchObject({ name: "Production read-only", version: 1 });
    expect(db.listPolicies()).toHaveLength(POLICY_TEMPLATES.length + 1);
    db.close();
  });
  it("persists typed application settings", async () => {
    const db = await database();
    expect(db.getSetting("mcp.enabled", false)).toBe(false);
    db.setSetting("mcp.enabled", true);
    db.setSetting("ui.preferences", { compact: true });
    expect(db.getSetting("mcp.enabled", false)).toBe(true);
    expect(db.getSetting("ui.preferences", { compact: false })).toEqual({ compact: true });
    db.close();
  });
  it("tracks host-owned credential usage", async () => {
    const db = await database();
    const exclusive = db.createCredential("dev login", "PASSWORD", "secret-ref", {}, "CUSTOM_PASSWORD", "sudo-ref");
    expect(exclusive).toMatchObject({ sudoMode: "CUSTOM_PASSWORD", sudoSecretRef: "sudo-ref", hasSudoSecret: true });

    const host = db.createHost({
      name: "dev", hostname: "host", port: 22, username: "dev", credentialId: exclusive.id,
      policyId: db.listPolicies()[0]!.id, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: false
    });
    expect(db.credentialUsageCount(exclusive.id)).toBe(1);
    expect(() => db.deleteCredential(exclusive.id)).toThrowError(/assigned to a host/u);
    db.deleteHost(host.id);
    expect(db.credentialUsageCount(exclusive.id)).toBe(0);
    expect(db.deleteCredential(exclusive.id).id).toBe(exclusive.id);
    db.close();
  });
  it("manages multiple host logins, switches the active identity, and renames groups", async () => {
    const db = await database();
    const first = db.createCredential("root login", "PASSWORD", "root-secret", {});
    const host = db.createHost({
      name: "node", hostname: "host", port: 22, username: "root", credentialId: first.id,
      policyId: db.listPolicies()[0]!.id, groupName: "旧分组", tags: [], defaultDirectory: null,
      enabled: true, aiAccessEnabled: true
    });
    const initial = db.listHostLogins(host.id);
    expect(initial).toMatchObject([{ username: "root", credentialId: first.id, sudoEnabled: true, active: true }]);

    const secondCredential = db.createCredential("deploy login", "PASSWORD", "deploy-secret", {}, "LOGIN_PASSWORD");
    const deploy = db.createHostLogin(host.id, "deploy", secondCredential.id, false);
    expect(db.credentialUsageCount(secondCredential.id)).toBe(1);
    const switched = db.activateHostLogin(host.id, deploy.id);
    expect(switched).toMatchObject({ username: "deploy", credentialId: secondCredential.id, activeLoginId: deploy.id });
    expect(db.getActiveHostLogin(host.id)).toMatchObject({ username: "deploy", sudoEnabled: false, active: true });
    expect(() => db.deleteHostLogin(host.id, deploy.id)).toThrowError(/active login/u);

    expect(db.renameHostGroup("旧分组", "生产节点")).toBe(1);
    expect(db.getHost(host.id)?.groupName).toBe("生产节点");
    db.close();
  });
});
