import { createConnection as createTcpConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ssh2, { type Connection, type Server } from "ssh2";
import { SSHConnectionManager } from "../packages/ssh-core/src/connection-manager.js";
import { MemoryVault } from "../packages/core/src/vault.js";
import type { HoplaneDatabase } from "../packages/core/src/database.js";
import type { Credential, Host } from "../packages/shared/src/index.js";

const now = new Date().toISOString();

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function credential(id: string, secretRef: string): Credential {
  return {
    id, name: id, type: "PASSWORD", secretRef, sudoMode: "NONE", sudoSecretRef: null,
    metadata: {}, hasSecret: true, hasSudoSecret: false, createdAt: now, updatedAt: now
  };
}

function host(input: Pick<Host, "id" | "name" | "hostname" | "port" | "username" | "credentialId" | "jumpHostId">): Host {
  return {
    ...input,
    activeLoginId: null,
    policyId: null,
    groupName: null,
    tags: [],
    defaultDirectory: null,
    enabled: true,
    aiAccessEnabled: true,
    hostTransferEnabled: false,
    monitorOutputEnabled: false,
    proxyEnabled: false,
    proxyLocalHost: "127.0.0.1",
    proxyLocalPort: 7890,
    proxyRemotePort: 7890,
    configRevision: 1,
    createdAt: now,
    updatedAt: now
  };
}

describe("SSH jump host connection", () => {
  let targetServer: Server | undefined;
  let jumpServer: Server | undefined;
  let targetPort: number;
  let jumpPort: number;
  let forwardedConnections = 0;

  beforeAll(async () => {
    const targetKey = ssh2.utils.generateKeyPairSync("ed25519");
    targetServer = new ssh2.Server({ hostKeys: [targetKey.private] }, (client) => {
      client.on("error", () => undefined);
      client.on("authentication", (context) => context.method === "password" && context.password === "target-secret" ? context.accept() : context.reject(["password"]));
      client.on("ready", () => {
        client.on("session", (acceptSession) => {
          const session = acceptSession();
          session.on("exec", (acceptExec, _rejectExec, info) => {
            const channel = acceptExec();
            channel.write(`target:${info.command}\n`);
            channel.exit(0);
            channel.end();
          });
        });
      });
    });
    targetPort = await listen(targetServer);

    const jumpKey = ssh2.utils.generateKeyPairSync("ed25519");
    jumpServer = new ssh2.Server({ hostKeys: [jumpKey.private] }, (client: Connection) => {
      client.on("error", () => undefined);
      client.on("authentication", (context) => context.method === "password" && context.password === "jump-secret" ? context.accept() : context.reject(["password"]));
      client.on("ready", () => {
        client.on("tcpip", (accept, reject, info) => {
          const upstream = createTcpConnection({ host: info.destIP, port: info.destPort });
          upstream.once("connect", () => {
            forwardedConnections += 1;
            const channel = accept();
            channel.on("error", () => upstream.destroy());
            upstream.on("error", () => channel.destroy());
            channel.pipe(upstream).pipe(channel);
          });
          upstream.once("error", () => reject());
        });
      });
    });
    jumpPort = await listen(jumpServer);
  });

  afterAll(async () => {
    await Promise.all([jumpServer ? close(jumpServer) : Promise.resolve(), targetServer ? close(targetServer) : Promise.resolve()]);
  });

  it("authenticates both hosts and reaches the target through direct-tcpip forwarding", async () => {
    const jump = host({
      id: "11111111-1111-4111-8111-111111111111", name: "jump", hostname: "127.0.0.1", port: jumpPort,
      username: "jump-user", credentialId: "jump-credential", jumpHostId: null
    });
    const target = host({
      id: "22222222-2222-4222-8222-222222222222", name: "target", hostname: "127.0.0.1", port: targetPort,
      username: "target-user", credentialId: "target-credential", jumpHostId: jump.id
    });
    const credentials = new Map([
      ["jump-credential", credential("jump-credential", "jump-secret-ref")],
      ["target-credential", credential("target-credential", "target-secret-ref")]
    ]);
    const trustedKeys = new Map<string, string>();
    const hosts = new Map([[jump.id, jump], [target.id, target]]);
    const database = {
      getHost: (id: string) => hosts.get(id) ?? null,
      listHosts: () => [...hosts.values()],
      getCredential: (id: string) => credentials.get(id) ?? null,
      getTrustedHostKey: (id: string) => trustedKeys.get(id) ?? null,
      observeHostKey: (id: string, fingerprint: string) => trustedKeys.set(id, fingerprint)
    } as unknown as HoplaneDatabase;
    const vault = new MemoryVault();
    await vault.save("jump-secret-ref", "jump-secret");
    await vault.save("target-secret-ref", "target-secret");
    const manager = new SSHConnectionManager(database, vault, 64 * 1024);

    try {
      await expect(manager.execute(target.id, "whoami", { timeoutMs: 5_000 })).rejects.toMatchObject({ code: "SSH_HOST_KEY_UNTRUSTED", details: { hostId: jump.id } });
      await expect(manager.execute(target.id, "whoami", { timeoutMs: 5_000 })).rejects.toMatchObject({ code: "SSH_HOST_KEY_UNTRUSTED", details: { hostId: target.id } });
      await expect(manager.execute(target.id, "whoami", { timeoutMs: 5_000 })).resolves.toMatchObject({ stdout: "target:whoami\n", exitCode: 0 });
      expect(forwardedConnections).toBeGreaterThan(0);
      expect(manager.getStatus(jump.id)).toBe("CONNECTED");
      expect(manager.getStatus(target.id)).toBe("CONNECTED");
    } finally {
      await manager.closeAll();
    }
  }, 15_000);
});
