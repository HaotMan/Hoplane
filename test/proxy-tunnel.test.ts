import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import ssh2, { type ClientChannel, type Connection } from "ssh2";
import { SSHConnectionManager } from "../packages/ssh-core/src/connection-manager.js";
import { MemoryVault } from "../packages/core/src/vault.js";
import type { HoplaneDatabase } from "../packages/core/src/database.js";
import type { Credential, Host, HostLogin } from "../packages/shared/src/index.js";
import { AppError } from "../packages/shared/src/index.js";

const now = new Date().toISOString();

function proxyHost(overrides: Partial<Host> = {}): Host {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "proxy-host",
    hostname: "127.0.0.1",
    port: 22,
    username: "tester",
    credentialId: "credential-1",
    activeLoginId: "login-1",
    jumpHostId: null,
    policyId: null,
    groupName: null,
    tags: [],
    defaultDirectory: null,
    enabled: true,
    aiAccessEnabled: true,
    hostTransferEnabled: false,
    monitorOutputEnabled: false,
    proxyEnabled: true,
    proxyLocalHost: "127.0.0.1",
    proxyLocalPort: 7890,
    proxyRemotePort: 17890,
    configRevision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

class TestChannel extends Duplex {
  readonly stderr = new PassThrough();
  readonly input: Buffer[] = [];
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.input.push(Buffer.from(chunk));
    callback();
  }
  close(): void { this.destroy(); }
  setWindow(): void {}
}

describe("proxy command environment", () => {
  it("injects the remote SOCKS5 endpoint into managed commands", async () => {
    const host = proxyHost();
    const database = { getHost: () => host } as unknown as HoplaneDatabase;
    const manager = new SSHConnectionManager(database, {} as MemoryVault, 1024);
    const channel = new TestChannel();
    let executed = "";
    const client = {
      exec(command: string, _options: unknown, callback: (error: Error | undefined, stream: ClientChannel) => void) {
        executed = command;
        callback(undefined, channel as unknown as ClientChannel);
        setImmediate(() => {
          channel.push(Buffer.from("ok"));
          channel.push(null);
          channel.stderr.end();
          channel.emit("close", 0);
        });
      }
    };
    Object.defineProperty(manager, "ensureProxyAvailable", { value: vi.fn(async () => undefined) });
    Object.defineProperty(manager, "isProxyTunnelActive", { value: vi.fn(() => true) });
    Object.defineProperty(manager, "getConnection", { value: vi.fn(async () => client) });

    await expect(manager.execute(host.id, "printf ok", { directory: "/srv/app", timeoutMs: 1_000 })).resolves.toMatchObject({ stdout: "ok", exitCode: 0 });
    expect(executed).toBe("export ALL_PROXY='socks5h://127.0.0.1:17890'; export all_proxy=\"$ALL_PROXY\"; cd -- '/srv/app' && printf ok");
  });

  it("fails closed before opening an exec channel when the tunnel is unavailable", async () => {
    const host = proxyHost();
    const manager = new SSHConnectionManager({ getHost: () => host } as unknown as HoplaneDatabase, {} as MemoryVault, 1024);
    const getConnection = vi.fn();
    Object.defineProperty(manager, "ensureProxyAvailable", {
      value: vi.fn(async () => { throw new AppError("LOCAL_PROXY_UNAVAILABLE", "proxy down", true); })
    });
    Object.defineProperty(manager, "getConnection", { value: getConnection });

    await expect(manager.execute(host.id, "curl https://example.com", { timeoutMs: 1_000 })).rejects.toMatchObject({ code: "LOCAL_PROXY_UNAVAILABLE" });
    expect(getConnection).not.toHaveBeenCalled();
  });

  it("injects the proxy export before an interactive terminal accepts user input", async () => {
    const host = proxyHost();
    const login: HostLogin = { id: "login-1", hostId: host.id, username: host.username, credentialId: host.credentialId, sudoEnabled: false, active: true, createdAt: now, updatedAt: now };
    const credential: Credential = {
      id: "credential-1", name: "credential", type: "PASSWORD", secretRef: "secret-1", sudoMode: "NONE", sudoSecretRef: null,
      metadata: {}, hasSecret: true, hasSudoSecret: false, createdAt: now, updatedAt: now
    };
    const database = {
      getHost: () => host,
      getHostLogin: () => login,
      getCredential: () => credential
    } as unknown as HoplaneDatabase;
    const manager = new SSHConnectionManager(database, {} as MemoryVault, 1024);
    const channel = new TestChannel();
    const client = {
      shell: (_options: unknown, callback: (error: Error | undefined, stream: ClientChannel) => void) => callback(undefined, channel as unknown as ClientChannel),
      end: vi.fn()
    };
    Object.defineProperty(manager, "ensureProxyAvailable", { value: vi.fn(async () => undefined) });
    Object.defineProperty(manager, "establishClient", { value: vi.fn(async () => client) });

    const session = await manager.openShellSession(host.id, login.id, { cols: 80, rows: 24 });
    session.initialize();
    expect(Buffer.concat(channel.input).toString("utf8")).toBe("export ALL_PROXY='socks5h://127.0.0.1:17890'; export all_proxy=\"$ALL_PROXY\";\n");
    session.close();
  });
});

describe("SSH reverse proxy tunnel", () => {
  it("relays a remote forwarded channel to the configured local TCP port", async () => {
    const localProxy = createTcpServer((socket) => socket.pipe(socket));
    const localPort = await new Promise<number>((resolve, reject) => {
      localProxy.once("error", reject);
      localProxy.listen(0, "127.0.0.1", () => resolve((localProxy.address() as AddressInfo).port));
    });
    const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
    let serverConnection: Connection | null = null;
    const forwardingRequests: string[] = [];
    const sshServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on("error", () => undefined);
      client.on("authentication", (context) => context.method === "password" && context.password === "secret" ? context.accept() : context.reject(["password"]));
      client.on("ready", () => {
        serverConnection = client;
        client.on("request", (accept, reject, name, info) => {
          if (name === "tcpip-forward" || name === "cancel-tcpip-forward") {
            forwardingRequests.push(name);
            accept?.();
          }
          else reject?.();
          void info;
        });
      });
    });
    const sshPort = await new Promise<number>((resolve, reject) => {
      sshServer.once("error", reject);
      sshServer.listen(0, "127.0.0.1", () => resolve((sshServer.address() as AddressInfo).port));
    });

    const host = proxyHost({ port: sshPort, proxyLocalPort: localPort });
    const credential: Credential = {
      id: "credential-1", name: "credential", type: "PASSWORD", secretRef: "secret-1", sudoMode: "NONE", sudoSecretRef: null,
      metadata: {}, hasSecret: true, hasSudoSecret: false, createdAt: now, updatedAt: now
    };
    let trustedFingerprint: string | null = null;
    let observedFingerprint: string | null = null;
    const database = {
      getHost: () => host,
      listHosts: () => [host],
      getCredential: () => credential,
      getTrustedHostKey: () => trustedFingerprint,
      observeHostKey: (_hostId: string, fingerprint: string) => { observedFingerprint = fingerprint; }
    } as unknown as HoplaneDatabase;
    const vault = new MemoryVault();
    await vault.save("secret-1", "secret");
    const manager = new SSHConnectionManager(database, vault, 1024);

    try {
      await manager.reconcileProxy(host.id);
      expect(observedFingerprint).toBeTruthy();
      trustedFingerprint = observedFingerprint;
      await manager.reconcileProxy(host.id);
      expect(manager.getProxyState(host.id)).toEqual({ status: "ACTIVE" });
      expect(serverConnection).not.toBeNull();

      const response = await new Promise<string>((resolve, reject) => {
        serverConnection!.forwardOut("127.0.0.1", host.proxyRemotePort, "127.0.0.1", 40000, (error, channel) => {
          if (error) { reject(error); return; }
          channel.once("data", (chunk: Buffer) => { resolve(chunk.toString("utf8")); channel.end(); });
          channel.once("error", reject);
          channel.write("through-tunnel");
        });
      });
      expect(response).toBe("through-tunnel");
      host.proxyEnabled = false;
      await manager.reconcileProxy(host.id);
      expect(manager.getProxyState(host.id)).toEqual({ status: "DISABLED" });
      expect(forwardingRequests).toEqual(["tcpip-forward", "cancel-tcpip-forward"]);
    } finally {
      host.proxyEnabled = false;
      await manager.reconcileProxy(host.id);
      await manager.closeAll();
      await new Promise<void>((resolve) => sshServer.close(() => resolve()));
      await new Promise<void>((resolve) => localProxy.close(() => resolve()));
    }
  }, 15_000);
});
