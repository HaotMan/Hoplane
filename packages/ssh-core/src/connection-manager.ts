import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname, join } from "node:path/posix";
import { homedir } from "node:os";
import type { CommandResult, Host, HostStatus } from "../../shared/src/index.js";
import { AppError } from "../../shared/src/index.js";
import type { HoplaneDatabase } from "../../core/src/database.js";
import type { CredentialVault } from "../../core/src/vault.js";

interface ManagedConnection {
  client: Client;
  revision: number;
  lastUsedAt: number;
}

export class SSHConnectionManager {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly connecting = new Map<string, Promise<Client>>();
  private readonly statuses = new Map<string, HostStatus>();

  constructor(
    private readonly database: HoplaneDatabase,
    private readonly vault: CredentialVault,
    private readonly outputLimitBytes: number
  ) {}

  getStatus(hostId: string): HostStatus {
    return this.statuses.get(hostId) ?? "DISCONNECTED";
  }

  async testConnection(hostId: string): Promise<void> {
    const host = this.requireEnabledHost(hostId);
    await this.disconnect(hostId);
    const client = await this.createConnection(host);
    client.end();
    this.statuses.set(hostId, "DISCONNECTED");
  }

  async execute(hostId: string, command: string, options: {
    directory?: string;
    timeoutMs: number;
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
  }): Promise<Omit<CommandResult, "operationId" | "durationMs">> {
    const client = await this.getConnection(hostId);
    const fullCommand = options.directory ? `cd -- ${shellQuote(options.directory)} && ${command}` : command;
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let activeStream: { close(): void } | undefined;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        activeStream?.close();
        reject(new AppError("COMMAND_TIMEOUT", `Command exceeded ${options.timeoutMs} ms`, true));
      }, options.timeoutMs);

      client.exec(fullCommand, { pty: false }, (error, stream) => {
        if (error) {
          clearTimeout(timer);
          settled = true;
          reject(classifySshError(error));
          return;
        }
        activeStream = stream;
        stream.on("data", (chunk: Buffer) => {
          const remaining = Math.max(0, this.outputLimitBytes - stdout.length);
          if (remaining > 0) options.onStdout?.(chunk.subarray(0, remaining));
          const result = appendLimited(stdout, chunk, this.outputLimitBytes);
          stdout = result.value;
          stdoutTruncated ||= result.truncated;
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          const remaining = Math.max(0, this.outputLimitBytes - stderr.length);
          if (remaining > 0) options.onStderr?.(chunk.subarray(0, remaining));
          const result = appendLimited(stderr, chunk, this.outputLimitBytes);
          stderr = result.value;
          stderrTruncated ||= result.truncated;
        });
        stream.on("close", (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"),
            stdoutTruncated, stderrTruncated, exitCode: code
          });
        });
        stream.on("error", (streamError: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(classifySshError(streamError));
        });
      });
    });
  }

  async resolveRemotePath(hostId: string, path: string, forCreate: boolean): Promise<string> {
    const sftp = await this.getSftp(hostId);
    try {
      if (!forCreate) return await sftpRealpath(sftp, path);
      const parent = await sftpRealpath(sftp, dirname(path));
      return join(parent, basename(path));
    } finally {
      sftp.end();
    }
  }

  async upload(hostId: string, localPath: string, remotePath: string, allowOverwrite: boolean): Promise<number> {
    const sftp = await this.getSftp(hostId);
    try {
      if (!allowOverwrite && await sftpExists(sftp, remotePath)) {
        throw new AppError("REMOTE_FILE_EXISTS", "Remote destination already exists", false, undefined, undefined, 409);
      }
      await new Promise<void>((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) => error ? reject(classifySshError(error)) : resolve()));
      const info = await sftpStat(sftp, remotePath);
      return info.size;
    } finally {
      sftp.end();
    }
  }

  async getRemoteFileSize(hostId: string, remotePath: string): Promise<number> {
    const sftp = await this.getSftp(hostId);
    try { return (await sftpStat(sftp, remotePath)).size; }
    finally { sftp.end(); }
  }

  async download(hostId: string, remotePath: string, localPath: string, allowOverwrite: boolean): Promise<number> {
    const { access, rename, unlink } = await import("node:fs/promises");
    if (!allowOverwrite) {
      try {
        await access(localPath);
        throw new AppError("LOCAL_FILE_EXISTS", "Local destination already exists", false, undefined, undefined, 409);
      } catch (error) {
        if (error instanceof AppError) throw error;
      }
    }
    const sftp = await this.getSftp(hostId);
    const temporary = `${localPath}.hoplane-part-${process.pid}-${Date.now()}`;
    try {
      const size = (await sftpStat(sftp, remotePath)).size;
      await new Promise<void>((resolve, reject) => {
        const read = sftp.createReadStream(remotePath);
        const write = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
        read.on("error", reject);
        write.on("error", reject);
        write.on("finish", resolve);
        read.pipe(write);
      });
      await rename(temporary, localPath);
      return size;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw classifySshError(error);
    } finally {
      sftp.end();
    }
  }

  async disconnect(hostId: string): Promise<void> {
    const connection = this.connections.get(hostId);
    if (connection) {
      connection.client.end();
      this.connections.delete(hostId);
    }
    this.statuses.set(hostId, "DISCONNECTED");
  }

  async closeAll(): Promise<void> {
    for (const hostId of [...this.connections.keys()]) await this.disconnect(hostId);
  }

  private async getSftp(hostId: string): Promise<SFTPWrapper> {
    const client = await this.getConnection(hostId);
    return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(new AppError("SFTP_UNAVAILABLE", error.message, true)) : resolve(sftp)));
  }

  private async getConnection(hostId: string): Promise<Client> {
    const host = this.requireEnabledHost(hostId);
    const existing = this.connections.get(hostId);
    if (existing?.revision === host.configRevision) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }
    if (existing) await this.disconnect(hostId);
    const pending = this.connecting.get(hostId);
    if (pending) return pending;
    if (this.connections.size + this.connecting.size >= 20) {
      throw new AppError("CONNECTION_LIMIT_REACHED", "The maximum of 20 concurrent SSH connections has been reached", true, undefined, undefined, 429);
    }
    const promise = this.createConnection(host).finally(() => this.connecting.delete(hostId));
    this.connecting.set(hostId, promise);
    const client = await promise;
    this.connections.set(hostId, { client, revision: host.configRevision, lastUsedAt: Date.now() });
    return client;
  }

  private async createConnection(host: Host): Promise<Client> {
    this.statuses.set(host.id, "CONNECTING");
    const credential = host.credentialId ? this.database.getCredential(host.credentialId) : null;
    if (!credential) throw new AppError("CREDENTIAL_NOT_FOUND", "Host has no usable credential", false, undefined, undefined, 409);
    const trustedFingerprint = this.database.getTrustedHostKey(host.id);
    let observedFingerprint: string | undefined;
    const config: ConnectConfig = {
      host: host.hostname,
      port: host.port,
      username: host.username,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostHash: "sha256",
      hostVerifier: (fingerprint: string) => {
        observedFingerprint = String(fingerprint);
        if (trustedFingerprint === observedFingerprint) return true;
        this.database.observeHostKey(host.id, observedFingerprint);
        return false;
      }
    };
    if (credential.type === "PASSWORD") {
      if (!credential.secretRef) throw new AppError("CREDENTIAL_NOT_FOUND", "Password reference is missing");
      config.password = await this.vault.resolve(credential.secretRef);
    } else if (credential.type === "PRIVATE_KEY") {
      if (!credential.metadata.privateKeyPath) throw new AppError("CREDENTIAL_NOT_FOUND", "Private key path is missing");
      config.privateKey = await readFile(expandHome(credential.metadata.privateKeyPath));
      if (credential.secretRef) config.passphrase = await this.vault.resolve(credential.secretRef);
    } else {
      config.agent = credential.metadata.agentSocket ?? process.env.SSH_AUTH_SOCK;
      if (!config.agent) throw new AppError("CREDENTIAL_NOT_FOUND", "SSH Agent socket is unavailable");
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      client.once("ready", () => {
        this.statuses.set(host.id, "CONNECTED");
        resolve(client);
      });
      client.once("error", (error: Error & { level?: string }) => {
        if (observedFingerprint && observedFingerprint !== trustedFingerprint) {
          const changed = Boolean(trustedFingerprint);
          this.statuses.set(host.id, "HOST_KEY_BLOCKED");
          reject(new AppError(changed ? "SSH_HOST_KEY_CHANGED" : "SSH_HOST_KEY_UNTRUSTED", changed ? "SSH host key changed" : "SSH host key is not trusted yet", false, undefined, {
            observedFingerprint,
            ...(trustedFingerprint ? { trustedFingerprint } : {})
          }, 409));
          return;
        }
        const classified = classifySshError(error);
        this.statuses.set(host.id, classified.code === "SSH_AUTH_FAILED" ? "AUTH_FAILED" : "FAILED");
        reject(classified);
      });
      client.on("close", () => {
        this.connections.delete(host.id);
        if (this.statuses.get(host.id) === "CONNECTED") this.statuses.set(host.id, "DISCONNECTED");
      });
      client.connect(config);
    });
  }

  private requireEnabledHost(hostId: string): Host {
    const host = this.database.getHost(hostId);
    if (!host) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    if (!host.enabled) throw new AppError("HOST_DISABLED", "Host is disabled", false, undefined, undefined, 409);
    return host;
  }
}

function appendLimited(current: Buffer, chunk: Buffer, limit: number): { value: Buffer; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: true };
  const remaining = limit - current.length;
  if (chunk.length <= remaining) return { value: Buffer.concat([current, chunk]), truncated: false };
  return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function expandHome(path: string): string { return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path; }

function classifySshError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "SSH operation failed";
  if (/authentication|all configured authentication methods failed/i.test(message)) return new AppError("SSH_AUTH_FAILED", message, false, undefined, undefined, 401);
  if (/no such file/i.test(message)) return new AppError("FILE_NOT_FOUND", message, false, undefined, undefined, 404);
  return new AppError("SSH_CONNECTION_FAILED", message, true, undefined, undefined, 502);
}

function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => sftp.realpath(path, (error, resolved) => error ? reject(classifySshError(error)) : resolve(resolved)));
}

function sftpExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve, reject) => sftp.stat(path, (error) => {
    if (!error) resolve(true);
    else if ((error as NodeJS.ErrnoException).code === "ENOENT" || /no such file/i.test(error.message)) resolve(false);
    else reject(classifySshError(error));
  }));
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<{ size: number }> {
  return new Promise((resolve, reject) => sftp.stat(path, (error, stats) => error ? reject(classifySshError(error)) : resolve({ size: stats.size })));
}
