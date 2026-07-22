import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export interface CoreConfig {
  dataDir: string;
  databasePath: string;
  tokenPath: string;
  pidPath: string;
  logPath: string;
  vaultPath: string;
  policyDir: string;
  host: string;
  port: number;
  outputLimitBytes: number;
}

export function loadConfig(): CoreConfig {
  const dataDir = process.env.HOPLANE_DATA_DIR ?? join(homedir(), ".hoplane");
  return {
    dataDir,
    databasePath: join(dataDir, "hoplane.sqlite3"),
    tokenPath: join(dataDir, "core.token"),
    pidPath: join(dataDir, "core.pid"),
    logPath: join(dataDir, "core.log"),
    vaultPath: join(dataDir, "vault.enc"),
    policyDir: join(dataDir, "policies"),
    host: "127.0.0.1",
    port: Number(process.env.HOPLANE_CORE_PORT ?? 21722),
    outputLimitBytes: Number(process.env.HOPLANE_OUTPUT_LIMIT_BYTES ?? 1024 * 1024)
  };
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function getOrCreateCoreToken(config: CoreConfig): Promise<string> {
  await ensurePrivateDirectory(dirname(config.tokenPath));
  try {
    return (await readFile(config.tokenPath, "utf8")).trim();
  } catch {
    const token = randomBytes(32).toString("base64url");
    await writeFile(config.tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await chmod(config.tokenPath, 0o600);
    return (await readFile(config.tokenPath, "utf8")).trim();
  }
}
