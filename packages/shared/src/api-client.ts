import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
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
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const result = await requestJson(
      method,
      `http://${this.config.host}:${this.config.port}${path}`,
      {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body
    );
    if (result.status < 200 || result.status >= 300) {
      throw new AppError(String(result.json.code ?? "CORE_ERROR"), String(result.json.message ?? "Core request failed"), Boolean(result.json.retriable), result.json.operationId ? String(result.json.operationId) : undefined, result.json.details as Record<string, unknown> | undefined, result.status);
    }
    return result.json as T;
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

/** Node fetch/undici waits only 300s for response headers; SFTP uploads hold the request open longer. */
function requestJson(method: string, href: string, headers: Record<string, string>, body?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = new URL(href);
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
      response.on("end", () => {
        try {
          resolveRequest({
            status: response.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
          });
        } catch {
          reject(new AppError("CORE_UNAVAILABLE", "Core returned an invalid JSON response", true, undefined, undefined, 502));
        }
      });
    });
    request.on("error", () => {
      reject(new AppError("CORE_UNAVAILABLE", "Could not connect to Hoplane Core", true, undefined, undefined, 503));
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}
