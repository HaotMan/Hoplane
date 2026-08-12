import {
  Client,
  type AcceptConnection,
  type ClientChannel,
  type ConnectConfig,
  type RejectConnection,
  type SFTPWrapper,
  type TcpConnectionDetails
} from "ssh2";
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createConnection as createTcpConnection, type Socket } from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join } from "node:path/posix";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CommandResult, Credential, Host, HostStatus, ProxyTunnelState } from "../../shared/src/index.js";
import { AppError } from "../../shared/src/index.js";
import type { HoplaneDatabase } from "../../core/src/database.js";
import type { CredentialVault } from "../../core/src/vault.js";

interface ManagedConnection {
  client: Client;
  revision: number;
  lastUsedAt: number;
}

interface ProxyConnection {
  local: Socket;
  channel: ClientChannel;
}

interface ManagedProxyTunnel {
  client: Client;
  localHost: string;
  localPort: number;
  remotePort: number;
  listener: (details: TcpConnectionDetails, accept: AcceptConnection<ClientChannel>, reject: RejectConnection) => void;
  connections: Set<ProxyConnection>;
  pendingSockets: Set<Socket>;
}

const PROXY_BIND_ADDRESS = "127.0.0.1";
const PROXY_CONNECT_TIMEOUT_MS = 1_500;
const PROXY_RETRY_MAX_MS = 30_000;
const MAX_PROXY_CONNECTIONS_PER_HOST = 128;

export interface ShellSession {
  username: string;
  stream: ClientChannel;
  initialize(): void;
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
  private readonly proxyStates = new Map<string, ProxyTunnelState>();
  private readonly proxyTunnels = new Map<string, ManagedProxyTunnel>();
  private readonly proxyStarting = new Map<string, Promise<void>>();
  private readonly proxyRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly proxyRetryAttempts = new Map<string, number>();
  private readonly intentionalDisconnects = new WeakSet<Client>();
  private suppressProxyRetries = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly database: HoplaneDatabase,
    private readonly vault: CredentialVault,
    private readonly outputLimitBytes: number
  ) {}

  getStatus(hostId: string): HostStatus {
    return this.statuses.get(hostId) ?? "DISCONNECTED";
  }

  getProxyState(hostId: string): ProxyTunnelState {
    const host = this.database.getHost(hostId);
    if (!host?.enabled || !host.proxyEnabled) return { status: "DISABLED" };
    return this.proxyStates.get(hostId) ?? { status: "CONNECTING" };
  }

  async reconcileConfiguredProxies(): Promise<void> {
    await Promise.all(this.database.listHosts().map((host) => this.reconcileProxy(host.id)));
  }

  async reconcileProxy(hostId: string): Promise<void> {
    const host = this.database.getHost(hostId);
    if (!host?.enabled || !host.proxyEnabled) {
      this.cancelProxyRetry(hostId);
      await this.stopProxyTunnel(hostId);
      this.proxyStates.set(hostId, { status: "DISABLED" });
      return;
    }
    try {
      await this.ensureProxyAvailable(hostId);
    } catch { /* Desired state is retained; runtime state exposes the failure and retry. */ }
  }

  async testConnection(hostId: string): Promise<void> {
    const host = this.requireEnabledHost(hostId);
    const credential = host.credentialId ? this.database.getCredential(host.credentialId) : null;
    if (!credential) throw new AppError("CREDENTIAL_NOT_FOUND", "Host has no usable credential", false, undefined, undefined, 409);
    const client = await this.establishClient(host, credential, host.username, false);
    client.end();
  }

  async execute(hostId: string, command: string, options: {
    directory?: string;
    timeoutMs: number;
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
    useProxy?: boolean;
  }): Promise<Omit<CommandResult, "operationId" | "durationMs">> {
    let host = this.requireEnabledHost(hostId);
    if (host.proxyEnabled && options.useProxy !== false) {
      await this.ensureProxyAvailable(hostId);
      host = this.requireEnabledHost(hostId);
    }
    let client = await this.getConnection(hostId);
    if (host.proxyEnabled && options.useProxy !== false && !this.isProxyTunnelActive(host, client)) {
      await this.ensureProxyAvailable(hostId);
      client = await this.getConnection(hostId);
      if (!this.isProxyTunnelActive(host, client)) {
        const error = new AppError("PROXY_TUNNEL_UNAVAILABLE", "The reverse proxy tunnel is not active on the current SSH connection", true, undefined, undefined, 502);
        this.handleProxyFailure(hostId, error);
        throw error;
      }
    }
    const sudoPassword = findSudoInvocations(command).length > 0 ? await this.resolveSudoPassword(hostId) : null;
    const sudoExecution = prepareSudoExecution(command, sudoPassword !== null);
    const requestedCommand = options.directory ? `cd -- ${shellQuote(options.directory)} && ${sudoExecution.command}` : sudoExecution.command;
    const fullCommand = host.proxyEnabled && options.useProxy !== false
      ? `${proxyExportCommand(host.proxyRemotePort)} ${requestedCommand}`
      : requestedCommand;
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let activeStream: { close(): void } | undefined;
      // A caller may use `2>&1`, which moves sudo's prompt from stderr to
      // stdout. Keep independent packet filters for both SSH streams because a
      // prompt can be split across chunks, but never across the two streams.
      const stdoutSudoPrompt = sudoExecution.promptMarker ? new SudoPromptFilter(sudoExecution.promptMarker) : null;
      const stderrSudoPrompt = sudoExecution.promptMarker ? new SudoPromptFilter(sudoExecution.promptMarker) : null;
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
        const answerSudoPrompts = (prompted: number) => {
          // stdin stays open so every sudo in a chained command can be answered.
          if (prompted > 0 && sudoPassword !== null) stream.write(`${sudoPassword}\n`.repeat(prompted));
        };
        const appendStdout = (chunk: Buffer) => {
          if (chunk.length === 0) return;
          const remaining = Math.max(0, this.outputLimitBytes - stdout.length);
          if (remaining > 0) options.onStdout?.(chunk.subarray(0, remaining));
          const result = appendLimited(stdout, chunk, this.outputLimitBytes);
          stdout = result.value;
          stdoutTruncated ||= result.truncated;
        };
        const appendStderr = (chunk: Buffer) => {
          if (chunk.length === 0) return;
          const remaining = Math.max(0, this.outputLimitBytes - stderr.length);
          if (remaining > 0) options.onStderr?.(chunk.subarray(0, remaining));
          const result = appendLimited(stderr, chunk, this.outputLimitBytes);
          stderr = result.value;
          stderrTruncated ||= result.truncated;
        };
        stream.on("data", (chunk: Buffer) => {
          const filtered = stdoutSudoPrompt?.push(chunk) ?? { visible: chunk, prompted: 0 };
          answerSudoPrompts(filtered.prompted);
          appendStdout(filtered.visible);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          const filtered = stderrSudoPrompt?.push(chunk) ?? { visible: chunk, prompted: 0 };
          answerSudoPrompts(filtered.prompted);
          appendStderr(filtered.visible);
        });
        stream.on("close", (code: number | null) => {
          if (settled) return;
          if (stdoutSudoPrompt) appendStdout(stdoutSudoPrompt.flush());
          if (stderrSudoPrompt) appendStderr(stderrSudoPrompt.flush());
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
    let host = this.requireEnabledHost(hostId);
    if (host.proxyEnabled) {
      await this.ensureProxyAvailable(hostId);
      host = this.requireEnabledHost(hostId);
    }
    const login = this.database.getHostLogin(loginId);
    if (!login || login.hostId !== hostId) throw new AppError("HOST_LOGIN_NOT_FOUND", "The requested login does not belong to this host", false, undefined, undefined, 404);
    const credential = login.credentialId ? this.database.getCredential(login.credentialId) : null;
    if (!credential) throw new AppError("CREDENTIAL_NOT_FOUND", "The selected login has no usable credential", false, undefined, undefined, 409);
    const client = await this.establishClient(host, credential, login.username, false);
    if (host.proxyEnabled) {
      try { await this.ensureProxyAvailable(hostId); }
      catch (error) { client.end(); throw error; }
    }
    return new Promise((resolve, reject) => {
      client.shell({ term: options.term ?? "xterm-256color", cols: options.cols, rows: options.rows }, (error, stream) => {
        if (error) {
          client.end();
          reject(classifySshError(error));
          return;
        }
        let initialized = false;
        resolve({
          username: login.username,
          stream,
          initialize: () => {
            if (initialized) return;
            initialized = true;
            if (host.proxyEnabled) stream.write(`${proxyExportCommand(host.proxyRemotePort)}\n`);
          },
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
    try { return await this.execute(hostId, command, { timeoutMs: 30_000, useProxy: false }); }
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
    await this.disconnectCascade(hostId, new Set());
  }

  private async disconnectCascade(hostId: string, visited: Set<string>): Promise<void> {
    if (visited.has(hostId)) return;
    visited.add(hostId);
    const dependents = typeof this.database.listHosts === "function"
      ? this.database.listHosts().filter((host) => host.jumpHostId === hostId)
      : [];
    for (const dependent of dependents) await this.disconnectCascade(dependent.id, visited);
    const pending = this.proxyStarting.get(hostId);
    if (pending) await Promise.allSettled([pending]);
    await this.disconnectTransport(hostId);
  }

  private async disconnectTransport(hostId: string): Promise<void> {
    this.cancelProxyRetry(hostId);
    const connection = this.connections.get(hostId);
    if (connection) this.intentionalDisconnects.add(connection.client);
    await this.stopProxyTunnel(hostId);
    if (connection) {
      connection.client.end();
      this.connections.delete(hostId);
    }
    this.statuses.set(hostId, "DISCONNECTED");
  }

  async closeAll(): Promise<void> {
    this.suppressProxyRetries = true;
    try {
      for (const hostId of this.proxyRetryTimers.keys()) this.cancelProxyRetry(hostId);
      await Promise.allSettled([...this.proxyStarting.values()]);
      for (const hostId of new Set([...this.connections.keys(), ...this.proxyTunnels.keys()])) await this.disconnect(hostId);
      if (!this.shuttingDown) {
        for (const host of this.database.listHosts()) {
          if (host.enabled && host.proxyEnabled) {
            this.proxyStates.set(host.id, { status: "WAITING_FOR_VAULT", errorCode: "VAULT_LOCKED", errorMessage: "Local vault is locked" });
          }
        }
      }
    } finally {
      if (!this.shuttingDown) this.suppressProxyRetries = false;
    }
  }

  shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.shutdownPromise ??= this.closeAll();
    return this.shutdownPromise;
  }

  private async ensureProxyAvailable(hostId: string): Promise<void> {
    try {
      await this.ensureProxyAvailableUnchecked(hostId);
    } catch (error) {
      const appError = proxyTunnelError(error);
      this.handleProxyFailure(hostId, appError);
      throw appError;
    }
  }

  private async ensureProxyAvailableUnchecked(hostId: string): Promise<void> {
    const host = this.requireEnabledHost(hostId);
    if (!host.proxyEnabled) return;
    const existing = this.proxyTunnels.get(hostId);
    if (existing && existing.localHost === host.proxyLocalHost && existing.localPort === host.proxyLocalPort && existing.remotePort === host.proxyRemotePort) {
      await probeLocalProxy(host.proxyLocalHost, host.proxyLocalPort);
      this.cancelProxyRetry(hostId);
      this.proxyRetryAttempts.delete(hostId);
      this.proxyStates.set(hostId, { status: "ACTIVE" });
      return;
    }
    const pending = this.proxyStarting.get(hostId);
    if (pending) return pending;
    const start = this.startProxyTunnel(host).finally(() => this.proxyStarting.delete(hostId));
    this.proxyStarting.set(hostId, start);
    return start;
  }

  private async startProxyTunnel(host: Host): Promise<void> {
    this.proxyStates.set(host.id, { status: "CONNECTING" });
    await this.stopProxyTunnel(host.id);
    try {
      const client = await this.getConnection(host.id);
      await probeLocalProxy(host.proxyLocalHost, host.proxyLocalPort);
      const tunnel: ManagedProxyTunnel = {
        client,
        localHost: host.proxyLocalHost,
        localPort: host.proxyLocalPort,
        remotePort: host.proxyRemotePort,
        listener: () => undefined,
        connections: new Set(),
        pendingSockets: new Set()
      };
      tunnel.listener = (details, accept, reject) => this.acceptProxyConnection(host.id, tunnel, details, accept, reject);
      this.proxyTunnels.set(host.id, tunnel);
      client.on("tcp connection", tunnel.listener);
      try {
        await forwardIn(client, PROXY_BIND_ADDRESS, host.proxyRemotePort);
      } catch (error) {
        if (this.proxyTunnels.get(host.id) === tunnel) this.proxyTunnels.delete(host.id);
        client.off("tcp connection", tunnel.listener);
        throw error;
      }
      if (this.proxyTunnels.get(host.id) !== tunnel) {
        throw new AppError("PROXY_SSH_CONNECTION_CLOSED", "The SSH connection closed while the proxy tunnel was starting", true, undefined, undefined, 502);
      }
      const latest = this.database.getHost(host.id);
      if (!latest?.enabled || !latest.proxyEnabled || latest.proxyLocalHost !== host.proxyLocalHost || latest.proxyLocalPort !== host.proxyLocalPort || latest.proxyRemotePort !== host.proxyRemotePort) {
        await this.stopProxyTunnel(host.id);
        if (latest?.enabled && latest.proxyEnabled) return this.startProxyTunnel(latest);
        this.proxyStates.set(host.id, { status: "DISABLED" });
        return;
      }
      this.cancelProxyRetry(host.id);
      this.proxyRetryAttempts.delete(host.id);
      this.proxyStates.set(host.id, { status: "ACTIVE" });
    } catch (error) {
      throw proxyTunnelError(error);
    }
  }

  private acceptProxyConnection(
    hostId: string,
    tunnel: ManagedProxyTunnel,
    details: TcpConnectionDetails,
    accept: AcceptConnection<ClientChannel>,
    reject: RejectConnection
  ): void {
    if (details.destPort !== tunnel.remotePort || this.proxyTunnels.get(hostId) !== tunnel || tunnel.connections.size + tunnel.pendingSockets.size >= MAX_PROXY_CONNECTIONS_PER_HOST) {
      try { reject(); } catch { /* Forward request already closed. */ }
      return;
    }
    const local = createTcpConnection({ host: tunnel.localHost, port: tunnel.localPort });
    tunnel.pendingSockets.add(local);
    let connected = false;
    const timer = setTimeout(() => local.destroy(new Error("Local proxy connection timed out")), PROXY_CONNECT_TIMEOUT_MS);
    local.once("connect", () => {
      connected = true;
      tunnel.pendingSockets.delete(local);
      clearTimeout(timer);
      if (this.proxyTunnels.get(hostId) !== tunnel) {
        try { reject(); } catch { /* Forward request already closed. */ }
        local.destroy();
        return;
      }
      let channel: ClientChannel;
      try { channel = accept(); }
      catch { local.destroy(); return; }
      const connection = { local, channel };
      tunnel.connections.add(connection);
      const close = () => {
        tunnel.connections.delete(connection);
        if (!local.destroyed) local.destroy();
        if (!channel.destroyed) channel.destroy();
      };
      local.once("close", close);
      channel.once("close", close);
      local.once("error", close);
      channel.once("error", close);
      local.pipe(channel);
      channel.pipe(local);
      this.proxyStates.set(hostId, { status: "ACTIVE" });
    });
    local.once("error", (error) => {
      clearTimeout(timer);
      if (connected) return;
      tunnel.pendingSockets.delete(local);
      try { reject(); } catch { /* Forward request already closed. */ }
      this.handleProxyFailure(hostId, localProxyError(tunnel.localHost, tunnel.localPort, error));
    });
  }

  private async stopProxyTunnel(hostId: string): Promise<void> {
    const tunnel = this.proxyTunnels.get(hostId);
    if (!tunnel) return;
    this.proxyTunnels.delete(hostId);
    tunnel.client.off("tcp connection", tunnel.listener);
    for (const socket of tunnel.pendingSockets) socket.destroy(new Error("Proxy tunnel stopped"));
    tunnel.pendingSockets.clear();
    for (const connection of tunnel.connections) {
      connection.local.destroy();
      connection.channel.destroy();
    }
    tunnel.connections.clear();
    await unforwardIn(tunnel.client, PROXY_BIND_ADDRESS, tunnel.remotePort).catch(() => undefined);
  }

  private handleProxyFailure(hostId: string, error: AppError): void {
    if (error.code === "VAULT_LOCKED") {
      this.proxyStates.set(hostId, { status: "WAITING_FOR_VAULT", errorCode: error.code, errorMessage: error.message });
      return;
    }
    if (error.code === "LOCAL_PROXY_UNAVAILABLE") {
      this.proxyStates.set(hostId, { status: "LOCAL_PROXY_UNAVAILABLE", errorCode: error.code, errorMessage: error.message });
    } else if (error.retriable) {
      this.proxyStates.set(hostId, { status: "RETRYING", errorCode: error.code, errorMessage: error.message });
    } else {
      this.proxyStates.set(hostId, { status: "FAILED", errorCode: error.code, errorMessage: error.message });
    }
    if (error.retriable) this.scheduleProxyRetry(hostId);
  }

  private scheduleProxyRetry(hostId: string): void {
    if (this.suppressProxyRetries || this.proxyRetryTimers.has(hostId)) return;
    const host = this.database.getHost(hostId);
    if (!host?.enabled || !host.proxyEnabled) return;
    const attempt = this.proxyRetryAttempts.get(hostId) ?? 0;
    this.proxyRetryAttempts.set(hostId, attempt + 1);
    const base = Math.min(PROXY_RETRY_MAX_MS, 1_000 * (2 ** Math.min(attempt, 5)));
    const delay = base + Math.floor(Math.random() * Math.min(1_000, Math.ceil(base / 4)));
    const timer = setTimeout(() => {
      this.proxyRetryTimers.delete(hostId);
      void this.reconcileProxy(hostId);
    }, delay);
    timer.unref();
    this.proxyRetryTimers.set(hostId, timer);
  }

  private cancelProxyRetry(hostId: string): void {
    const timer = this.proxyRetryTimers.get(hostId);
    if (timer) clearTimeout(timer);
    this.proxyRetryTimers.delete(hostId);
  }

  private isProxyTunnelActive(host: Host, client: Client): boolean {
    const tunnel = this.proxyTunnels.get(host.id);
    return Boolean(tunnel && tunnel.client === client && tunnel.localHost === host.proxyLocalHost && tunnel.localPort === host.proxyLocalPort && tunnel.remotePort === host.proxyRemotePort);
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

  private async getConnection(hostId: string, ancestry: readonly string[] = []): Promise<Client> {
    if (this.shuttingDown) {
      throw new AppError("SSH_MANAGER_SHUTTING_DOWN", "SSH connection manager is shutting down", false, undefined, undefined, 503);
    }
    if (ancestry.includes(hostId)) {
      throw new AppError("JUMP_HOST_CYCLE", "Jump host configuration contains a cycle", false, undefined, { hostId, path: [...ancestry, hostId] }, 409);
    }
    const host = this.requireEnabledHost(hostId);
    const existing = this.connections.get(hostId);
    if (existing?.revision === host.configRevision) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }
    if (existing) await this.disconnectTransport(hostId);
    const pending = this.connecting.get(hostId);
    if (pending) {
      const client = await pending;
      if (this.shuttingDown) {
        this.intentionalDisconnects.add(client);
        client.end();
        throw new AppError("SSH_MANAGER_SHUTTING_DOWN", "SSH connection manager is shutting down", false, undefined, undefined, 503);
      }
      return client;
    }
    if (this.connections.size + this.connecting.size >= 20) {
      throw new AppError("CONNECTION_LIMIT_REACHED", "The maximum of 20 concurrent SSH connections has been reached", true, undefined, undefined, 429);
    }
    const promise = this.createConnection(host, ancestry).finally(() => this.connecting.delete(hostId));
    this.connecting.set(hostId, promise);
    const client = await promise;
    if (this.shuttingDown) {
      this.intentionalDisconnects.add(client);
      client.end();
      throw new AppError("SSH_MANAGER_SHUTTING_DOWN", "SSH connection manager is shutting down", false, undefined, undefined, 503);
    }
    this.connections.set(hostId, { client, revision: host.configRevision, lastUsedAt: Date.now() });
    return client;
  }

  private async createConnection(host: Host, ancestry: readonly string[]): Promise<Client> {
    this.statuses.set(host.id, "CONNECTING");
    const credential = host.credentialId ? this.database.getCredential(host.credentialId) : null;
    if (!credential) throw new AppError("CREDENTIAL_NOT_FOUND", "Host has no usable credential", false, undefined, undefined, 409);
    try {
      return await this.establishClient(host, credential, host.username, true, ancestry);
    } catch (error) {
      const appError = error instanceof AppError ? error : classifySshError(error);
      if (appError.details?.hostId !== host.id || this.statuses.get(host.id) === "CONNECTING") this.statuses.set(host.id, "FAILED");
      throw appError;
    }
  }

  /** Connects a new ssh2 client. `trackStatus` ties the client to the pooled host status; shell sessions pass false. */
  private async establishClient(host: Host, credential: Credential, username: string, trackStatus: boolean, ancestry: readonly string[] = []): Promise<Client> {
    if (ancestry.includes(host.id)) {
      throw new AppError("JUMP_HOST_CYCLE", "Jump host configuration contains a cycle", false, undefined, { hostId: host.id, path: [...ancestry, host.id] }, 409);
    }
    const connectionPath = [...ancestry, host.id];
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

    if (host.jumpHostId) {
      const jumpHost = this.requireEnabledHost(host.jumpHostId);
      const jumpClient = await this.getConnection(jumpHost.id, connectionPath);
      config.sock = await new Promise<ClientChannel>((resolve, reject) => {
        jumpClient.forwardOut("127.0.0.1", 0, host.hostname, host.port, (error, channel) => {
          if (error) {
            reject(new AppError("JUMP_HOST_FORWARD_FAILED", `Jump host \"${jumpHost.name}\" could not reach ${host.hostname}:${host.port}`, true, undefined, {
              hostId: host.id,
              hostName: host.name,
              jumpHostId: jumpHost.id,
              jumpHostName: jumpHost.name
            }, 502));
            return;
          }
          resolve(channel);
        });
      });
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      let connectionSettled = false;
      client.once("ready", () => {
        if (connectionSettled) return;
        connectionSettled = true;
        if (trackStatus) this.statuses.set(host.id, "CONNECTED");
        resolve(client);
      });
      client.on("error", (error: Error & { level?: string }) => {
        // ssh2 may emit a connection error (for example ECONNRESET) after it
        // already reported the authentication failure that rejected this
        // promise. Keep the listener for the client's full lifetime so a
        // follow-up error cannot escape as an uncaught EventEmitter error.
        if (connectionSettled) return;
        connectionSettled = true;
        if (observedFingerprint && observedFingerprint !== trustedFingerprint) {
          const changed = Boolean(trustedFingerprint);
          if (trackStatus) this.statuses.set(host.id, "HOST_KEY_BLOCKED");
          reject(new AppError(changed ? "SSH_HOST_KEY_CHANGED" : "SSH_HOST_KEY_UNTRUSTED", changed ? "SSH host key changed" : "SSH host key is not trusted yet", false, undefined, {
            hostId: host.id,
            hostName: host.name,
            observedFingerprint,
            ...(trustedFingerprint ? { trustedFingerprint } : {})
          }, 409));
          return;
        }
        const classified = classifySshError(error);
        const contextual = new AppError(classified.code, classified.message, classified.retriable, classified.operationId, {
          ...classified.details,
          hostId: host.id,
          hostName: host.name
        }, classified.statusCode);
        if (trackStatus) this.statuses.set(host.id, classified.code === "SSH_AUTH_FAILED" ? "AUTH_FAILED" : "FAILED");
        reject(contextual);
      });
      client.on("close", () => {
        if (!trackStatus) return;
        const current = this.connections.get(host.id);
        if (current?.client === client) this.connections.delete(host.id);
        if (this.statuses.get(host.id) === "CONNECTED") this.statuses.set(host.id, "DISCONNECTED");
        const intentional = this.intentionalDisconnects.has(client);
        this.intentionalDisconnects.delete(client);
        this.dropProxyTunnel(host.id, client);
        if (!intentional && !this.suppressProxyRetries && !this.shuttingDown) {
          const desired = this.database.getHost(host.id);
          if (desired?.enabled && desired.proxyEnabled) {
            const error = new AppError("PROXY_SSH_CONNECTION_CLOSED", "The SSH connection carrying the proxy tunnel closed", true, undefined, undefined, 502);
            this.handleProxyFailure(host.id, error);
          }
        }
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

  private dropProxyTunnel(hostId: string, client: Client): void {
    const tunnel = this.proxyTunnels.get(hostId);
    if (!tunnel || tunnel.client !== client) return;
    this.proxyTunnels.delete(hostId);
    client.off("tcp connection", tunnel.listener);
    for (const socket of tunnel.pendingSockets) socket.destroy(new Error("Proxy tunnel closed"));
    tunnel.pendingSockets.clear();
    for (const connection of tunnel.connections) {
      connection.local.destroy();
      connection.channel.destroy();
    }
    tunnel.connections.clear();
  }
}

function proxyExportCommand(remotePort: number): string {
  const proxyUrl = `socks5h://127.0.0.1:${remotePort}`;
  return `export ALL_PROXY=${shellQuote(proxyUrl)}; export all_proxy="$ALL_PROXY";`;
}

function probeLocalProxy(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createTcpConnection({ host, port });
    let settled = false;
    const finish = (error?: AppError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(localProxyError(host, port, new Error("Connection timed out"))), PROXY_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(localProxyError(host, port, error)));
  });
}

function forwardIn(client: Client, bindAddress: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try { client.forwardIn(bindAddress, port, (error) => error ? reject(error) : resolve()); }
    catch (error) { reject(error); }
  });
}

function unforwardIn(client: Client, bindAddress: string, port: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    try { client.unforwardIn(bindAddress, port, finish); }
    catch { finish(); }
  });
}

function localProxyError(host: string, port: number, error: unknown): AppError {
  const reason = error instanceof Error ? error.message : String(error);
  return new AppError("LOCAL_PROXY_UNAVAILABLE", `Local SOCKS5 proxy is unavailable on ${host}:${port}`, true, undefined, { host, port, reason }, 502);
}

function proxyTunnelError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/administratively prohibited|tcp forwarding.*(?:disabled|prohibited)|forwarding is disabled/iu.test(message)) {
    return new AppError("PROXY_TUNNEL_FORWARDING_DENIED", "The SSH server does not allow reverse TCP forwarding", false, undefined, { reason: message }, 409);
  }
  if (/unable to bind/iu.test(message)) {
    return new AppError("PROXY_REMOTE_PORT_UNAVAILABLE", "The proxy port could not be bound on the remote host", false, undefined, { reason: message }, 409);
  }
  return classifySshError(error);
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
 * `{`, newline), or immediately after the shell `time` wrapper (`time sudo`
 * and `time -p sudo`). Text inside single/double quotes is skipped, so e.g.
 * `echo "a && sudo b"` is not treated as a sudo invocation. sudo credentials do
 * not carry across invocations on a non-interactive SSH channel (no TTY means no
 * usable timestamp cache), so every invocation needs its own authentication.
 */
export function findSudoInvocations(command: string): number[] {
  const offsets: number[] = [];
  let atCommandStart = true;
  let insideTimeWrapper = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "\\") { index += 1; atCommandStart = false; insideTimeWrapper = false; continue; }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      index = end < 0 ? command.length : end;
      atCommandStart = false;
      insideTimeWrapper = false;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < command.length && command[index] !== '"') { if (command[index] === "\\") index += 1; index += 1; }
      atCommandStart = false;
      insideTimeWrapper = false;
      continue;
    }
    if (COMMAND_SEPARATORS.has(char)) { atCommandStart = true; insideTimeWrapper = false; continue; }
    if (/\s/u.test(char)) continue;
    if (atCommandStart && command.startsWith("time", index) && /\s/u.test(command[index + 4] ?? "")) {
      index += 3;
      insideTimeWrapper = true;
      continue;
    }
    if (atCommandStart && insideTimeWrapper && command.startsWith("-p", index) && (index + 2 === command.length || /\s/u.test(command[index + 2]!))) {
      index += 1;
      continue;
    }
    if (atCommandStart && command.startsWith("sudo", index) && (index + 4 === command.length || /\s/u.test(command[index + 4]!))) {
      offsets.push(index);
      index += 3;
    }
    atCommandStart = false;
    insideTimeWrapper = false;
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
 * Holds only a short output-stream suffix so a sudo prompt split across SSH
 * packets can be removed. The same filter is used independently for stdout and
 * stderr. Every prompt occurrence is reported because a chained command may
 * invoke sudo several times and each invocation needs its own password answer.
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
