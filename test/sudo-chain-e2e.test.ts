import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ssh2 from "ssh2";
import { SSHConnectionManager } from "../packages/ssh-core/src/connection-manager.js";
import type { HoplaneDatabase } from "../packages/core/src/database.js";
import type { CredentialVault } from "../packages/core/src/vault.js";
import type { Credential, Host, HostLogin } from "../packages/shared/src/index.js";

const LOGIN_PASSWORD = "login-pass-secret";
const SUDO_PROMPT_PATTERN = /^sudo -S -p '([^']+)' (.*)$/u;

/**
 * Fake sshd that emulates real sudo on a no-TTY channel: every `sudo -S -p`
 * invocation writes its prompt to stderr, or stdout when `2>&1` is present,
 * and requires a fresh password line on stdin. Credentials never carry over
 * between invocations.
 */
function startFakeSshServer(): Promise<{ server: InstanceType<typeof ssh2.Server>; port: number }> {
  const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
    // The first TOFU attempt drops the connection mid-handshake; ignore it.
    client.on("error", () => {});
    client.on("authentication", (context) => {
      if (context.method === "password" && context.password === LOGIN_PASSWORD) context.accept();
      else if (context.method === "password") context.reject();
      else context.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          const channel = acceptExec();
          const pendingLines: string[] = [];
          const lineWaiters: Array<(line: string) => void> = [];
          let buffered = "";
          channel.on("data", (chunk: Buffer) => {
            buffered += chunk.toString("utf8");
            let newline = buffered.indexOf("\n");
            while (newline >= 0) {
              const line = buffered.slice(0, newline);
              buffered = buffered.slice(newline + 1);
              const waiter = lineWaiters.shift();
              if (waiter) waiter(line);
              else pendingLines.push(line);
              newline = buffered.indexOf("\n");
            }
          });
          const readStdinLine = () => new Promise<string>((resolve) => {
            const queued = pendingLines.shift();
            if (queued !== undefined) resolve(queued);
            else lineWaiters.push(resolve);
          });
          void (async () => {
            for (const segment of info.command.split("&&").map((part) => part.trim())) {
              const unwrapped = segment.replace(/^time(?:\s+-p)?\s+/u, "");
              const sudoMatch = unwrapped.match(SUDO_PROMPT_PATTERN);
              if (sudoMatch) {
                if (/(?:^|\s)2>&1(?:\s|$)/u.test(sudoMatch[2]!)) channel.write(sudoMatch[1]!);
                else channel.stderr.write(sudoMatch[1]!);
                const answer = await readStdinLine();
                if (answer !== LOGIN_PASSWORD) {
                  channel.stderr.write("sudo: incorrect password\n");
                  channel.exit(1);
                  channel.end();
                  return;
                }
                channel.write(`sudo-ran: ${sudoMatch[2]!}\n`);
              } else if (/^sudo(\s|$)/u.test(segment)) {
                channel.stderr.write("sudo: a terminal is required to read the password\n");
                channel.exit(1);
                channel.end();
                return;
              } else {
                channel.write(`ran: ${segment}\n`);
              }
            }
            channel.exit(0);
            channel.end();
          })();
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

function buildFixtures(port: number) {
  const now = new Date().toISOString();
  const host: Host = {
    id: "11111111-1111-4111-8111-111111111111", name: "fake", hostname: "127.0.0.1", port,
    username: "haot", credentialId: "cred-1", activeLoginId: "login-1", policyId: null,
    groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: true, hostTransferEnabled: false,
    monitorOutputEnabled: false, configRevision: 1, createdAt: now, updatedAt: now
  };
  const login: HostLogin = {
    id: "login-1", hostId: host.id, username: "haot", credentialId: "cred-1",
    sudoEnabled: true, active: true, createdAt: now, updatedAt: now
  };
  const credential: Credential = {
    id: "cred-1", name: "fake-cred", type: "PASSWORD", secretRef: "secret-1",
    sudoMode: "LOGIN_PASSWORD", sudoSecretRef: null, metadata: {},
    hasSecret: true, hasSudoSecret: false, createdAt: now, updatedAt: now
  };
  let trustedHostKey: string | null = null;
  const database = {
    getHost: (id: string) => (id === host.id ? host : null),
    getActiveHostLogin: (id: string) => (id === host.id ? login : null),
    getCredential: (id: string) => (id === credential.id ? credential : null),
    getTrustedHostKey: () => trustedHostKey,
    observeHostKey: (_hostId: string, fingerprint: string) => { trustedHostKey = fingerprint; }
  } as unknown as HoplaneDatabase;
  const vault = {
    resolve: async (ref: string) => {
      if (ref !== "secret-1") throw new Error(`unexpected secret ref ${ref}`);
      return LOGIN_PASSWORD;
    }
  } as unknown as CredentialVault;
  return { host, database, vault };
}

describe("chained sudo over a real SSH channel", () => {
  let sshd: { server: InstanceType<typeof ssh2.Server>; port: number };

  beforeAll(async () => { sshd = await startFakeSshServer(); });
  afterAll(() => { sshd.server.close(); });

  it("authenticates every sudo invocation in a chain and keeps prompts out of stderr", async () => {
    const { host, database, vault } = buildFixtures(sshd.port);
    const manager = new SSHConnectionManager(database, vault, 64 * 1024);
    // First attempt records the host key (TOFU), second attempt trusts it.
    await expect(manager.execute(host.id, "true", { timeoutMs: 5000 })).rejects.toMatchObject({ code: "SSH_HOST_KEY_UNTRUSTED" });

    const chained = await manager.execute(host.id, "sudo apt-get update && sudo apt-get install -y nginx && echo done", { timeoutMs: 5000 });
    expect(chained.exitCode).toBe(0);
    expect(chained.stdout).toBe("sudo-ran: apt-get update\nsudo-ran: apt-get install -y nginx\nran: echo done\n");
    expect(chained.stderr).toBe("");

    const midChain = await manager.execute(host.id, "cd /tmp && sudo whoami", { timeoutMs: 5000 });
    expect(midChain.exitCode).toBe(0);
    expect(midChain.stdout).toBe("ran: cd /tmp\nsudo-ran: whoami\n");
    expect(midChain.stderr).toBe("");

    const redirected = await manager.execute(host.id, "sudo whoami 2>&1", { timeoutMs: 5000 });
    expect(redirected.exitCode).toBe(0);
    expect(redirected.stdout).toBe("sudo-ran: whoami 2>&1\n");
    expect(redirected.stdout).not.toContain("HOPLANE_SUDO_");
    expect(redirected.stderr).toBe("");

    const timedAndRedirected = await manager.execute(host.id, "time -p sudo whoami 2>&1", { timeoutMs: 5000 });
    expect(timedAndRedirected.exitCode).toBe(0);
    expect(timedAndRedirected.stdout).toBe("sudo-ran: whoami 2>&1\n");
    expect(timedAndRedirected.stdout).not.toContain("HOPLANE_SUDO_");
    expect(timedAndRedirected.stderr).toBe("");

    await manager.disconnect(host.id);
  });
});
