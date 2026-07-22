import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HoplaneDatabase } from "../packages/core/src/database.js";
import { McpServiceManager } from "../packages/core/src/mcp-service.js";
import { MemoryVault } from "../packages/core/src/vault.js";
import type { CoreConfig } from "../packages/core/src/config.js";
import type { OperationService } from "../packages/core/src/operation-service.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

describe("MCP Streamable HTTP", () => {
  it("requires a token and exposes the shared Hoplane tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoplane-mcp-test-")); dirs.push(dir);
    const database = new HoplaneDatabase(join(dir, "test.sqlite3"));
    let manager: McpServiceManager;
    const httpServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const parsedBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown : undefined;
      await manager.handle(request, response, parsedBody);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const config: CoreConfig = {
      dataDir: dir, databasePath: join(dir, "test.sqlite3"), tokenPath: join(dir, "core.token"),
      pidPath: join(dir, "core.pid"), logPath: join(dir, "core.log"), vaultPath: join(dir, "vault.enc"), policyDir: join(dir, "policies"), host: "127.0.0.1", port, outputLimitBytes: 1024
    };
    const operations = {
      listHosts: () => [],
      testHost: async () => ({}), executeCommand: async () => ({}), uploadFile: async () => ({}), downloadFile: async () => ({})
    } as unknown as OperationService;
    manager = new McpServiceManager(config, database, new MemoryVault(), operations);

    try {
      const state = await manager.setEnabled(true);
      const unauthorized = await fetch(state.endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });
      expect(unauthorized.status).toBe(401);

      const transport = new StreamableHTTPClientTransport(new URL(state.endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${state.token}` } }
      });
      const client = new Client({ name: "hoplane-test", version: "1.0.0" });
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "list_hosts", "test_host", "execute_command", "upload_file", "download_file"
      ]);
      await client.close();
    } finally {
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeAllConnections();
      await closed;
      database.close();
    }
  });
});
