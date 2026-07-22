import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { CommandRequest, CommandResult, Host, Policy, TransferRequest, TransferResult } from "../../shared/src/index.js";
import { AppError, asAppError } from "../../shared/src/index.js";
import type { HoplaneDatabase } from "./database.js";
import { PolicyService } from "../../policy/src/index.js";
import { SSHConnectionManager } from "../../ssh-core/src/connection-manager.js";
import { redact } from "../../audit/src/redact.js";
import { HostMonitor } from "./host-monitor.js";

export class OperationService {
  constructor(
    private readonly database: HoplaneDatabase,
    private readonly policy: PolicyService,
    private readonly ssh: SSHConnectionManager,
    private readonly monitor: HostMonitor
  ) {}

  listHosts(aiOnly: boolean): Array<Host & { capabilities: string[] }> {
    return this.database.listHosts(aiOnly).map((host) => ({
      ...host,
      status: this.ssh.getStatus(host.id),
      capabilities: capabilities(this.database.getPolicy(host.policyId ?? ""))
    }));
  }

  async testHost(hostId: string, clientType: "MCP" | "CLI" | "UI", clientId?: string): Promise<{ operationId: string; status: "OK"; durationMs: number }> {
    const host = this.database.getHost(hostId);
    const operationId = randomUUID();
    const started = Date.now();
    this.createAudit({ operationType: "TEST_HOST", id: operationId, clientType, clientId, hostId, hostNameSnapshot: host?.name });
    try {
      if (!host) throw new AppError("HOST_NOT_FOUND", "Host not found", false, operationId, undefined, 404);
      if (!host.enabled) throw new AppError("HOST_DISABLED", "Host is disabled", false, operationId, undefined, 409);
      if (clientType === "MCP" && !host.aiAccessEnabled) throw new AppError("HOST_NOT_ALLOWED_FOR_AI", "Host is not enabled for AI access", false, operationId, undefined, 403);
      this.updateAudit(operationId, hostId, { status: "EXECUTING" });
      await this.ssh.testConnection(hostId);
      const durationMs = Date.now() - started;
      this.updateAudit(operationId, hostId, { status: "SUCCEEDED", durationMs, finished: true });
      return { operationId, status: "OK", durationMs };
    } catch (error) {
      throw this.finishError(operationId, hostId, started, error);
    }
  }

  async executeCommand(request: CommandRequest): Promise<CommandResult> {
    const host = this.database.getHost(request.hostId);
    const operationId = randomUUID();
    const started = Date.now();
    this.createAudit({
      id: operationId, clientType: request.clientType, clientId: request.clientId, hostId: request.hostId,
      hostNameSnapshot: host?.name, operationType: "EXECUTE_COMMAND", requestSummary: redact(request.command)
    });
    try {
      const { policy } = this.requireOperationalContext(host, request.clientType, operationId);
      const directory = request.directory ?? host!.defaultDirectory ?? undefined;
      const decision = this.policy.evaluateCommand(policy.document, request.command, directory);
      this.recordDecision(operationId, request.hostId, policy, decision);
      if (decision.decision === "DENY") throw new AppError("POLICY_DENIED", decision.reason, false, operationId, { reasonCode: decision.reasonCode }, 403);
      this.updateAudit(operationId, request.hostId, { status: "EXECUTING" });
      const streamOutput = host!.monitorOutputEnabled && this.monitor.isOutputEncryptionAvailable();
      const stdout = streamOutput ? new RedactedMonitorWriter((content) => this.monitor.publish({
        hostId: request.hostId, operationId, kind: "STDOUT", content
      })) : null;
      const stderr = streamOutput ? new RedactedMonitorWriter((content) => this.monitor.publish({
        hostId: request.hostId, operationId, kind: "STDERR", content
      })) : null;
      const result = await this.ssh.execute(request.hostId, request.command, {
        directory,
        timeoutMs: request.timeoutMs ?? 30_000,
        ...(stdout ? { onStdout: (chunk: Buffer) => stdout.write(chunk) } : {}),
        ...(stderr ? { onStderr: (chunk: Buffer) => stderr.write(chunk) } : {})
      }).finally(() => { stdout?.end(); stderr?.end(); });
      if (streamOutput && result.stdoutTruncated) this.publishTruncation(request.hostId, operationId, "STDOUT");
      if (streamOutput && result.stderrTruncated) this.publishTruncation(request.hostId, operationId, "STDERR");
      const durationMs = Date.now() - started;
      this.updateAudit(operationId, request.hostId, { status: "SUCCEEDED", exitCode: result.exitCode, durationMs, finished: true });
      return { operationId, ...result, durationMs };
    } catch (error) {
      throw this.finishError(operationId, request.hostId, started, error);
    }
  }

  async uploadFile(request: TransferRequest): Promise<TransferResult> {
    const host = this.database.getHost(request.hostId);
    const operationId = randomUUID();
    const started = Date.now();
    this.createAudit({
      id: operationId, clientType: request.clientType, clientId: request.clientId, hostId: request.hostId,
      hostNameSnapshot: host?.name, operationType: "UPLOAD_FILE",
      requestSummary: redact(JSON.stringify({ localPath: request.localPath, remotePath: request.remotePath }))
    });
    try {
      const { policy } = this.requireOperationalContext(host, request.clientType, operationId);
      const decision = await this.policy.evaluateUpload(policy.document, request.localPath, request.remotePath);
      this.recordDecision(operationId, request.hostId, policy, decision);
      if (decision.decision === "DENY" || !decision.canonicalLocalPath || !decision.normalizedRemotePath) {
        throw new AppError("PATH_NOT_ALLOWED", decision.reason, false, operationId, { reasonCode: decision.reasonCode }, 403);
      }
      this.updateAudit(operationId, request.hostId, { status: "EXECUTING" });
      const canonicalRemote = await this.ssh.resolveRemotePath(request.hostId, decision.normalizedRemotePath, true);
      const canonicalDecision = this.policy.evaluateCanonicalRemote(canonicalRemote, policy.document.files.allowedRemoteUploadPaths);
      if (canonicalDecision.decision === "DENY") {
        this.updateAudit(operationId, request.hostId, { policyDecision: "DENY", decisionReasonCode: "REMOTE_SYMLINK_ESCAPE", status: "DENIED" });
        throw new AppError("PATH_NOT_ALLOWED", "Remote path resolved outside allowed roots", false, operationId, undefined, 403);
      }
      const bytesTransferred = await this.ssh.upload(request.hostId, decision.canonicalLocalPath, canonicalRemote, policy.document.files.allowOverwrite);
      const durationMs = Date.now() - started;
      this.updateAudit(operationId, request.hostId, { status: "SUCCEEDED", bytesTransferred, durationMs, finished: true });
      return { operationId, bytesTransferred, durationMs };
    } catch (error) {
      throw this.finishError(operationId, request.hostId, started, error);
    }
  }

  async downloadFile(request: TransferRequest): Promise<TransferResult> {
    const host = this.database.getHost(request.hostId);
    const operationId = randomUUID();
    const started = Date.now();
    this.createAudit({
      id: operationId, clientType: request.clientType, clientId: request.clientId, hostId: request.hostId,
      hostNameSnapshot: host?.name, operationType: "DOWNLOAD_FILE",
      requestSummary: redact(JSON.stringify({ localPath: request.localPath, remotePath: request.remotePath }))
    });
    try {
      const { policy } = this.requireOperationalContext(host, request.clientType, operationId);
      const decision = await this.policy.evaluateDownload(policy.document, request.remotePath, request.localPath);
      this.recordDecision(operationId, request.hostId, policy, decision);
      if (decision.decision === "DENY" || !decision.canonicalLocalPath || !decision.normalizedRemotePath) {
        throw new AppError("PATH_NOT_ALLOWED", decision.reason, false, operationId, { reasonCode: decision.reasonCode }, 403);
      }
      this.updateAudit(operationId, request.hostId, { status: "EXECUTING" });
      const canonicalRemote = await this.ssh.resolveRemotePath(request.hostId, decision.normalizedRemotePath, false);
      const canonicalDecision = this.policy.evaluateCanonicalRemote(canonicalRemote, policy.document.files.allowedRemoteDownloadPaths);
      if (canonicalDecision.decision === "DENY") {
        this.updateAudit(operationId, request.hostId, { policyDecision: "DENY", decisionReasonCode: "REMOTE_SYMLINK_ESCAPE", status: "DENIED" });
        throw new AppError("PATH_NOT_ALLOWED", "Remote path resolved outside allowed roots", false, operationId, undefined, 403);
      }
      const size = await this.ssh.getRemoteFileSize(request.hostId, canonicalRemote);
      if (size > policy.document.files.maxDownloadBytes) {
        this.updateAudit(operationId, request.hostId, { policyDecision: "DENY", decisionReasonCode: "FILE_TOO_LARGE", status: "DENIED" });
        throw new AppError("FILE_TOO_LARGE", "Download exceeds the configured size limit", false, operationId, { size }, 413);
      }
      const bytesTransferred = await this.ssh.download(request.hostId, canonicalRemote, decision.canonicalLocalPath, policy.document.files.allowOverwrite);
      const durationMs = Date.now() - started;
      this.updateAudit(operationId, request.hostId, { status: "SUCCEEDED", bytesTransferred, durationMs, finished: true });
      return { operationId, bytesTransferred, durationMs };
    } catch (error) {
      throw this.finishError(operationId, request.hostId, started, error);
    }
  }

  private requireOperationalContext(host: Host | null, clientType: string, operationId: string): { host: Host; policy: Policy } {
    if (!host) throw new AppError("HOST_NOT_FOUND", "Host not found", false, operationId, undefined, 404);
    if (!host.enabled) throw new AppError("HOST_DISABLED", "Host is disabled", false, operationId, undefined, 409);
    if (clientType === "MCP" && !host.aiAccessEnabled) throw new AppError("HOST_NOT_ALLOWED_FOR_AI", "Host is not enabled for AI access", false, operationId, undefined, 403);
    if (!host.policyId) throw new AppError("POLICY_DENIED", "Host has no assigned policy", false, operationId, undefined, 403);
    const policy = this.database.getPolicy(host.policyId);
    if (!policy) throw new AppError("POLICY_NOT_FOUND", "Assigned policy does not exist", false, operationId, undefined, 409);
    if (!policy.enabled || policy.sourceStatus === "MISSING" || policy.sourceStatus === "DISABLED") {
      this.updateAudit(operationId, host.id, { policyId: policy.id, policyVersion: policy.version, policyDecision: "DENY", decisionReasonCode: "POLICY_DISABLED", status: "DENIED", finished: true });
      throw new AppError("POLICY_DENIED", "Assigned policy is disabled or its source file is missing", false, operationId, { reasonCode: "POLICY_DISABLED" }, 403);
    }
    return { host, policy };
  }

  private recordDecision(operationId: string, hostId: string, policy: Policy, result: { decision: "ALLOW" | "DENY"; reasonCode: string }): void {
    this.updateAudit(operationId, hostId, {
      policyId: policy.id, policyVersion: policy.version, policyDecision: result.decision, decisionReasonCode: result.reasonCode,
      ...(result.decision === "DENY" ? { status: "DENIED" as const } : {})
    });
  }

  private finishError(operationId: string, hostId: string, started: number, error: unknown): AppError {
    const appError = asAppError(error);
    const deniedCodes = new Set(["POLICY_DENIED", "PATH_NOT_ALLOWED", "HOST_NOT_ALLOWED_FOR_AI", "FILE_TOO_LARGE"]);
    const status = appError.code === "COMMAND_TIMEOUT" ? "TIMED_OUT" : deniedCodes.has(appError.code) ? "DENIED" : "FAILED";
    this.updateAudit(operationId, hostId, {
      status, durationMs: Date.now() - started, errorCode: appError.code,
      errorMessage: redact(appError.message, 1000), finished: true
    });
    return new AppError(appError.code, appError.message, appError.retriable, appError.operationId ?? operationId, appError.details, appError.statusCode);
  }

  private createAudit(input: Parameters<HoplaneDatabase["createAudit"]>[0]): void {
    this.database.createAudit(input);
    if (!input.hostId) return;
    this.monitor.publish({
      hostId: input.hostId,
      operationId: input.id,
      kind: "OPERATION",
      clientType: input.clientType,
      clientId: input.clientId ?? null,
      operationType: input.operationType,
      requestSummary: input.requestSummary,
      status: "RECEIVED"
    });
  }

  private updateAudit(operationId: string, hostId: string, patch: Parameters<HoplaneDatabase["updateAudit"]>[1]): void {
    this.database.updateAudit(operationId, patch);
    this.monitor.publish({
      hostId,
      operationId,
      kind: "OPERATION",
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.policyDecision !== undefined ? { policyDecision: patch.policyDecision } : {}),
      ...(patch.decisionReasonCode !== undefined ? { decisionReasonCode: patch.decisionReasonCode } : {}),
      ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
      ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
      ...(patch.bytesTransferred !== undefined ? { bytesTransferred: patch.bytesTransferred } : {}),
      ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {})
    });
  }

  private publishTruncation(hostId: string, operationId: string, kind: "STDOUT" | "STDERR"): void {
    this.monitor.publish({
      hostId,
      operationId,
      kind,
      content: "\n[Hoplane：输出已达到安全上限，后续内容未显示]\n",
      truncated: true
    });
  }
}

class RedactedMonitorWriter {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private ended = false;

  constructor(private readonly emit: (content: string) => void) {}

  write(chunk: Buffer): void {
    if (this.ended || chunk.length === 0) return;
    this.pending += this.decoder.write(chunk);
    this.flushLines();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.pending += this.decoder.end();
    this.flushLines();
    if (this.pending) this.emit(redact(this.pending, 32_768));
    this.pending = "";
  }

  private flushLines(): void {
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      this.emit(redact(line, 32_768));
      newline = this.pending.indexOf("\n");
    }
  }
}

function capabilities(policy: Policy | null): string[] {
  if (!policy || !policy.enabled) return [];
  const result = ["execute"];
  if (policy.document.files.allowUpload) result.push("upload");
  if (policy.document.files.allowDownload) result.push("download");
  return result;
}
