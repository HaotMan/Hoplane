import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../core/src/config.js";
import { AppError } from "./errors.js";

export class CoreApiClient {
  private readonly config = loadConfig();

  constructor(private readonly autoStart = true) {}

  async request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    if (this.autoStart) await this.ensureRunning();
    let token: string;
    try { token = (await readFile(this.config.tokenPath, "utf8")).trim(); }
    catch { throw new AppError("CORE_UNAVAILABLE", "Core token is unavailable. Start Hoplane Core first.", true, undefined, undefined, 503); }
    let response: Response;
    try {
      response = await fetch(`http://${this.config.host}:${this.config.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
      });
    } catch {
      throw new AppError("CORE_UNAVAILABLE", "Could not connect to Hoplane Core", true, undefined, undefined, 503);
    }
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      throw new AppError(String(result.code ?? "CORE_ERROR"), String(result.message ?? "Core request failed"), Boolean(result.retriable), result.operationId ? String(result.operationId) : undefined, result.details as Record<string, unknown> | undefined, response.status);
    }
    return result as T;
  }

  private async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) return;
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const serverPath = resolve(currentDir, "../../core/src/server.js");
    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      if (await this.isHealthy()) return;
    }
    throw new AppError("CORE_UNAVAILABLE", "Hoplane Core did not start", true, undefined, { serverPath }, 503);
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`http://${this.config.host}:${this.config.port}/health`, { signal: AbortSignal.timeout(300) });
      return response.ok;
    } catch { return false; }
  }
}
