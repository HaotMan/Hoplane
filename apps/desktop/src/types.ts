export interface Host {
  id: string; name: string; hostname: string; port: number; username: string; credentialId: string | null; policyId: string | null;
  groupName: string | null; tags: string[]; defaultDirectory: string | null; enabled: boolean; aiAccessEnabled: boolean; monitorOutputEnabled: boolean; status: string;
}
export interface Credential { id: string; name: string; type: "PASSWORD" | "PRIVATE_KEY" | "SSH_AGENT"; metadata: { privateKeyPath?: string; agentSocket?: string }; hasSecret: boolean; }
export interface RevealedCredential { credential: Credential; secret: string | null; privateKey: string | null; expiresInSeconds: number; }
export type Policy = SharedPolicy;
export type PolicyDocument = SharedPolicyDocument;
export type PolicyCommandRule = SharedPolicyCommandRule;
export interface AuditLog {
  id: string; createdAt: string; hostNameSnapshot: string | null; clientType: string; operationType: string; requestSummary: string | null;
  policyDecision: string | null; decisionReasonCode: string | null; status: string; durationMs: number | null; errorCode: string | null;
  errorMessage: string | null; exitCode: number | null; bytesTransferred: number | null; finishedAt: string | null;
}
export interface HostMonitorEvent {
  id: string; hostId: string; operationId: string; timestamp: string; kind: "OPERATION" | "STDOUT" | "STDERR";
  clientType?: string; clientId?: string | null; operationType?: string; requestSummary?: string; status?: string;
  policyDecision?: string | null; decisionReasonCode?: string | null; exitCode?: number | null; durationMs?: number | null;
  bytesTransferred?: number | null; errorCode?: string | null; errorMessage?: string | null; content?: string; truncated?: boolean;
}

declare global {
  interface Window {
    hoplane?: { openPoliciesDirectory(): Promise<void> };
  }
}
import type { Policy as SharedPolicy, PolicyCommandRule as SharedPolicyCommandRule, PolicyDocument as SharedPolicyDocument } from "../../../packages/shared/src/types";
