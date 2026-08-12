import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Credential, Host } from "../packages/shared/src/index.js";
import type { HoplaneDatabase } from "../packages/core/src/database.js";
import type { CredentialVault } from "../packages/core/src/vault.js";

vi.mock("ssh2", () => ({
  Client: class extends EventEmitter {
    connect(): void {
      queueMicrotask(() => {
        this.emit("error", new Error("All configured authentication methods failed"));
        queueMicrotask(() => {
          this.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
        });
      });
    }

    end(): void {}
  }
}));

const { SSHConnectionManager } = await import("../packages/ssh-core/src/connection-manager.js");

describe("SSH connection error lifecycle", () => {
  it("handles a connection reset emitted after the initial connection failure", async () => {
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
      name: "windows-host",
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
    const database = {
      getHost: (id: string) => id === host.id ? host : null,
      getCredential: (id: string) => id === credential.id ? credential : null,
      getTrustedHostKey: () => null,
      observeHostKey: () => undefined
    } as unknown as HoplaneDatabase;
    const vault = {
      resolve: async () => "incorrect-password"
    } as unknown as CredentialVault;
    const manager = new SSHConnectionManager(database, vault, 1024);

    await expect(manager.testConnection(host.id)).rejects.toMatchObject({ code: "SSH_AUTH_FAILED" });

    // Allow the simulated socket's follow-up ECONNRESET event to run. With a
    // once-only error listener, Vitest reports this as an unhandled exception.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
