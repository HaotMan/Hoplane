import { z } from "zod";

export const hostInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  hostname: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(128),
  credentialId: z.string().uuid().nullable().optional(),
  policyId: z.string().uuid().nullable().optional(),
  groupName: z.string().trim().max(120).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  defaultDirectory: z.string().trim().max(4096).nullable().optional(),
  enabled: z.boolean().default(true),
  aiAccessEnabled: z.boolean().default(false),
  monitorOutputEnabled: z.boolean().default(false)
});

export const hostPatchSchema = hostInputSchema.partial();

export const hostLoginInputSchema = z.object({
  username: z.string().trim().min(1).max(128),
  sudoEnabled: z.boolean().default(false)
});

export const credentialInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(["PASSWORD", "PRIVATE_KEY", "SSH_AGENT"]),
  secret: z.string().max(16_384).optional(),
  sudoMode: z.enum(["NONE", "LOGIN_PASSWORD", "CUSTOM_PASSWORD"]).default("NONE"),
  sudoSecret: z.string().max(16_384).optional(),
  metadata: z.object({
    privateKeyPath: z.string().max(4096).optional(),
    agentSocket: z.string().max(4096).optional()
  }).default({})
}).superRefine((value, context) => {
  if (value.type === "PASSWORD" && !value.secret) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["secret"], message: "Password is required" });
  }
  if (value.type === "PRIVATE_KEY" && !value.metadata.privateKeyPath) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata", "privateKeyPath"], message: "Private key path is required" });
  }
  if (value.sudoMode === "LOGIN_PASSWORD" && value.type !== "PASSWORD") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sudoMode"], message: "Login password can only be reused with password authentication" });
  }
  if (value.sudoMode === "CUSTOM_PASSWORD" && !value.sudoSecret) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sudoSecret"], message: "Sudo password is required" });
  }
});

const patterns = z.array(z.string().max(512)).max(100).default([]);
const paths = z.array(z.string().max(4096)).max(100).default([]);
export const policyCommandRuleSchema = z.object({
  pattern: z.string().min(1).max(512),
  description: z.string().trim().max(200).optional()
}).strict();

export const policyDocumentSchema = z.object({
  schemaVersion: z.literal(3),
  commandBlacklist: z.array(policyCommandRuleSchema).max(500).default([]),
  files: z.object({
    allowUpload: z.boolean().default(false),
    allowDownload: z.boolean().default(false),
    allowOverwrite: z.boolean().default(false),
    maxUploadBytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024).default(100 * 1024 * 1024),
    maxDownloadBytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024).default(100 * 1024 * 1024),
    allowedLocalPaths: paths,
    allowedRemoteUploadPaths: paths,
    allowedRemoteDownloadPaths: paths
  }).strict()
}).strict();

export const policyInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  document: policyDocumentSchema,
  expectedVersion: z.number().int().positive().optional()
});

export const policySourceSchema = policyDocumentSchema.extend({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120)
}).strict();

export const commandRequestSchema = z.object({
  hostId: z.string().uuid(),
  command: z.string().min(1).max(32_768),
  directory: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
  clientType: z.enum(["MCP", "CLI", "UI"]),
  clientId: z.string().max(200).optional()
});

export const transferRequestSchema = z.object({
  hostId: z.string().uuid(),
  localPath: z.string().min(1).max(4096),
  remotePath: z.string().min(1).max(4096),
  clientType: z.enum(["MCP", "CLI", "UI"]),
  clientId: z.string().max(200).optional()
});
