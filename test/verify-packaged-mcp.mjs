import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, entry] = process.argv.slice(2);
if (!command || !entry) throw new Error("Usage: node test/verify-packaged-mcp.mjs <runtime-command> <adapter-entry>");

const transport = new StdioClientTransport({
  command,
  args: [entry],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stderr: "pipe"
});
const client = new Client({ name: "hoplane-package-verifier", version: "0.1.0" });
try {
  await client.connect(transport);
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name);
  const expected = ["list_hosts", "test_host", "execute_command", "upload_file", "download_file"];
  if (!expected.every((name) => names.includes(name))) throw new Error(`Missing tools: ${expected.filter((name) => !names.includes(name)).join(", ")}`);
  process.stdout.write(`${JSON.stringify({ ok: true, tools: names })}\n`);
} finally {
  await client.close();
}
