import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join } from "node:path/posix";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CommandResult, Credential, Host, HostStatus } from "../../shared/src/index.js";
import { AppError } from "../../shared/src/index.js";
import type { HoplaneDatabase } from "../../core/src/database.js";
import type { CredentialVault } from "../../core/src/vault.js";

interface ManagedConnection {
  client: Client;
  revision: number;
  lastUsedAt: number;
}

export interface ShellSession {
  username: string;
  stream: ClientChannel;
  setWindow(rows: number, cols: number): void;
  close(): void;
}

export interface RelayFileInput {
  sourceHostId: string;
  sourcePath: string;
  destinationHostId: string;
  destinationPath: string;
  expectedSize: number;
  allowOverwrite: boolean;
  operationId: string;
}

export interface RelayFileResult {
  bytesTransferred: number;
  transport: "SFTP" | "SSH_STREAM";
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
    const sudoPassword = findSudoInvocations(command).length > 0 ? await this.resolveSudoPassword(hostId) : null;
    const sudoExecution = prepareSudoExecution(command, sudoPassword !== null);
    const fullCommand = options.directory ? `cd -- ${shellQuote(options.directory)} && ${sudoExecution.command}` : sudoExecution.command;
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let activeStream: { close(): void } | undefined;
      const sudoPrompt = sudoExecution.promptMarker ? new SudoPromptFilter(sudoExecution.promptMarker) : null;
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
          const filtered = sudoPrompt?.push(chunk) ?? { visible: chunk, prompted: 0 };
          // stdin stays open so every sudo in a chained command can be answered.
          if (filtered.prompted > 0 && sudoPassword !== null) stream.write(`${sudoPassword}\n`.repeat(filtered.prompted));
          appendStderr(filtered.visible);
        });
        const appendStderr = (chunk: Buffer) => {
          if (chunk.length === 0) return;
          const remaining = Math.max(0, this.outputLimitBytes - stderr.length);
          if (remaining > 0) options.onStderr?.(chunk.subarray(0, remaining));
          const result = appendLimited(stderr, chunk, this.outputLimitBytes);
          stderr = result.value;
          stderrTruncated ||= result.truncated;
        };
        stream.on("close", (code: number | null) => {
          if (settled) return;
          if (sudoPrompt) appendStderr(sudoPrompt.flush());
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

  /**
   * Opens an interactive PTY shell on a dedicated connection for the human terminal.
   * The connection is independent from the AI connection pool: it may use any
   * configured login and its lifecycle is bound to the returned session.
   */
  async openShellSession(hostId: string, loginId: string, options: { cols: number; rows: number; term?: string }): Promise<ShellSession> {
    const host = this.requireEnabledHost(hostId);
    const login = this.database.getHostLogin(loginId);
    if (!login || login.hostId !== hostId) throw new AppError("HOST_LOGIN_NOT_FOUND", "The requested login does not belong to this host", false, undefined, undefined, 404);
    const credential = login.credentialId ? this.database.getCredential(login.credentialId) : null;
    if (!credential) throw new AppError("CREDENTIAL_NOT_FOUND", "The selected login has no usable credential", false, undefined, undefined, 409);
    const client = await this.establishClient(host, credential, login.username, false);
    return new Promise((resolve, reject) => {
      client.shell({ term: options.term ?? "xterm-256color", cols: options.cols, rows: options.rows }, (error, stream) => {
        if (error) {
          client.end();
          reject(classifySshError(error));
          return;
        }
        resolve({
          username: login.username,
          stream,
          setWindow: (rows, cols) => stream.setWindow(rows, cols, 0, 0),
          close: () => { stream.end(); client.end(); }
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

  async resolveRemotePathForRelay(hostId: string, path: string, forCreate: boolean): Promise<string> {
    try { return await this.resolveRemotePath(hostId, path, forCreate); }
    catch (error) {
      const sftpError = classifySshError(error);
      if (sftpError.code !== "SFTP_UNAVAILABLE") throw sftpError;
      try { return await this.resolveRemotePathViaSsh(hostId, path, forCreate); }
      catch (sshError) { throw combineTransportErrors(sftpError, sshError); }
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

  async getRemoteRegularFileInfo(hostId: string, remotePath: string): Promise<{ size: number }> {
    const sftp = await this.getSftp(hostId);
    try {
      const info = await sftpFullStat(sftp, remotePath);
      if (!info.isFile()) throw new AppError("SOURCE_NOT_REGULAR_FILE", "Source path is not a regular file", false, undefined, undefined, 409);
      return { size: info.size };
    } finally {
      sftp.end();
    }
  }

  async getRemoteRegularFileInfoForRelay(hostId: string, remotePath: string): Promise<{ size: number }> {
    try { return await this.getRemoteRegularFileInfo(hostId, remotePath); }
    catch (error) {
      const sftpError = classifySshError(error);
      if (sftpError.code !== "SFTP_UNAVAILABLE") throw sftpError;
      try { return await this.getRemoteRegularFileInfoViaSsh(hostId, remotePath); }
      catch (sshError) { throw combineTransportErrors(sftpError, sshError); }
    }
  }

  async relayFile(input: RelayFileInput): Promise<RelayFileResult> {
    try {
      return { bytesTransferred: await this.relayFileViaSftp(input), transport: "SFTP" };
    } catch (error) {
      const sftpError = classifySshError(error);
      if (sftpError.code !== "SFTP_UNAVAILABLE") throw sftpError;
      try {
        return { bytesTransferred: await this.relayFileViaSsh(input), transport: "SSH_STREAM" };
      } catch (sshError) {
        throw combineTransportErrors(sftpError, sshError);
      }
    }
  }

  private async relayFileViaSftp(input: RelayFileInput): Promise<number> {
    const sourceSftp = await this.getSftp(input.sourceHostId);
    let destinationSftp: SFTPWrapper | null = null;
    let temporaryPath: string | null = null;
    try {
      destinationSftp = await this.getSftp(input.destinationHostId);
      const sourceInfo = await sftpFullStat(sourceSftp, input.sourcePath);
      if (!sourceInfo.isFile()) throw new AppError("SOURCE_NOT_REGULAR_FILE", "Source path is not a regular file", false, undefined, undefined, 409);
      if (sourceInfo.size !== input.expectedSize) {
        throw new AppError("SOURCE_FILE_CHANGED", "Source file changed before transfer started", true, undefined, { expectedSize: input.expectedSize, actualSize: sourceInfo.size }, 409);
      }

      const existingDestination = await sftpLstatOptional(destinationSftp, input.destinationPath);
      if (existingDestination?.isSymbolicLink()) {
        throw new AppError("DESTINATION_SYMLINK_UNSAFE", "Destination path is a symbolic link", false, undefined, undefined, 409);
      }
      if (existingDestination && !existingDestination.isFile()) {
        throw new AppError("DESTINATION_NOT_REGULAR_FILE", "Destination path exists and is not a regular file", false, undefined, undefined, 409);
      }
      if (existingDestination && !input.allowOverwrite) {
        throw new AppError("REMOTE_FILE_EXISTS", "Remote destination already exists", false, undefined, undefined, 409);
      }

      temporaryPath = join(dirname(input.destinationPath), `.hoplane-part-${input.operationId}`);
      if (await sftpExists(destinationSftp, temporaryPath)) {
        throw new AppError("TRANSFER_TEMP_FILE_EXISTS", "Transfer temporary file already exists", false, undefined, undefined, 409);
      }

      let bytesTransferred = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesTransferred += chunk.length;
          callback(null, chunk);
        }
      });
      await pipeline(
        sourceSftp.createReadStream(input.sourcePath),
        counter,
        destinationSftp.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
      );

      const temporaryInfo = await sftpFullStat(destinationSftp, temporaryPath);
      if (!temporaryInfo.isFile() || bytesTransferred !== input.expectedSize || temporaryInfo.size !== input.expectedSize) {
        throw new AppError("TRANSFER_SIZE_MISMATCH", "Transferred file size does not match the source", true, undefined, {
          expectedSize: input.expectedSize, bytesTransferred, destinationSize: temporaryInfo.size
        }, 502);
      }

      if (existingDestination) await sftpAtomicReplace(destinationSftp, temporaryPath, input.destinationPath);
      else await sftpRename(destinationSftp, temporaryPath, input.destinationPath);
      temporaryPath = null;

      const finalInfo = await sftpFullStat(destinationSftp, input.destinationPath);
      if (!finalInfo.isFile() || finalInfo.size !== input.expectedSize) {
        throw new AppError("TRANSFER_SIZE_MISMATCH", "Final destination file size does not match the source", true, undefined, {
          expectedSize: input.expectedSize, destinationSize: finalInfo.size
        }, 502);
      }
      return bytesTransferred;
    } catch (error) {
      if (destinationSftp && temporaryPath) await sftpUnlinkIfExists(destinationSftp, temporaryPath);
      throw classifySshError(error);
    } finally {
      sourceSftp.end();
      destinationSftp?.end();
    }
  }

  private async resolveRemotePathViaSsh(hostId: string, path: string, forCreate: boolean): Promise<string> {
    assertSshStreamPath(path);
    const command = forCreate
      ? `parent=${shellQuote(dirname(path))}; name=${shellQuote(basename(path))}; cd -P "$parent" 2>/dev/null || exit 45; resolved=$(pwd -P) || exit 45; printf '%s/%s\\n' "$resolved" "$name"`
      : `command -v realpath >/dev/null 2>&1 || exit 127; realpath ${shellQuote(path)}`;
    const result = await this.runSshStreamCommand(hostId, command);
    if (result.exitCode === 127) throw sshStreamUnavailable("Required command `realpath` is unavailable");
    if (result.exitCode === 45) throw new AppError("DESTINATION_PARENT_UNAVAILABLE", "Destination parent directory does not exist or is not accessible", false, undefined, undefined, 409);
    if (result.exitCode !== 0) {
      throw new AppError("REMOTE_PATH_RESOLUTION_FAILED", visibleSshError(result.stderr, "Remote path could not be resolved"), false, undefined, { exitCode: result.exitCode }, 409);
    }
    const resolved = result.stdout.trimEnd();
    if (!resolved.startsWith("/") || /[\r\n]/u.test(resolved)) {
      throw new AppError("REMOTE_PATH_RESOLUTION_FAILED", "Remote path resolution returned an invalid absolute path", false, undefined, undefined, 409);
    }
    return resolved;
  }

  private async getRemoteRegularFileInfoViaSsh(hostId: string, remotePath: string): Promise<{ size: number }> {
    assertSshStreamPath(remotePath);
    const command = `command -v wc >/dev/null 2>&1 || exit 127; [ -f ${shellQuote(remotePath)} ] || exit 44; wc -c < ${shellQuote(remotePath)}`;
    const result = await this.runSshStreamCommand(hostId, command);
    if (result.exitCode === 127) throw sshStreamUnavailable("Required command `wc` is unavailable");
    if (result.exitCode === 44) throw new AppError("SOURCE_NOT_REGULAR_FILE", "Source path is not a regular file", false, undefined, undefined, 409);
    if (result.exitCode !== 0) {
      throw new AppError("SOURCE_FILE_PROBE_FAILED", visibleSshError(result.stderr, "Source file could not be inspected"), false, undefined, { exitCode: result.exitCode }, 409);
    }
    const text = result.stdout.trim();
    if (!/^\d+$/u.test(text)) throw new AppError("SOURCE_FILE_PROBE_FAILED", "Source file size response is invalid", false, undefined, undefined, 502);
    const size = Number(text);
    if (!Number.isSafeInteger(size)) throw new AppError("SOURCE_FILE_PROBE_FAILED", "Source file size exceeds the supported integer range", false, undefined, undefined, 413);
    return { size };
  }

  private async relayFileViaSsh(input: RelayFileInput): Promise<number> {
    assertSshStreamPath(input.sourcePath);
    assertSshStreamPath(input.destinationPath);
    const temporaryPath = join(dirname(input.destinationPath), `.hoplane-part-${input.operationId}`);
    const sourceCommand = `command -v cat >/dev/null 2>&1 || exit 127; cat ${shellQuote(input.sourcePath)}`;
    const requiredDestinationCommands = input.allowOverwrite ? "cat wc mv rm" : "cat wc ln rm";
    const destinationCommand = [
      `for command in ${requiredDestinationCommands}; do command -v "$command" >/dev/null 2>&1 || exit 127; done`,
      `tmp=${shellQuote(temporaryPath)}`,
      `dest=${shellQuote(input.destinationPath)}`,
      `if [ -e "$tmp" ] || [ -L "$tmp" ]; then exit 70; fi`,
      `trap 'rm -f "$tmp"' EXIT HUP INT TERM`,
      `if [ -L "$dest" ]; then exit 71; fi`,
      `if [ -e "$dest" ] && [ ! -f "$dest" ]; then exit 72; fi`,
      ...(!input.allowOverwrite ? [`if [ -e "$dest" ]; then exit 73; fi`] : []),
      `umask 077`,
      `set -C`,
      `cat > "$tmp" || exit 74`,
      `set +C`,
      `actual=$(wc -c < "$tmp") || exit 75`,
      `[ "$actual" -eq ${input.expectedSize} ] || exit 76`,
      input.allowOverwrite ? `mv -f "$tmp" "$dest" || exit 77` : `ln "$tmp" "$dest" || exit 78`,
      ...(!input.allowOverwrite ? [`rm -f "$tmp" || exit 79`] : []),
      `final=$(wc -c < "$dest") || exit 80`,
      `[ "$final" -eq ${input.expectedSize} ] || exit 80`,
      `trap - EXIT HUP INT TERM`
    ].join("; ");

    let sourceStream: ClientChannel | null = null;
    let destinationStream: ClientChannel | null = null;
    try {
      destinationStream = await this.openSshStreamChannel(input.destinationHostId, destinationCommand);
      const destinationCompletion = observeExecChannel(destinationStream, this.outputLimitBytes);
      destinationStream.on("data", () => undefined);
      sourceStream = await this.openSshStreamChannel(input.sourceHostId, sourceCommand);
      const sourceCompletion = observeExecChannel(sourceStream, this.outputLimitBytes);
      let bytesTransferred = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesTransferred += chunk.length;
          callback(null, chunk);
        }
      });
      let pipelineError: unknown;
      try { await pipeline(sourceStream, counter, destinationStream); }
      catch (error) {
        pipelineError = error;
        sourceStream.close();
        destinationStream.close();
      }
      const [sourceResult, destinationResult] = await Promise.allSettled([sourceCompletion, destinationCompletion]);
      if (sourceResult.status === "fulfilled" && sourceResult.value.exitCode === 127) throw sshStreamUnavailable("Required source command `cat` is unavailable");
      if (destinationResult.status === "fulfilled" && destinationResult.value.exitCode === 127) throw sshStreamUnavailable("Required destination file commands are unavailable");
      if (destinationResult.status === "fulfilled" && [70, 71, 72, 73].includes(destinationResult.value.exitCode ?? -1)) {
        throw mapSshDestinationExit(destinationResult.value);
      }
      if (sourceResult.status === "fulfilled" && sourceResult.value.exitCode !== 0) {
        throw new AppError("SSH_STREAM_SOURCE_FAILED", visibleSshError(sourceResult.value.stderr, "Source SSH stream failed"), true, undefined, { exitCode: sourceResult.value.exitCode }, 502);
      }
      if (destinationResult.status === "fulfilled" && destinationResult.value.exitCode !== 0) throw mapSshDestinationExit(destinationResult.value);
      if (sourceResult.status === "rejected") throw classifySshStreamError(sourceResult.reason);
      if (destinationResult.status === "rejected") throw classifySshStreamError(destinationResult.reason);
      if (pipelineError) throw classifySshStreamError(pipelineError);
      if (bytesTransferred !== input.expectedSize) {
        throw new AppError("TRANSFER_SIZE_MISMATCH", "Transferred file size does not match the source", true, undefined, { expectedSize: input.expectedSize, bytesTransferred }, 502);
      }
      return bytesTransferred;
    } catch (error) {
      sourceStream?.close();
      destinationStream?.close();
      throw classifySshStreamError(error);
    }
  }

  private async runSshStreamCommand(hostId: string, command: string): Promise<Omit<CommandResult, "operationId" | "durationMs">> {
    try { return await this.execute(hostId, command, { timeoutMs: 30_000 }); }
    catch (error) { throw classifySshStreamError(error); }
  }

  private async openSshStreamChannel(hostId: string, command: string): Promise<ClientChannel> {
    const client = await this.getConnection(hostId);
    return new Promise((resolve, reject) => client.exec(command, { pty: false }, (error, stream) => error ? reject(classifySshStreamError(error)) : resolve(stream)));
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
    return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(classifySftpOpenError(error)) : resolve(sftp)));
  }

  private async resolveSudoPassword(hostId: string): Promise<string | null> {
    const host = this.requireEnabledHost(hostId);
    const activeLogin = this.database.getActiveHostLogin(hostId);
    if (host.username !== "root" && activeLogin && !activeLogin.sudoEnabled) {
      throw new AppError("SUDO_DISABLED", `sudo is disabled for the active login "${host.username}"`, false, undefined, { username: host.username }, 403);
    }
    const credential = host.credentialId ? this.database.getCredential(host.credentialId) : null;
    if (!credential || credential.sudoMode === "NONE") return null;
    if (credential.sudoMode === "LOGIN_PASSWORD") {
      if (credential.type !== "PASSWORD" || !credential.secretRef) throw new AppError("SUDO_CREDENTIAL_NOT_CONFIGURED", "The configured login password is unavailable for sudo", false, undefined, undefined, 409);
      return this.vault.resolve(credential.secretRef);
    }
    if (!credential.sudoSecretRef) throw new AppError("SUDO_CREDENTIAL_NOT_CONFIGURED", "The configured sudo password is unavailable", false, undefined, undefined, 409);
    return this.vault.resolve(credential.sudoSecretRef);
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
    return this.establishClient(host, credential, host.username, true);
  }

  /** Connects a new ssh2 client. `trackStatus` ties the client to the pooled host status; shell sessions pass false. */
  private async establishClient(host: Host, credential: Credential, username: string, trackStatus: boolean): Promise<Client> {
    const trustedFingerprint = this.database.getTrustedHostKey(host.id);
    let observedFingerprint: string | undefined;
    const config: ConnectConfig = {
      host: host.hostname,
      port: host.port,
      username,
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
        if (trackStatus) this.statuses.set(host.id, "CONNECTED");
        resolve(client);
      });
      client.once("error", (error: Error & { level?: string }) => {
        if (observedFingerprint && observedFingerprint !== trustedFingerprint) {
          const changed = Boolean(trustedFingerprint);
          if (trackStatus) this.statuses.set(host.id, "HOST_KEY_BLOCKED");
          reject(new AppError(changed ? "SSH_HOST_KEY_CHANGED" : "SSH_HOST_KEY_UNTRUSTED", changed ? "SSH host key changed" : "SSH host key is not trusted yet", false, undefined, {
            observedFingerprint,
            ...(trustedFingerprint ? { trustedFingerprint } : {})
          }, 409));
          return;
        }
        const classified = classifySshError(error);
        if (trackStatus) this.statuses.set(host.id, classified.code === "SSH_AUTH_FAILED" ? "AUTH_FAILED" : "FAILED");
        reject(classified);
      });
      client.on("close", () => {
        if (!trackStatus) return;
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

interface ExecChannelResult {
  exitCode: number | null;
  stderr: string;
}

function observeExecChannel(stream: ClientChannel, limit: number): Promise<ExecChannelResult> {
  let stderr: Buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    stream.stderr.on("data", (chunk: Buffer) => { stderr = appendLimited(stderr, chunk, limit).value; });
    stream.once("close", (exitCode: number | null) => resolve({ exitCode, stderr: stderr.toString("utf8") }));
    stream.once("error", reject);
    stream.stderr.once("error", reject);
  });
}

function classifySftpOpenError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  if (/unable to start subsystem|subsystem request failed|sftp subsystem|unknown channel type|channel open failure.*(?:prohibited|unsupported|not supported)/iu.test(message)) {
    return new AppError("SFTP_UNAVAILABLE", "The SSH server does not provide an SFTP subsystem", false, undefined, { reason: message }, 409);
  }
  return classifySshError(error);
}

function classifySshStreamError(error: unknown): AppError {
  const appError = classifySshError(error);
  if (/unable to exec|exec request failed|unable to open channel|channel open failure.*(?:prohibited|unsupported|not supported)/iu.test(appError.message)) {
    return sshStreamUnavailable(appError.message);
  }
  return appError;
}

function sshStreamUnavailable(reason: string): AppError {
  return new AppError("SSH_STREAM_UNAVAILABLE", "The SSH server cannot provide the POSIX exec stream required for file transfer", false, undefined, { reason }, 409);
}

function combineTransportErrors(sftpError: AppError, sshError: unknown): AppError {
  const streamError = classifySshStreamError(sshError);
  if (streamError.code !== "SSH_STREAM_UNAVAILABLE") return streamError;
  return new AppError("FILE_TRANSFER_TRANSPORT_UNAVAILABLE", "Neither SFTP nor the SSH POSIX file stream is available on the required host", false, undefined, {
    sftpReason: String(sftpError.details?.reason ?? sftpError.message),
    sshReason: String(streamError.details?.reason ?? streamError.message)
  }, 409);
}

function assertSshStreamPath(path: string): void {
  if (/[\r\n\0]/u.test(path)) throw new AppError("SSH_STREAM_PATH_UNSUPPORTED", "SSH stream fallback does not support paths containing line breaks or NUL bytes", false, undefined, undefined, 409);
}

function visibleSshError(stderr: string, fallback: string): string {
  const message = stderr.trim();
  return message ? message.slice(0, 1000) : fallback;
}

function mapSshDestinationExit(result: ExecChannelResult): AppError {
  const message = visibleSshError(result.stderr, "Destination SSH stream failed");
  switch (result.exitCode) {
    case 70: return new AppError("TRANSFER_TEMP_FILE_EXISTS", "Transfer temporary file already exists", false, undefined, undefined, 409);
    case 71: return new AppError("DESTINATION_SYMLINK_UNSAFE", "Destination path is a symbolic link", false, undefined, undefined, 409);
    case 72: return new AppError("DESTINATION_NOT_REGULAR_FILE", "Destination path exists and is not a regular file", false, undefined, undefined, 409);
    case 73: return new AppError("REMOTE_FILE_EXISTS", "Remote destination already exists", false, undefined, undefined, 409);
    case 74: return new AppError("SSH_STREAM_DESTINATION_WRITE_FAILED", message, true, undefined, { exitCode: result.exitCode }, 502);
    case 75: return new AppError("DESTINATION_FILE_PROBE_FAILED", message, true, undefined, { exitCode: result.exitCode }, 502);
    case 76:
    case 80: return new AppError("TRANSFER_SIZE_MISMATCH", "Destination file size does not match the source", true, undefined, { exitCode: result.exitCode }, 502);
    case 77: return new AppError("DESTINATION_ATOMIC_REPLACE_UNSUPPORTED", "Destination server cannot safely replace the existing file", false, undefined, undefined, 409);
    case 78: return new AppError("DESTINATION_ATOMIC_PUBLISH_UNSUPPORTED", "Destination filesystem cannot atomically publish a new file", false, undefined, undefined, 409);
    case 79: return new AppError("TRANSFER_TEMP_CLEANUP_FAILED", "Destination file was published but its temporary hard link could not be removed", true, undefined, undefined, 502);
    default: return new AppError("SSH_STREAM_DESTINATION_FAILED", message, true, undefined, { exitCode: result.exitCode }, 502);
  }
}

export interface PreparedSudoExecution {
  command: string;
  promptMarker?: string;
}

const COMMAND_SEPARATORS = new Set([";", "&", "|", "(", "{", "`", "\n"]);

/**
 * Finds the offset of every `sudo` that starts a shell command: at the beginning
 * of the string or right after a separator (`;`, `&&`, `||`, `|`, `(`, `` ` ``,
 * `{`, newline). Text inside single/double quotes is skipped, so e.g.
 * `echo "a && sudo b"` is not treated as a sudo invocation. sudo credentials do
 * not carry across invocations on a non-interactive SSH channel (no TTY means no
 * usable timestamp cache), so every invocation needs its own authentication.
 */
export function findSudoInvocations(command: string): number[] {
  const offsets: number[] = [];
  let atCommandStart = true;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "\\") { index += 1; atCommandStart = false; continue; }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      index = end < 0 ? command.length : end;
      atCommandStart = false;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < command.length && command[index] !== '"') { if (command[index] === "\\") index += 1; index += 1; }
      atCommandStart = false;
      continue;
    }
    if (COMMAND_SEPARATORS.has(char)) { atCommandStart = true; continue; }
    if (/\s/u.test(char)) continue;
    if (atCommandStart && command.startsWith("sudo", index) && (index + 4 === command.length || /\s/u.test(command[index + 4]!))) {
      offsets.push(index);
      index += 3;
    }
    atCommandStart = false;
  }
  return offsets;
}

/** Adds non-interactive sudo authentication without ever placing a password in the command. */
export function prepareSudoExecution(command: string, hasManagedPassword: boolean, marker = `HOPLANE_SUDO_${randomUUID()}_`): PreparedSudoExecution {
  const invocations = findSudoInvocations(command);
  if (invocations.length === 0) return { command };
  const replacement = hasManagedPassword ? `sudo -S -p ${shellQuote(marker)}` : "sudo -n";
  let rewritten = "";
  let cursor = 0;
  for (const offset of invocations) {
    rewritten += command.slice(cursor, offset) + replacement;
    cursor = offset + "sudo".length;
  }
  rewritten += command.slice(cursor);
  return hasManagedPassword ? { command: rewritten, promptMarker: marker } : { command: rewritten };
}

/**
 * Holds only a short stderr suffix so a sudo prompt split across SSH packets can
 * be removed. Every prompt occurrence is reported: a chained command may invoke
 * sudo several times and each invocation needs its own password answer.
 */
export class SudoPromptFilter {
  private readonly marker: Buffer;
  private pending = Buffer.alloc(0);

  constructor(marker: string) { this.marker = Buffer.from(marker, "utf8"); }

  push(chunk: Buffer): { visible: Buffer; prompted: number } {
    let combined = Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    let prompted = 0;
    const visible: Buffer[] = [];
    while (true) {
      const index = combined.indexOf(this.marker);
      if (index < 0) break;
      visible.push(combined.subarray(0, index));
      combined = combined.subarray(index + this.marker.length);
      prompted += 1;
    }
    const retained = Math.min(Math.max(0, this.marker.length - 1), combined.length);
    const visibleLength = combined.length - retained;
    if (visibleLength > 0) visible.push(combined.subarray(0, visibleLength));
    this.pending = combined.subarray(visibleLength);
    return { visible: Buffer.concat(visible), prompted };
  }

  flush(): Buffer {
    const value = this.pending;
    this.pending = Buffer.alloc(0);
    return value;
  }
}
function expandHome(path: string): string { return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path; }

export function classifySshError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "SSH operation failed";
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (/authentication|all configured authentication methods failed/i.test(message)) return new AppError("SSH_AUTH_FAILED", message, false, undefined, undefined, 401);
  if (/no such file/i.test(message)) return new AppError("FILE_NOT_FOUND", message, false, undefined, undefined, 404);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || /\b(?:EHOSTUNREACH|ENETUNREACH)\b/u.test(message)) return new AppError("SSH_HOST_UNREACHABLE", message, true, undefined, { networkCode: code || (message.match(/\b(?:EHOSTUNREACH|ENETUNREACH)\b/u)?.[0] ?? "") }, 502);
  if (code === "ECONNREFUSED" || /\bECONNREFUSED\b/u.test(message)) return new AppError("SSH_CONNECTION_REFUSED", message, true, undefined, { networkCode: "ECONNREFUSED" }, 502);
  if (code === "ETIMEDOUT" || /\bETIMEDOUT\b|timed?\s*out/iu.test(message)) return new AppError("SSH_CONNECTION_TIMEOUT", message, true, undefined, { networkCode: "ETIMEDOUT" }, 504);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /\b(?:ENOTFOUND|EAI_AGAIN)\b/u.test(message)) return new AppError("SSH_HOST_NOT_FOUND", message, true, undefined, { networkCode: code }, 502);
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

function sftpFullStat(sftp: SFTPWrapper, path: string): Promise<import("ssh2").Stats> {
  return new Promise((resolve, reject) => sftp.stat(path, (error, stats) => error ? reject(classifySshError(error)) : resolve(stats)));
}

function sftpLstatOptional(sftp: SFTPWrapper, path: string): Promise<import("ssh2").Stats | null> {
  return new Promise((resolve, reject) => sftp.lstat(path, (error, stats) => {
    if (!error) resolve(stats);
    else if ((error as NodeJS.ErrnoException).code === "ENOENT" || /no such file/i.test(error.message)) resolve(null);
    else reject(classifySshError(error));
  }));
}

function sftpRename(sftp: SFTPWrapper, sourcePath: string, destinationPath: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.rename(sourcePath, destinationPath, (error) => error ? reject(classifySshError(error)) : resolve()));
}

async function sftpAtomicReplace(sftp: SFTPWrapper, sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => sftp.ext_openssh_rename(sourcePath, destinationPath, (error) => error ? reject(error) : resolve()));
  } catch (extensionError) {
    try { await sftpRename(sftp, sourcePath, destinationPath); }
    catch {
      throw new AppError("DESTINATION_ATOMIC_REPLACE_UNSUPPORTED", "Destination server cannot safely replace the existing file", false, undefined, {
        reason: extensionError instanceof Error ? extensionError.message : String(extensionError)
      }, 409);
    }
  }
}

async function sftpUnlinkIfExists(sftp: SFTPWrapper, path: string): Promise<void> {
  if (!await sftpExists(sftp, path).catch(() => false)) return;
  await new Promise<void>((resolve) => sftp.unlink(path, () => resolve()));
}
