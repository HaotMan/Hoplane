import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalEncryptedVault } from "../packages/core/src/local-vault.js";
import { LocalCredentialVaultManager } from "../packages/core/src/vault-manager.js";
import type { CoreConfig } from "../packages/core/src/config.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hoplane-vault-test-")); dirs.push(dir);
  const config: CoreConfig = {
    dataDir: dir, databasePath: join(dir, "test.sqlite3"), tokenPath: join(dir, "core.token"), pidPath: join(dir, "core.pid"),
    logPath: join(dir, "core.log"), vaultPath: join(dir, "vault.enc"), policyDir: join(dir, "policies"), host: "127.0.0.1", port: 21722, outputLimitBytes: 1024
  };
  return { dir, config };
}

describe("LocalEncryptedVault", () => {
  it("encrypts secrets at rest and requires the master password after locking", async () => {
    const { config } = await fixture();
    const vault = new LocalEncryptedVault(config.vaultPath);
    await vault.setup("correct horse battery staple");
    await vault.save("credential-1", "top-secret-password");
    expect(await vault.resolve("credential-1")).toBe("top-secret-password");
    const encryptedOutput = vault.encryptTransient("database password=secret", "host:operation:1:STDOUT");
    expect(encryptedOutput).not.toContain("database password=secret");
    expect(vault.decryptTransient(encryptedOutput, "host:operation:1:STDOUT")).toBe("database password=secret");
    expect(await readFile(config.vaultPath, "utf8")).not.toContain("top-secret-password");
    vault.lock();
    expect(() => vault.decryptTransient(encryptedOutput, "host:operation:1:STDOUT")).toThrowError(/locked/u);
    await expect(vault.resolve("credential-1")).rejects.toMatchObject({ code: "VAULT_LOCKED" });
    await expect(vault.unlock("incorrect password")).rejects.toMatchObject({ code: "VAULT_UNLOCK_FAILED" });
    await vault.unlock("correct horse battery staple");
    expect(await vault.resolve("credential-1")).toBe("top-secret-password");
  });

  it("uses only the local encrypted backend", async () => {
    const { config } = await fixture();
    const local = new LocalEncryptedVault(config.vaultPath);
    const manager = new LocalCredentialVaultManager(config, local);

    await manager.setupLocal("correct horse battery staple");
    await manager.save("secret-ref", "server-password");
    expect(await manager.resolve("secret-ref")).toBe("server-password");
    await manager.lockLocal();
    await expect(manager.resolve("secret-ref")).rejects.toMatchObject({ code: "VAULT_LOCKED" });
  });

  it("reauthenticates before revealing without replacing the unlocked vault", async () => {
    const { config } = await fixture();
    const manager = new LocalCredentialVaultManager(config);
    await manager.setupLocal("correct horse battery staple");
    await manager.save("secret-ref", "server-password");

    await expect(manager.verifyLocalPassword("incorrect password")).rejects.toMatchObject({ code: "VAULT_UNLOCK_FAILED" });
    expect((await manager.getState()).unlocked).toBe(true);
    await manager.verifyLocalPassword("correct horse battery staple");
    expect(await manager.resolve("secret-ref")).toBe("server-password");
  });
});
