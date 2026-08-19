import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AppError, policyDocumentSchema, type Credential, type CredentialType, type Host, type PolicyDocument, type SudoAuthMode } from "../../shared/src/index.js";
import type { CoreConfig } from "./config.js";
import { ensurePrivateDirectory } from "./config.js";
import type { HoplaneDatabase } from "./database.js";
import type { PolicySourceService } from "./policy-source.js";
import type { LocalCredentialVaultManager } from "./vault-manager.js";

const EXPORT_KIND = "hoplane-config";
const PAYLOAD_KIND = "hoplane-config-payload";
const EXPORT_VERSION = 1;
const KEY_BYTES = 32;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MAX_MEMORY = 256 * 1024 * 1024;
const AAD = Buffer.from("hoplane-config-export-v1", "utf8");

const uuidSchema = z.string().uuid();
const exportHostSchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(120),
  hostname: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(128),
  credentialId: uuidSchema.nullable(),
  activeLoginId: uuidSchema.nullable(),
  jumpHostId: uuidSchema.nullable(),
  policyId: uuidSchema.nullable(),
  groupName: z.string().trim().max(120).nullable(),
  tags: z.array(z.string().trim().min(1).max(64)).max(32),
  defaultDirectory: z.string().max(4096).nullable(),
  enabled: z.boolean(),
  aiAccessEnabled: z.boolean(),
  hostTransferEnabled: z.boolean(),
  monitorOutputEnabled: z.boolean(),
  proxyEnabled: z.boolean(),
  proxyLocalHost: z.string().trim().min(1).max(255),
  proxyLocalPort: z.number().int().min(1).max(65535),
  proxyRemotePort: z.number().int().min(1).max(65535)
});
const exportLoginSchema = z.object({
  id: uuidSchema,
  hostId: uuidSchema,
  username: z.string().trim().min(1).max(128),
  credentialId: uuidSchema.nullable(),
  sudoEnabled: z.boolean()
});
const exportCredentialSchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(120),
  type: z.enum(["PASSWORD", "PRIVATE_KEY", "SSH_AGENT"]),
  sudoMode: z.enum(["NONE", "LOGIN_PASSWORD", "CUSTOM_PASSWORD"]),
  metadata: z.object({
    privateKeyPath: z.string().max(4096).optional(),
    agentSocket: z.string().max(4096).optional()
  }),
  secret: z.string().max(16_384).nullable(),
  sudoSecret: z.string().max(16_384).nullable(),
  privateKey: z.string().max(1024 * 1024).nullable()
});
const exportPolicySchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(120),
  document: policyDocumentSchema,
  enabled: z.boolean()
});
const exportHostKeySchema = z.object({
  hostId: uuidSchema,
  algorithm: z.string().min(1).max(32),
  fingerprint: z.string().min(8).max(512)
});
const payloadSchema = z.object({
  kind: z.literal(PAYLOAD_KIND),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string().min(1),
  hosts: z.array(exportHostSchema).max(2_000),
  logins: z.array(exportLoginSchema).max(8_000),
  credentials: z.array(exportCredentialSchema).max(8_000),
  policies: z.array(exportPolicySchema).max(500),
  hostKeys: z.array(exportHostKeySchema).max(2_000)
});
const envelopeSchema = z.object({
  kind: z.literal(EXPORT_KIND),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string().min(1),
  summary: z.object({
    hosts: z.number().int().nonnegative(),
    credentials: z.number().int().nonnegative(),
    policies: z.number().int().nonnegative()
  }),
  kdf: z.object({
    name: z.literal("scrypt"),
    salt: z.string().min(1),
    n: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive()
  }),
  cipher: z.object({
    name: z.literal("aes-256-gcm"),
    iv: z.string().min(1),
    tag: z.string().min(1),
    ciphertext: z.string().min(1)
  })
});

export type ConfigExportDocument = z.infer<typeof envelopeSchema>;
export interface ConfigImportResult {
  hosts: number;
  logins: number;
  credentials: number;
  policies: number;
  hostKeys: number;
  hostIds: string[];
  warnings: string[];
}

interface ExportPayload extends z.infer<typeof payloadSchema> {}
type ExportHost = z.infer<typeof exportHostSchema>;
type ExportCredential = z.infer<typeof exportCredentialSchema>;

export class ConfigTransferService {
  constructor(
    private readonly config: CoreConfig,
    private readonly database: HoplaneDatabase,
    private readonly vault: LocalCredentialVaultManager,
    private readonly policySources: PolicySourceService,
    private readonly readPrivateKey: (path: string) => Promise<string>
  ) {}

  async exportBundle(password: string): Promise<{ filename: string; document: ConfigExportDocument; warnings: string[] }> {
    validateExportPassword(password);
    if (!(await this.vault.getState()).unlocked) throw vaultLocked();
    const warnings: string[] = [];
    const hosts = this.database.listHosts().map(serializeHost);
    const logins = this.database.listHostLogins().map((login) => ({
      id: login.id,
      hostId: login.hostId,
      username: login.username,
      credentialId: login.credentialId,
      sudoEnabled: login.sudoEnabled
    }));
    const credentials: ExportCredential[] = [];
    for (const credential of this.database.listCredentials()) {
      credentials.push(await this.serializeCredential(credential, warnings));
    }
    const policies = this.database.listPolicies().map((policy) => ({
      id: policy.id,
      name: policy.name,
      document: policy.document,
      enabled: policy.enabled
    }));
    const payload: ExportPayload = {
      kind: PAYLOAD_KIND,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      hosts,
      logins,
      credentials,
      policies,
      hostKeys: this.database.listTrustedHostKeys()
    };
    const document = await encryptPayload(payload, password);
    return { filename: exportFilename(document.exportedAt), document, warnings };
  }

  async importBundle(password: string, rawDocument: unknown): Promise<ConfigImportResult> {
    validateExportPassword(password);
    if (!(await this.vault.getState()).unlocked) throw vaultLocked();
    const envelope = parseEnvelope(rawDocument);
    const payload = await decryptPayload(envelope, password);
    const warnings: string[] = [];
    const loginIdMap = new Map<string, string>();
    const policyIdMap = new Map<string, string>();

    for (const policy of payload.policies) {
      const existingById = this.database.getPolicy(policy.id);
      const existingByName = this.database.listPolicies().find((item) => item.name === policy.name);
      const targetId = existingById?.id ?? existingByName?.id ?? policy.id;
      if (this.database.getPolicy(targetId)) {
        this.database.updatePolicy(targetId, policy.name, policy.document as PolicyDocument, { enabled: policy.enabled });
      } else {
        this.database.createPolicy(policy.name, policy.document as PolicyDocument, { id: targetId });
      }
      policyIdMap.set(policy.id, targetId);
    }
    for (const policy of payload.policies) {
      const targetId = policyIdMap.get(policy.id) ?? policy.id;
      try {
        await this.policySources.persistPolicy(targetId);
        if (!policy.enabled) this.database.updatePolicySourceState(targetId, { enabled: false });
      } catch (error) { warnings.push(`策略“${policy.name}”已导入，但未能写入本地 YAML：${errorMessage(error)}`); }
    }

    for (const credential of payload.credentials) {
      warnings.push(...await this.importCredential(credential));
    }

    this.database.transaction(() => {
      for (const host of payload.hosts) {
        this.database.upsertImportedHost({
          ...host,
          policyId: host.policyId ? policyIdMap.get(host.policyId) ?? host.policyId : null,
          jumpHostId: null,
          activeLoginId: null
        });
      }
      for (const login of payload.logins) {
        const result = this.database.upsertImportedLogin(login);
        loginIdMap.set(login.id, result.id);
      }
      for (const host of payload.hosts) {
        this.database.upsertImportedHost({
          ...host,
          policyId: host.policyId ? policyIdMap.get(host.policyId) ?? host.policyId : null,
          jumpHostId: host.jumpHostId,
          activeLoginId: host.activeLoginId ? loginIdMap.get(host.activeLoginId) ?? host.activeLoginId : null
        });
      }
      for (const key of payload.hostKeys) {
        if (this.database.getHost(key.hostId)) this.database.importTrustedHostKey(key.hostId, key.fingerprint, key.algorithm);
      }
    });

    return {
      hosts: payload.hosts.length,
      logins: payload.logins.length,
      credentials: payload.credentials.length,
      policies: payload.policies.length,
      hostKeys: payload.hostKeys.length,
      hostIds: payload.hosts.map((host) => host.id),
      warnings
    };
  }

  private async serializeCredential(credential: Credential, warnings: string[]): Promise<ExportCredential> {
    let secret: string | null = null;
    let sudoSecret: string | null = null;
    let privateKey: string | null = null;
    if (credential.secretRef) {
      try { secret = await this.vault.resolve(credential.secretRef); }
      catch { warnings.push(`凭据“${credential.name}”的保险库密钥无法读取，导出后需要重新填写。`); }
    }
    if (credential.sudoSecretRef) {
      try { sudoSecret = await this.vault.resolve(credential.sudoSecretRef); }
      catch { warnings.push(`凭据“${credential.name}”的 sudo 密码无法读取，导出后需要重新填写。`); }
    }
    if (credential.type === "PRIVATE_KEY" && credential.metadata.privateKeyPath) {
      try { privateKey = await this.readPrivateKey(credential.metadata.privateKeyPath); }
      catch { warnings.push(`凭据“${credential.name}”的私钥文件无法读取，已保留原路径。目标电脑若没有该文件，需要重新指定私钥。`); }
    }
    if (credential.type === "SSH_AGENT") {
      warnings.push(`凭据“${credential.name}”使用 SSH Agent，导入后需要目标电脑上的 Agent 可用。`);
    }
    return {
      id: credential.id,
      name: credential.name,
      type: credential.type,
      sudoMode: credential.sudoMode,
      metadata: credential.metadata,
      secret,
      sudoSecret,
      privateKey
    };
  }

  private async importCredential(credential: ExportCredential): Promise<string[]> {
    const warnings: string[] = [];
    const existing = this.database.getCredential(credential.id);
    let secretRef = existing?.secretRef ?? null;
    let sudoSecretRef = existing?.sudoSecretRef ?? null;
    if (credential.secret !== null) {
      secretRef ??= randomUUID();
      await this.vault.save(secretRef, credential.secret);
    } else if (!secretRef && credential.type === "PASSWORD") {
      warnings.push(`凭据“${credential.name}”没有可导入的登录密码。`);
    }
    if (credential.sudoMode === "CUSTOM_PASSWORD" && credential.sudoSecret !== null) {
      sudoSecretRef ??= randomUUID();
      await this.vault.save(sudoSecretRef, credential.sudoSecret);
    } else if (credential.sudoMode !== "CUSTOM_PASSWORD") {
      sudoSecretRef = null;
    }
    const metadata = { ...credential.metadata };
    if (credential.type === "PRIVATE_KEY" && credential.privateKey) {
      metadata.privateKeyPath = await this.writeImportedPrivateKey(credential.id, credential.privateKey);
    } else if (credential.type === "PRIVATE_KEY" && !metadata.privateKeyPath) {
      warnings.push(`凭据“${credential.name}”没有私钥内容和路径，导入后需要重新指定私钥。`);
    }
    this.database.upsertImportedCredential({
      id: credential.id,
      name: credential.name,
      type: credential.type as CredentialType,
      secretRef,
      sudoMode: credential.sudoMode as SudoAuthMode,
      sudoSecretRef,
      metadata
    });
    return warnings;
  }

  private async writeImportedPrivateKey(credentialId: string, contents: string): Promise<string> {
    const directory = join(this.config.dataDir, "imported-keys");
    await ensurePrivateDirectory(directory);
    const path = join(directory, `${credentialId}.key`);
    await writeFile(path, contents, { mode: 0o600 });
    await chmod(path, 0o600);
    return path;
  }
}

export function parseEnvelope(value: unknown): ConfigExportDocument {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) throw new AppError("CONFIG_EXPORT_INVALID", "This file is not a valid Hoplane configuration export", false, undefined, undefined, 400);
  return parsed.data;
}

export function exportFilename(exportedAt: string): string {
  const day = exportedAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
  return `hoplane-config-${day}.hoplane`;
}

function serializeHost(host: Host): ExportHost {
  return {
    id: host.id,
    name: host.name,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    credentialId: host.credentialId,
    activeLoginId: host.activeLoginId,
    jumpHostId: host.jumpHostId,
    policyId: host.policyId,
    groupName: host.groupName,
    tags: host.tags,
    defaultDirectory: host.defaultDirectory,
    enabled: host.enabled,
    aiAccessEnabled: host.aiAccessEnabled,
    hostTransferEnabled: host.hostTransferEnabled,
    monitorOutputEnabled: host.monitorOutputEnabled,
    proxyEnabled: host.proxyEnabled,
    proxyLocalHost: host.proxyLocalHost,
    proxyLocalPort: host.proxyLocalPort,
    proxyRemotePort: host.proxyRemotePort
  };
}

async function encryptPayload(payload: ExportPayload, password: string): Promise<ConfigExportDocument> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  const iv = randomBytes(12);
  const cleartext = Buffer.from(JSON.stringify(payload), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
    return {
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      exportedAt: payload.exportedAt,
      summary: {
        hosts: payload.hosts.length,
        credentials: payload.credentials.length,
        policies: payload.policies.length
      },
      kdf: { name: "scrypt", salt: salt.toString("base64"), n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      cipher: {
        name: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
      }
    };
  } finally {
    key.fill(0);
    cleartext.fill(0);
  }
}

async function decryptPayload(envelope: ConfigExportDocument, password: string): Promise<ExportPayload> {
  if (envelope.kdf.n > SCRYPT_N || envelope.kdf.r > 32 || envelope.kdf.p > 8) {
    throw new AppError("CONFIG_EXPORT_UNSUPPORTED", "This configuration export uses unsupported encryption parameters", false, undefined, undefined, 409);
  }
  const key = await deriveKey(password, Buffer.from(envelope.kdf.salt, "base64"), envelope.kdf.n, envelope.kdf.r, envelope.kdf.p);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.cipher.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.cipher.tag, "base64"));
    const cleartext = Buffer.concat([
      decipher.update(Buffer.from(envelope.cipher.ciphertext, "base64")),
      decipher.final()
    ]);
    try {
      const parsed = payloadSchema.safeParse(JSON.parse(cleartext.toString("utf8")));
      if (!parsed.success) throw new AppError("CONFIG_EXPORT_INVALID", "The decrypted configuration export is invalid", false, undefined, undefined, 400);
      return parsed.data;
    } finally {
      cleartext.fill(0);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("CONFIG_EXPORT_UNLOCK_FAILED", "Incorrect export password or damaged configuration file", false, undefined, undefined, 403);
  } finally {
    key.fill(0);
  }
}

function deriveKey(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) => {
    if (error) reject(new AppError("CONFIG_EXPORT_KDF_FAILED", "Could not derive the configuration export key"));
    else resolve(key as Buffer);
  }));
}

function validateExportPassword(password: string): void {
  if (password.length < 10 || password.length > 1024) {
    throw new AppError("CONFIG_EXPORT_PASSWORD_INVALID", "Export password must contain 10 to 1024 characters", false, undefined, undefined, 400);
  }
}

function vaultLocked(): AppError {
  return new AppError("VAULT_LOCKED", "Local vault is locked", false, undefined, undefined, 423);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
