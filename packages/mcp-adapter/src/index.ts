#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CoreApiClient } from "../../shared/src/index.js";
import { createHoplaneMcpServer, type HoplaneMcpBackend } from "./server-factory.js";

const client = new CoreApiClient(true);
const backend: HoplaneMcpBackend = {
  listHosts: () => client.request("GET", "/v1/hosts?aiOnly=true"),
  testHost: (hostId) => client.request("POST", `/v1/hosts/${hostId}/test`, { clientType: "MCP", clientId: "mcp-stdio" }),
  executeCommand: (input) => client.request("POST", "/v1/operations/execute", { ...input, clientType: "MCP", clientId: "mcp-stdio" }),
  uploadFile: (input) => client.request("POST", "/v1/operations/upload", { ...input, clientType: "MCP", clientId: "mcp-stdio" }),
  downloadFile: (input) => client.request("POST", "/v1/operations/download", { ...input, clientType: "MCP", clientId: "mcp-stdio" })
};
const server = createHoplaneMcpServer(backend);

await server.connect(new StdioServerTransport());
