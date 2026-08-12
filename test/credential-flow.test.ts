import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCore } from "../packages/core/src/server.js";

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

describe("host-owned credential flow", () => {
  it("creates credentials inside the host flow, protects reveal, and removes exclusive credentials with the host", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hoplane-credential-flow-"));
    dirs.push(dataDir);
    process.env.HOPLANE_DATA_DIR = dataDir;
    process.env.HOPLANE_CORE_PORT = String(await availablePort());
    const privateKeyPath = join(dataDir, "id_test");
    const privateKeyContent = "-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key-material\n-----END OPENSSH PRIVATE KEY-----\n";
    await writeFile(privateKeyPath, privateKeyContent, { mode: 0o600 });
    const runtime = await startCore({ staticRoot: dataDir });
    const token = (await readFile(join(dataDir, "core.token"), "utf8")).trim();
    const authorizedHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    try {
      const setup = await fetch(`${runtime.url}/v1/vault/setup`, {
        method: "POST", headers: authorizedHeaders, body: JSON.stringify({ password: "correct horse battery staple" })
      });
      expect(setup.status).toBe(200);

      const createdResponse = await fetch(`${runtime.url}/v1/hosts`, {
        method: "POST", headers: authorizedHeaders, body: JSON.stringify({
          name: "dev", hostname: "server.example.test", port: 22, username: "deploy",
          policyId: null, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: true, hostTransferEnabled: true,
          credential: { mode: "INLINE", name: "dev login", type: "PASSWORD", secret: "server-password", sudoMode: "CUSTOM_PASSWORD", sudoSecret: "sudo-password", metadata: {} }
        })
      });
      expect(createdResponse.status).toBe(201);
      const host = await createdResponse.json() as { id: string; credentialId: string; hostTransferEnabled: boolean };
      expect(host.hostTransferEnabled).toBe(true);

      const credentialsResponse = await fetch(`${runtime.url}/v1/credentials`, { headers: { authorization: `Bearer ${token}` } });
      const credentials = await credentialsResponse.json() as Array<Record<string, unknown>>;
      expect(credentials).toMatchObject([{ id: host.credentialId, hasSecret: true, sudoMode: "CUSTOM_PASSWORD", hasSudoSecret: true }]);
      expect(credentials[0]).not.toHaveProperty("secretRef");
      expect(credentials[0]).not.toHaveProperty("sudoSecretRef");
      expect(await readFile(join(dataDir, "vault.enc"), "utf8")).not.toContain("sudo-password");

      const aiHostsBeforeDisable = await fetch(`${runtime.url}/v1/hosts?aiOnly=true`, { headers: { authorization: `Bearer ${token}` } });
      expect(await aiHostsBeforeDisable.json()).toMatchObject([{ id: host.id, enabled: true, aiAccessEnabled: true, hostTransferEnabled: true }]);
      const disabled = await fetch(`${runtime.url}/v1/hosts/${host.id}`, {
        method: "PATCH", headers: authorizedHeaders, body: JSON.stringify({ enabled: false })
      });
      expect(disabled.status).toBe(200);
      const aiHostsAfterDisable = await fetch(`${runtime.url}/v1/hosts?aiOnly=true`, { headers: { authorization: `Bearer ${token}` } });
      expect(await aiHostsAfterDisable.json()).toEqual([]);
      const disabledMcpTest = await fetch(`${runtime.url}/v1/hosts/${host.id}/test`, {
        method: "POST", headers: authorizedHeaders, body: JSON.stringify({ clientType: "MCP", clientId: "test-agent" })
      });
      expect(disabledMcpTest.status).toBe(409);
      expect(await disabledMcpTest.json()).toMatchObject({ code: "HOST_DISABLED" });
      const disabledCommand = await fetch(`${runtime.url}/v1/operations/execute`, {
        method: "POST", headers: authorizedHeaders,
        body: JSON.stringify({ hostId: host.id, command: "uptime", clientType: "MCP", clientId: "test-agent" })
      });
      expect(disabledCommand.status).toBe(409);
      expect(await disabledCommand.json()).toMatchObject({ code: "HOST_DISABLED" });
      const reenabled = await fetch(`${runtime.url}/v1/hosts/${host.id}`, {
        method: "PATCH", headers: authorizedHeaders, body: JSON.stringify({ enabled: true })
      });
      expect(reenabled.status).toBe(200);

      const bearerReveal = await fetch(`${runtime.url}/v1/hosts/${host.id}/credential/reveal`, {
        method: "POST", headers: authorizedHeaders, body: JSON.stringify({ masterPassword: "correct horse battery staple" })
      });
      expect(bearerReveal.status).toBe(403);

      const uiReveal = await fetch(`${runtime.url}/v1/hosts/${host.id}/credential/reveal`, {
        method: "POST",
        headers: { origin: runtime.url, "content-type": "application/json" },
        body: JSON.stringify({ masterPassword: "correct horse battery staple" })
      });
      expect(uiReveal.status).toBe(200);
      expect(await uiReveal.json()).toMatchObject({ secret: "server-password", privateKey: null, expiresInSeconds: 30 });

      const keyHostResponse = await fetch(`${runtime.url}/v1/hosts`, {
        method: "POST", headers: authorizedHeaders, body: JSON.stringify({
          name: "key-host", hostname: "key.example.test", port: 22, username: "deploy",
          policyId: null, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: false,
          credential: { mode: "INLINE", name: "key-host login", type: "PRIVATE_KEY", secret: "key-passphrase", metadata: { privateKeyPath } }
        })
      });
      const keyHost = await keyHostResponse.json() as { id: string };
      const keyReveal = await fetch(`${runtime.url}/v1/hosts/${keyHost.id}/credential/reveal`, {
        method: "POST",
        headers: { origin: runtime.url, "content-type": "application/json" },
        body: JSON.stringify({ masterPassword: "correct horse battery staple" })
      });
      expect(keyReveal.status).toBe(200);
      expect(await keyReveal.json()).toMatchObject({ secret: "key-passphrase", privateKey: privateKeyContent });

      const initialLoginsResponse = await fetch(`${runtime.url}/v1/hosts/${host.id}/logins`, {
        headers: { authorization: `Bearer ${token}` }
      });
      const initialLogins = await initialLoginsResponse.json() as Array<{ id: string; username: string; active: boolean }>;
      expect(initialLogins).toMatchObject([{ username: "deploy", active: true }]);
      const backupLoginResponse = await fetch(`${runtime.url}/v1/hosts/${host.id}/logins`, {
        method: "POST", headers: authorizedHeaders, body: JSON.stringify({
          username: "observer", sudoEnabled: false,
          credential: { mode: "INLINE", name: "observer login", type: "PASSWORD", secret: "observer-password", sudoMode: "NONE", metadata: {} }
        })
      });
      expect(backupLoginResponse.status).toBe(201);
      const backupLogin = await backupLoginResponse.json() as { id: string };
      const backupReveal = await fetch(`${runtime.url}/v1/hosts/${host.id}/logins/${backupLogin.id}/credential/reveal`, {
        method: "POST",
        headers: { origin: runtime.url, "content-type": "application/json" },
        body: JSON.stringify({ masterPassword: "correct horse battery staple" })
      });
      expect(backupReveal.status).toBe(200);
      expect(await backupReveal.json()).toMatchObject({ secret: "observer-password", privateKey: null, expiresInSeconds: 30 });
      const wrongHostReveal = await fetch(`${runtime.url}/v1/hosts/${keyHost.id}/logins/${backupLogin.id}/credential/reveal`, {
        method: "POST",
        headers: { origin: runtime.url, "content-type": "application/json" },
        body: JSON.stringify({ masterPassword: "correct horse battery staple" })
      });
      expect(wrongHostReveal.status).toBe(404);
      expect(await wrongHostReveal.json()).toMatchObject({ code: "HOST_LOGIN_NOT_FOUND" });
      const activated = await fetch(`${runtime.url}/v1/hosts/${host.id}/logins/${backupLogin.id}/activate`, {
        method: "POST", headers: authorizedHeaders
      });
      expect(activated.status).toBe(200);
      expect(await activated.json()).toMatchObject({ username: "observer", activeLoginId: backupLogin.id });
      const allLogins = await fetch(`${runtime.url}/v1/host-logins`, { headers: { authorization: `Bearer ${token}` } });
      expect(await allLogins.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ hostId: host.id, username: "deploy", active: false }),
        expect.objectContaining({ hostId: host.id, username: "observer", sudoEnabled: false, active: true })
      ]));
      const policiesResponse = await fetch(`${runtime.url}/v1/policies`, { headers: { authorization: `Bearer ${token}` } });
      const policies = await policiesResponse.json() as Array<{ id: string; name: string }>;
      const fullAccessPolicy = policies.find((policy) => policy.name === "全权限（高风险）")!;
      const assigned = await fetch(`${runtime.url}/v1/hosts/${host.id}`, {
        method: "PATCH", headers: authorizedHeaders, body: JSON.stringify({ policyId: fullAccessPolicy.id })
      });
      expect(assigned.status).toBe(200);
      const blockedSudo = await fetch(`${runtime.url}/v1/operations/execute`, {
        method: "POST", headers: authorizedHeaders,
        body: JSON.stringify({ hostId: host.id, command: "sudo systemctl restart demo", clientType: "MCP", clientId: "test-agent" })
      });
      expect(blockedSudo.status).toBe(403);
      expect(await blockedSudo.json()).toMatchObject({ code: "SUDO_DISABLED", details: { username: "observer" } });

      const deleted = await fetch(`${runtime.url}/v1/hosts/${host.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      expect(deleted.status).toBe(200);
      const deletedKeyHost = await fetch(`${runtime.url}/v1/hosts/${keyHost.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      expect(deletedKeyHost.status).toBe(200);
      const afterDelete = await fetch(`${runtime.url}/v1/credentials`, { headers: { authorization: `Bearer ${token}` } });
      expect(await afterDelete.json()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });
});
