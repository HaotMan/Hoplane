import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "../../shared/src/index.js";
import type { CredentialVault } from "./vault.js";

const VERSION = 1;
const KEY_BYTES = 32;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MAX_MEMORY = 256 * 1024 * 1024;
const AAD = Buffer.from("hoplane-local-vault-v1", "utf8");
const TRANSIENT_AAD = "hoplane-monitor-output-v1";

interface VaultEnvelope {
  version: 1;
  kdf: { name: "scrypt"; salt: string; n: number; r: number; p: number };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string; ciphertext: string };
}

export class LocalEncryptedVault implements CredentialVault {
  private key: Buffer | null = null;
  private secrets = new Map<string, string>();
  private envelope: VaultEnvelope | null = null;

  constructor(readonly path: string) {}

  async isInitialized(): Promise<boolean> {
    try { await readFile(this.path); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw localVaultError("VAULT_READ_FAILED", "Local vault could not be read", error);
    }
  }

  isUnlocked(): boolean { return this.key !== null; }

  async setup(password: string): Promise<void> {
    validatePassword(password);
    if (await this.isInitialized()) throw new AppError("VAULT_ALREADY_INITIALIZED", "Local vault is already initialized", false, undefined, undefined, 409);
    const salt = randomBytes(16);
    this.key = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
    this.secrets.clear();
    this.envelope = emptyEnvelope(salt);
    try { await this.persist(); }
    catch (error) { this.lock(); throw error; }
  }

  async unlock(password: string): Promise<void> {
    if (!await this.isInitialized()) throw new AppError("VAULT_NOT_INITIALIZED", "Local vault has not been initialized", false, undefined, undefined, 409);
    let envelope: VaultEnvelope;
    try { envelope = validateEnvelope(JSON.parse(await readFile(this.path, "utf8")) as unknown); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw localVaultError("VAULT_READ_FAILED", "Local vault file is invalid or unreadable", error);
    }
    const salt = Buffer.from(envelope.kdf.salt, "base64");
    const key = await deriveKey(password, salt, envelope.kdf.n, envelope.kdf.r, envelope.kdf.p);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.cipher.iv, "base64"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.cipher.tag, "base64"));
      const cleartext = Buffer.concat([decipher.update(Buffer.from(envelope.cipher.ciphertext, "base64")), decipher.final()]);
      const parsed = JSON.parse(cleartext.toString("utf8")) as { secrets?: Record<string, unknown> };
      if (!parsed.secrets || Object.values(parsed.secrets).some((value) => typeof value !== "string")) throw new Error("Invalid vault contents");
      this.key?.fill(0);
      this.key = key;
      this.secrets = new Map(Object.entries(parsed.secrets) as Array<[string, string]>);
      this.envelope = envelope;
      cleartext.fill(0);
    } catch {
      key.fill(0);
      throw new AppError("VAULT_UNLOCK_FAILED", "Incorrect master password or damaged local vault", false, undefined, undefined, 403);
    }
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.secrets.clear();
    this.envelope = null;
  }

  async save(reference: string, secret: string): Promise<void> {
    this.requireUnlocked();
    const existed = this.secrets.has(reference);
    const previous = this.secrets.get(reference);
    this.secrets.set(reference, secret);
    try { await this.persist(); }
    catch (error) {
      if (existed) this.secrets.set(reference, previous!); else this.secrets.delete(reference);
      throw error;
    }
  }

  async resolve(reference: string): Promise<string> {
    this.requireUnlocked();
    const secret = this.secrets.get(reference);
    if (secret === undefined) throw new AppError("CREDENTIAL_NOT_FOUND", "Credential secret not found in local vault", false, undefined, undefined, 404);
    return secret;
  }

  async delete(reference: string): Promise<void> {
    this.requireUnlocked();
    if (!this.secrets.has(reference)) return;
    const previous = this.secrets.get(reference)!;
    this.secrets.delete(reference);
    try { await this.persist(); }
    catch (error) { this.secrets.set(reference, previous); throw error; }
  }

  encryptTransient(cleartext: string, context: string): string {
    this.requireUnlocked();
    const iv = randomBytes(12);
    const input = Buffer.from(cleartext, "utf8");
    const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
    cipher.setAAD(transientAad(context));
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    input.fill(0);
    return JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    });
  }

  decryptTransient(serialized: string, context: string): string {
    this.requireUnlocked();
    try {
      const value = JSON.parse(serialized) as { version?: unknown; iv?: unknown; tag?: unknown; ciphertext?: unknown };
      if (value.version !== 1 || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") throw new Error("Invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.key!, Buffer.from(value.iv, "base64"));
      decipher.setAAD(transientAad(context));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      const cleartext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
      const result = cleartext.toString("utf8");
      cleartext.fill(0);
      return result;
    } catch (error) {
      if (error instanceof AppError && error.code === "VAULT_LOCKED") throw error;
      throw new AppError("MONITOR_OUTPUT_DECRYPT_FAILED", "Encrypted terminal output could not be decrypted");
    }
  }

  private requireUnlocked(): void {
    if (!this.key || !this.envelope) throw new AppError("VAULT_LOCKED", "Local vault is locked", false, undefined, undefined, 423);
  }

  private async persist(): Promise<void> {
    this.requireUnlocked();
    const iv = randomBytes(12);
    const cleartext = Buffer.from(JSON.stringify({ secrets: Object.fromEntries(this.secrets) }), "utf8");
    const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
    cleartext.fill(0);
    const envelope: VaultEnvelope = {
      version: VERSION,
      kdf: this.envelope!.kdf,
      cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }
    };
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      this.envelope = envelope;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw localVaultError("VAULT_WRITE_FAILED", "Local vault could not be saved", error);
    }
  }
}

function transientAad(context: string): Buffer {
  return Buffer.from(`${TRANSIENT_AAD}\0${context}`, "utf8");
}

function emptyEnvelope(salt: Buffer): VaultEnvelope {
  return {
    version: VERSION,
    kdf: { name: "scrypt", salt: salt.toString("base64"), n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    cipher: { name: "aes-256-gcm", iv: "", tag: "", ciphertext: "" }
  };
}

function validateEnvelope(value: unknown): VaultEnvelope {
  const envelope = value as Partial<VaultEnvelope>;
  if (envelope.version !== VERSION || envelope.kdf?.name !== "scrypt" || envelope.cipher?.name !== "aes-256-gcm" ||
      typeof envelope.kdf.salt !== "string" || typeof envelope.kdf.n !== "number" || typeof envelope.kdf.r !== "number" || typeof envelope.kdf.p !== "number" ||
      typeof envelope.cipher.iv !== "string" || typeof envelope.cipher.tag !== "string" || typeof envelope.cipher.ciphertext !== "string") {
    throw new AppError("VAULT_FORMAT_UNSUPPORTED", "Local vault format is invalid or unsupported", false, undefined, undefined, 409);
  }
  if (envelope.kdf.n > SCRYPT_N || envelope.kdf.r > 32 || envelope.kdf.p > 8) throw new AppError("VAULT_KDF_UNSUPPORTED", "Local vault KDF parameters are unsupported");
  return envelope as VaultEnvelope;
}

function validatePassword(password: string): void {
  if (password.length < 10 || password.length > 1024) throw new AppError("VAULT_PASSWORD_INVALID", "Master password must contain 10 to 1024 characters");
}

function deriveKey(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) => {
    if (error) reject(localVaultError("VAULT_KDF_FAILED", "Could not derive the local vault key", error));
    else resolve(key as Buffer);
  }));
}

function localVaultError(code: string, message: string, error: unknown): AppError {
  return new AppError(code, `${message}: ${error instanceof Error ? error.message : "Unknown error"}`);
}
