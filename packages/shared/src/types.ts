export type CredentialType = "PASSWORD" | "PRIVATE_KEY" | "SSH_AGENT";
export type SudoAuthMode = "NONE" | "LOGIN_PASSWORD" | "CUSTOM_PASSWORD";
export type HostStatus =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "FAILED"
  | "AUTH_FAILED"
  | "HOST_KEY_BLOCKED";

export type PolicyDecision = "ALLOW" | "DENY";
export type PolicySourceStatus = "SYNCED" | "ERROR" | "MISSING" | "DISABLED";

export interface PolicyCommandRule {
  pattern: string;
  description?: string;
}

export type SystemCapability = "status" | "processes" | "network" | "storage" | "logs";
export type SystemServiceAction = "status" | "reload" | "restart";
export type DockerAction =
  | "ps" | "info" | "version" | "inspect" | "logs" | "stats"
  | "start" | "stop" | "restart" | "exec" | "run" | "rm" | "prune"
  | "composePs" | "composeLogs" | "composeConfig" | "composeStart"
  | "composeStop" | "composeRestart" | "composeUp" | "composeDown";
export type KubernetesAction =
  | "get" | "describe" | "logs" | "events" | "rolloutStatus"
  | "rolloutRestart" | "scale" | "exec" | "portForward"
  | "apply" | "patch" | "delete";
export type OperationStatus =
  | "RECEIVED"
  | "DENIED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "INTERRUPTED";

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  credentialId: string | null;
  activeLoginId: string | null;
  policyId: string | null;
  groupName: string | null;
  tags: string[];
  defaultDirectory: string | null;
  enabled: boolean;
  aiAccessEnabled: boolean;
  hostTransferEnabled: boolean;
  monitorOutputEnabled: boolean;
  configRevision: number;
  createdAt: string;
  updatedAt: string;
  status?: HostStatus;
}

export interface HostLogin {
  id: string;
  hostId: string;
  username: string;
  credentialId: string | null;
  sudoEnabled: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  secretRef: string | null;
  sudoMode: SudoAuthMode;
  sudoSecretRef: string | null;
  metadata: {
    privateKeyPath?: string;
    agentSocket?: string;
  };
  hasSecret: boolean;
  hasSudoSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDocument {
  schemaVersion: 4;
  commandBlacklist: PolicyCommandRule[];
  files: {
    allowUpload: boolean;
    allowDownload: boolean;
    allowOverwrite: boolean;
    maxUploadBytes: number;
    maxDownloadBytes: number;
    allowedLocalPaths: string[];
    allowedRemoteUploadPaths: string[];
    allowedRemoteDownloadPaths: string[];
  };
}

export interface Policy {
  id: string;
  name: string;
  version: number;
  document: PolicyDocument;
  schemaVersion: 4;
  enabled: boolean;
  sourcePath: string | null;
  sourceStatus: PolicySourceStatus;
  sourceError: string | null;
  sourceHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reasonCode: string;
  reason: string;
  matchedRule?: string;
}

export interface CommandRequest {
  hostId: string;
  command: string;
  directory?: string;
  timeoutMs?: number;
  clientType: "MCP" | "CLI" | "UI";
  clientId?: string;
}

export interface CommandResult {
  operationId: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  durationMs: number;
}

export interface TransferRequest {
  hostId: string;
  localPath: string;
  remotePath: string;
  clientType: "MCP" | "CLI" | "UI";
  clientId?: string;
}

export interface TransferResult {
  operationId: string;
  bytesTransferred: number;
  durationMs: number;
}

export interface HostTransferRequest {
  sourceHostId: string;
  sourcePath: string;
  destinationHostId: string;
  destinationPath: string;
  clientType: "MCP" | "CLI" | "UI";
  clientId?: string;
}

export interface HostTransferResult extends TransferResult {
  transport: "SFTP" | "SSH_STREAM";
}

export interface AuditLog {
  id: string;
  clientType: string;
  clientId: string | null;
  hostId: string | null;
  hostNameSnapshot: string | null;
  peerHostId: string | null;
  peerHostNameSnapshot: string | null;
  operationType: string;
  requestSummary: string | null;
  policyId: string | null;
  policyVersion: number | null;
  peerPolicyId: string | null;
  peerPolicyVersion: number | null;
  policyDecision: PolicyDecision | null;
  decisionReasonCode: string | null;
  status: OperationStatus;
  exitCode: number | null;
  durationMs: number | null;
  bytesTransferred: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type HostMonitorEventKind = "OPERATION" | "STDOUT" | "STDERR";

/** A transient, redacted event shown in the host's read-only terminal. */
export interface HostMonitorEvent {
  id: string;
  hostId: string;
  operationId: string;
  timestamp: string;
  kind: HostMonitorEventKind;
  clientType?: string;
  clientId?: string | null;
  operationType?: string;
  requestSummary?: string;
  status?: OperationStatus;
  policyDecision?: PolicyDecision | null;
  decisionReasonCode?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  bytesTransferred?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  content?: string;
  truncated?: boolean;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  retriable: boolean;
  operationId?: string;
  details?: Record<string, unknown>;
}
