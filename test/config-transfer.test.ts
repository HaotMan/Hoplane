import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCore } from "../packages/core/src/server.js";
import { ConfigTransferService } from "../packages/core/src/config-transfer.js";
import { HoplaneDatabase } from "../packages/core/src/database.js";
import { LocalCredentialVaultManager } from "../packages/core/src/vault-manager.js";
import { PolicySourceService } from "../packages/core/src/policy-source.js";
import type { CoreConfig } from "../packages/core/src/config.js";

const dirs: string[] = [];
const originalDataDir = process.env.HOPLANE_DATA_DIR;
const originalPort = process.env.HOPLANE_CORE_PORT;

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.HOPLANE_DATA_DIR; else process.env.HOPLANE_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.HOPLANE_CORE_PORT; else process.env.HOPLANE_CORE_PORT = originalPort;
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), "hoplane-config-transfer-"));
  dirs.push(dataDir);
  process.env.HOPLANE_DATA_DIR = dataDir;
  process.env.HOPLANE_CORE_PORT = String(await availablePort());
  const runtime = await startCore({ staticRoot: dataDir });
  const token = (await readFile(join(dataDir, "core.token"), "utf8")).trim();
  return { dataDir, runtime, token, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

describe("workspace config export/import", () => {
  it("exports an encrypted bundle and imports it onto a fresh machine", async () => {
    const privateKeyContent = "-----BEGIN OPENSSH PRIVATE KEY-----\nexported-key-material\n-----END OPENSSH PRIVATE KEY-----\n";
    let document: unknown;
    const source = await startRuntime();
    const privateKeyPath = join(source.dataDir, "id_test");
    await writeFile(privateKeyPath, privateKeyContent, { mode: 0o600 });
    try {
      expect((await fetch(`${source.runtime.url}/v1/vault/setup`, {
        method: "POST", headers: source.headers, body: JSON.stringify({ password: "correct horse battery staple" })
      })).status).toBe(200);

      const policies = await (await fetch(`${source.runtime.url}/v1/policies`, { headers: source.headers })).json() as Array<{ id: string; name: string }>;
      const policyId = policies.find((policy) => policy.name === "错误追溯（推荐）")!.id;
      const jump = await (await fetch(`${source.runtime.url}/v1/hosts`, {
        method: "POST", headers: source.headers, body: JSON.stringify({
          name: "bastion", hostname: "bastion.example.test", port: 22, username: "jump",
          policyId, groupName: "prod", tags: ["edge"], defaultDirectory: "/opt", enabled: true, aiAccessEnabled: true, hostTransferEnabled: true,
          credential: { mode: "INLINE", name: "bastion login", type: "PASSWORD", secret: "jump-password", sudoMode: "NONE", metadata: {} }
        })
      })).json() as { id: string };
      expect(jump.id).toBeTruthy();
      const createdApp = await fetch(`${source.runtime.url}/v1/hosts`, {
        method: "POST", headers: source.headers, body: JSON.stringify({
          name: "app", hostname: "app.example.test", port: 2222, username: "deploy",
          policyId, groupName: "prod", tags: ["api"], defaultDirectory: "/srv", enabled: true, aiAccessEnabled: false,
          jumpHostId: jump.id,
          credential: { mode: "INLINE", name: "app key", type: "PRIVATE_KEY", metadata: { privateKeyPath }, secret: "key-passphrase" }
        })
      });
      expect(createdApp.status).toBe(201);

      const exported = await fetch(`${source.runtime.url}/v1/config/export`, {
        method: "POST", headers: source.headers, body: JSON.stringify({ password: "transfer-password-1" })
      });
      expect(exported.status).toBe(200);
      const bundle = await exported.json() as { filename: string; document: { kind: string; cipher: { ciphertext: string } } };
      expect(bundle.filename).toMatch(/^hoplane-config-\d{4}-\d{2}-\d{2}\.hoplane$/u);
      expect(bundle.document.kind).toBe("hoplane-config");
      expect(JSON.stringify(bundle.document)).not.toContain("jump-password");
      expect(JSON.stringify(bundle.document)).not.toContain("exported-key-material");
      expect(JSON.stringify(bundle.document)).not.toContain("key-passphrase");
      document = bundle.document;
    } finally {
      await source.runtime.close();
    }

    const target = await startRuntime();
    try {
      expect((await fetch(`${target.runtime.url}/v1/vault/setup`, {
        method: "POST", headers: target.headers, body: JSON.stringify({ password: "another horse battery" })
      })).status).toBe(200);
      const wrongPassword = await fetch(`${target.runtime.url}/v1/config/import`, {
        method: "POST", headers: target.headers, body: JSON.stringify({ password: "wrong-password-xx", document })
      });
      expect(wrongPassword.status).toBe(403);
      expect(await wrongPassword.json()).toMatchObject({ code: "CONFIG_EXPORT_UNLOCK_FAILED" });

      const imported = await fetch(`${target.runtime.url}/v1/config/import`, {
        method: "POST", headers: target.headers, body: JSON.stringify({ password: "transfer-password-1", document })
      });
      expect(imported.status).toBe(200);
      const result = await imported.json() as { hosts: number; credentials: number; policies: number };
      expect(result.hosts).toBe(2);
      expect(result.credentials).toBeGreaterThanOrEqual(2);

      const hosts = await (await fetch(`${target.runtime.url}/v1/hosts`, { headers: target.headers })).json() as Array<{
        id: string; name: string; hostname: string; port: number; jumpHostId: string | null; groupName: string | null; tags: string[];
      }>;
      const bastion = hosts.find((host) => host.name === "bastion")!;
      const appHost = hosts.find((host) => host.name === "app")!;
      expect(bastion).toMatchObject({ hostname: "bastion.example.test", groupName: "prod", tags: ["edge"] });
      expect(appHost).toMatchObject({ hostname: "app.example.test", port: 2222, jumpHostId: bastion.id });

      const logins = await (await fetch(`${target.runtime.url}/v1/host-logins`, { headers: target.headers })).json() as Array<{ hostId: string; username: string }>;
      expect(logins).toEqual(expect.arrayContaining([
        expect.objectContaining({ hostId: bastion.id, username: "jump" }),
        expect.objectContaining({ hostId: appHost.id, username: "deploy" })
      ]));

      const reveal = await fetch(`${target.runtime.url}/v1/hosts/${bastion.id}/credential/reveal`, {
        method: "POST",
        headers: { origin: target.runtime.url, "content-type": "application/json" },
        body: JSON.stringify({ masterPassword: "another horse battery" })
      });
      expect(reveal.status).toBe(200);
      expect(await reveal.json()).toMatchObject({ secret: "jump-password" });

      const keyReveal = await fetch(`${target.runtime.url}/v1/hosts/${appHost.id}/credential/reveal`, {
        method: "POST",
        headers: { origin: target.runtime.url, "content-type": "application/json" },
        body: JSON.stringify({ masterPassword: "another horse battery" })
      });
      expect(keyReveal.status).toBe(200);
      expect(await keyReveal.json()).toMatchObject({ secret: "key-passphrase", privateKey: privateKeyContent });

      const again = await fetch(`${target.runtime.url}/v1/config/import`, {
        method: "POST", headers: target.headers, body: JSON.stringify({ password: "transfer-password-1", document })
      });
      expect(again.status).toBe(200);
      const hostsAfter = await (await fetch(`${target.runtime.url}/v1/hosts`, { headers: target.headers })).json() as unknown[];
      expect(hostsAfter).toHaveLength(hosts.length);
    } finally {
      await target.runtime.close();
    }
  });

  it("imports trusted host keys through the transfer service", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "hoplane-config-keys-src-"));
    const targetDir = await mkdtemp(join(tmpdir(), "hoplane-config-keys-dst-"));
    dirs.push(sourceDir, targetDir);
    const source = await workspace(sourceDir);
    const host = source.database.createHost({
      name: "db", hostname: "db.example.test", port: 22, username: "root", credentialId: null,
      policyId: source.database.listPolicies()[0]!.id, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: false
    });
    source.database.observeHostKey(host.id, "SHA256:abc123def456ghi789jkl");
    source.database.trustHostKey(host.id, "SHA256:abc123def456ghi789jkl");
    const exported = await source.transfer.exportBundle("export-password-ok");
    await source.policySources.close();
    source.database.close();

    const target = await workspace(targetDir);
    const result = await target.transfer.importBundle("export-password-ok", exported.document);
    expect(result.hostKeys).toBe(1);
    expect(target.database.getTrustedHostKey(host.id)).toBe("SHA256:abc123def456ghi789jkl");
    await target.policySources.close();
    target.database.close();
  });
});

async function workspace(dataDir: string) {
  const config: CoreConfig = {
    dataDir, databasePath: join(dataDir, "hoplane.sqlite3"), tokenPath: join(dataDir, "core.token"),
    pidPath: join(dataDir, "core.pid"), logPath: join(dataDir, "core.log"), vaultPath: join(dataDir, "vault.enc"),
    policyDir: join(dataDir, "policies"), host: "127.0.0.1", port: 21722, outputLimitBytes: 1024
  };
  const database = new HoplaneDatabase(config.databasePath);
  const policySources = new PolicySourceService(config, database, { watch: false });
  await policySources.initialize();
  const vault = new LocalCredentialVaultManager(config);
  await vault.setupLocal("correct horse battery staple");
  const transfer = new ConfigTransferService(config, database, vault, policySources, async (path) => readFile(path, "utf8"));
  return { config, database, policySources, transfer };
}
