import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Credential, Host } from "../packages/shared/src/index.js";
import type { HoplaneDatabase } from "../packages/core/src/database.js";
import type { CredentialVault } from "../packages/core/src/vault.js";

const sshMock = vi.hoisted(() => ({ clients: [] as EventEmitter[] }));

vi.mock("ssh2", () => ({
  Client: class extends EventEmitter {
    constructor() {
      super();
      sshMock.clients.push(this);
    }

    connect(): void {}

    end(): void {}
  }
}));

const { SSHConnectionManager } = await import("../packages/ssh-core/src/connection-manager.js");

describe("SSH shutdown lifecycle", () => {
  it("does not access the database when a pending client closes after shutdown", async () => {
    sshMock.clients.length = 0;
    const now = new Date().toISOString();
    const credential: Credential = {
      id: "credential-1",
      name: "test credential",
      type: "PASSWORD",
      secretRef: "secret-1",
      sudoMode: "NONE",
      sudoSecretRef: null,
      metadata: {},
      hasSecret: true,
      hasSudoSecret: false,
      createdAt: now,
      updatedAt: now
    };
    const host: Host = {
      id: "host-1",
      name: "pending-host",
      hostname: "172.16.0.212",
      port: 22,
      username: "haoto",
      credentialId: credential.id,
      activeLoginId: null,
      jumpHostId: null,
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
    let databaseOpen = true;
    const database = {
      getHost: (id: string) => {
        if (!databaseOpen) throw new Error("database is not open");
        return id === host.id ? host : null;
      },
      listHosts: () => {
        if (!databaseOpen) throw new Error("database is not open");
        return [host];
      },
      getCredential: (id: string) => id === credential.id ? credential : null,
      getTrustedHostKey: () => null,
      observeHostKey: () => undefined
    } as unknown as HoplaneDatabase;
    const vault = {
      resolve: async () => "password"
    } as unknown as CredentialVault;
    const manager = new SSHConnectionManager(database, vault, 1024);
    const pending = (manager as unknown as {
      getConnection(hostId: string): Promise<EventEmitter>;
    }).getConnection(host.id);

    await vi.waitFor(() => expect(sshMock.clients).toHaveLength(1));
    const client = sshMock.clients[0]!;
    await manager.shutdown();
    databaseOpen = false;

    client.emit("ready");
    expect(() => client.emit("close")).not.toThrow();
    await expect(pending).rejects.toMatchObject({ code: "SSH_MANAGER_SHUTTING_DOWN" });
  });
});
