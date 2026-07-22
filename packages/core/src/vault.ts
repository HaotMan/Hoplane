import { AppError } from "../../shared/src/index.js";

export interface CredentialVault {
  save(reference: string, secret: string): Promise<void>;
  resolve(reference: string): Promise<string>;
  delete(reference: string): Promise<void>;
}

export class MemoryVault implements CredentialVault {
  private readonly secrets = new Map<string, string>();
  async save(reference: string, secret: string): Promise<void> { this.secrets.set(reference, secret); }
  async resolve(reference: string): Promise<string> {
    const value = this.secrets.get(reference);
    if (value === undefined) throw new AppError("CREDENTIAL_NOT_FOUND", "Credential secret not found", false, undefined, undefined, 404);
    return value;
  }
  async delete(reference: string): Promise<void> { this.secrets.delete(reference); }
}
