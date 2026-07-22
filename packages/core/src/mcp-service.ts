import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHoplaneMcpServer, type HoplaneMcpBackend } from "../../mcp-adapter/src/server-factory.js";
import type { CoreConfig } from "./config.js";
import type { HoplaneDatabase } from "./database.js";
import type { OperationService } from "./operation-service.js";
import type { CredentialVault } from "./vault.js";
import { AppError } from "../../shared/src/index.js";

const ENABLED_SETTING = "mcp.enabled";
const TOKEN_REF_SETTING = "mcp.tokenRef";

export interface McpServiceState {
  enabled: boolean;
  endpoint: string;
  token: string | null;
  transport: "streamable-http";
  vaultLocked: boolean;
}

export class McpServiceManager {
  private tokenCache: string | null = null;
  private readonly backend: HoplaneMcpBackend;

  constructor(
    private readonly config: CoreConfig,
    private readonly database: HoplaneDatabase,
    private readonly vault: CredentialVault,
    operations: OperationService
  ) {
    const clientId = "mcp-http";
    this.backend = {
      listHosts: async () => operations.listHosts(true),
      testHost: (hostId) => operations.testHost(hostId, "MCP", clientId),
      executeCommand: (input) => operations.executeCommand({ ...input, clientType: "MCP", clientId }),
      uploadFile: (input) => operations.uploadFile({ ...input, clientType: "MCP", clientId }),
      downloadFile: (input) => operations.downloadFile({ ...input, clientType: "MCP", clientId })
    };
  }

  async getState(): Promise<McpServiceState> {
    let token: string | null = null;
    let vaultLocked = false;
    try { token = await this.ensureToken(); }
    catch (error) {
      if (error instanceof AppError && ["VAULT_LOCKED", "VAULT_NOT_INITIALIZED"].includes(error.code)) vaultLocked = true;
      else throw error;
    }
    return {
      enabled: this.database.getSetting(ENABLED_SETTING, false),
      endpoint: `http://${this.config.host}:${this.config.port}/mcp`,
      token,
      transport: "streamable-http",
      vaultLocked
    };
  }

  isEnabled(): boolean {
    return this.database.getSetting(ENABLED_SETTING, false);
  }

  async setEnabled(enabled: boolean): Promise<McpServiceState> {
    await this.ensureToken();
    this.database.setSetting(ENABLED_SETTING, enabled);
    return this.getState();
  }

  async regenerateToken(): Promise<McpServiceState> {
    const reference = this.ensureTokenReference();
    const token = generateToken();
    await this.vault.save(reference, token);
    this.tokenCache = token;
    return this.getState();
  }

  clearTokenCache(): void { this.tokenCache = null; }

  async handle(request: IncomingMessage, response: ServerResponse, parsedBody?: unknown): Promise<void> {
    if (!this.database.getSetting(ENABLED_SETTING, false)) {
      return jsonRpcError(response, 503, -32001, "Hoplane MCP service is disabled. Enable it in the app first.");
    }
    if (!this.isAllowedHost(request.headers.host)) {
      return jsonRpcError(response, 403, -32002, "Invalid Host header");
    }
    const providedToken = request.headers.authorization?.replace(/^Bearer\s+/iu, "");
    let expectedToken: string;
    try { expectedToken = await this.ensureToken(); }
    catch (error) {
      if (error instanceof AppError && ["VAULT_LOCKED", "VAULT_NOT_INITIALIZED"].includes(error.code)) {
        return jsonRpcError(response, 423, -32004, "Hoplane local vault is locked. Unlock it in the app first.");
      }
      throw error;
    }
    if (!providedToken || !equalSecret(providedToken, expectedToken)) {
      response.setHeader("www-authenticate", "Bearer");
      return jsonRpcError(response, 401, -32003, "Invalid MCP access token");
    }

    const mcpServer = createHoplaneMcpServer(this.backend);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void transport.close();
      void mcpServer.close();
    };
    response.once("close", close);
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      close();
      if (!response.headersSent) {
        jsonRpcError(response, 500, -32603, error instanceof Error ? error.message : "Internal MCP error");
      }
    }
  }

  private isAllowedHost(value: string | undefined): boolean {
    return value === `${this.config.host}:${this.config.port}` || value === `localhost:${this.config.port}`;
  }

  private ensureTokenReference(): string {
    let reference = this.database.getSetting(TOKEN_REF_SETTING, "");
    if (!reference) {
      reference = `mcp-${randomUUID()}`;
      this.database.setSetting(TOKEN_REF_SETTING, reference);
    }
    return reference;
  }

  private async ensureToken(): Promise<string> {
    if (this.tokenCache) return this.tokenCache;
    const reference = this.ensureTokenReference();
    try {
      this.tokenCache = await this.vault.resolve(reference);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CREDENTIAL_NOT_FOUND") throw error;
      this.tokenCache = generateToken();
      await this.vault.save(reference, this.tokenCache);
    }
    return this.tokenCache;
  }
}

function generateToken(): string {
  return `hpl_${randomBytes(32).toString("base64url")}`;
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  if (response.headersSent) return;
  const content = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(content) });
  response.end(content);
}
