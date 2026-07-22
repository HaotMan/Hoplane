import type { CoreConfig } from "./config.js";
import { AppError } from "../../shared/src/index.js";
import { LocalEncryptedVault } from "./local-vault.js";
import type { CredentialVault } from "./vault.js";

export interface VaultState {
  localInitialized: boolean;
  unlocked: boolean;
}

export class LocalCredentialVaultManager implements CredentialVault {
  readonly local: LocalEncryptedVault;

  constructor(
    config: CoreConfig,
    localVault: LocalEncryptedVault = new LocalEncryptedVault(config.vaultPath)
  ) {
    this.local = localVault;
  }

  async getState(): Promise<VaultState> {
    return {
      localInitialized: await this.local.isInitialized(),
      unlocked: this.local.isUnlocked()
    };
  }

  async setupLocal(password: string): Promise<VaultState> {
    await this.local.setup(password);
    return this.getState();
  }

  async unlockLocal(password: string): Promise<VaultState> {
    await this.local.unlock(password);
    return this.getState();
  }

  async verifyLocalPassword(password: string): Promise<void> {
    if (!this.local.isUnlocked()) {
      throw new AppError("VAULT_LOCKED", "Local vault is locked", false, undefined, undefined, 423);
    }
    const verifier = new LocalEncryptedVault(this.local.path);
    try { await verifier.unlock(password); }
    finally { verifier.lock(); }
  }

  lockLocal(): VaultState | Promise<VaultState> {
    this.local.lock();
    return this.getState();
  }

  save(reference: string, secret: string): Promise<void> { return this.local.save(reference, secret); }
  resolve(reference: string): Promise<string> { return this.local.resolve(reference); }
  delete(reference: string): Promise<void> { return this.local.delete(reference); }
}
