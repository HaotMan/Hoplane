import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppError } from "../../shared/src/index.js";

export interface HoplaneMcpBackend {
  listHosts(): Promise<unknown>;
  testHost(hostId: string): Promise<unknown>;
  executeCommand(input: { hostId: string; command: string; directory?: string; timeoutMs: number }): Promise<unknown>;
  uploadFile(input: { hostId: string; localPath: string; remotePath: string }): Promise<unknown>;
  downloadFile(input: { hostId: string; remotePath: string; localPath: string }): Promise<unknown>;
  transferFile(input: { sourceHostId: string; sourcePath: string; destinationHostId: string; destinationPath: string }): Promise<unknown>;
}

export function createHoplaneMcpServer(backend: HoplaneMcpBackend): McpServer {
  const server = new McpServer({ name: "hoplane", version: "0.1.2" });

  server.registerTool("list_hosts", {
    title: "List SSH hosts",
    description: "List SSH hosts explicitly enabled for AI access. Credentials are never returned. Each host includes a `sudo` field: when `sudo.available` is true you can run privileged commands with a leading `sudo` (Hoplane handles authentication automatically).",
    inputSchema: {}
  }, async () => toolCall(() => backend.listHosts()));

  server.registerTool("test_host", {
    title: "Test SSH host",
    description: "Test connectivity to one AI-enabled SSH host. New or changed host keys require user confirmation in the UI.",
    inputSchema: { host_id: z.string().uuid() }
  }, async ({ host_id }) => toolCall(() => backend.testHost(host_id)));

  server.registerTool("execute_command", {
    title: "Execute remote command",
    description: "Execute a policy-approved, non-interactive command on a specific SSH host. sudo IS supported when the host's `sudo.available` (from list_hosts) is true: just use `sudo` anywhere in the command, including several chained invocations (e.g. `sudo apt-get update && sudo apt-get install -y nginx`) — Hoplane authenticates every sudo invocation automatically, so never ask the user for a password, never embed one in the command, and never use workarounds like `su` or permission changes. If `sudo.available` is false, sudo commands are rejected; ask the user to enable sudo in the Hoplane app instead.",
    inputSchema: {
      host_id: z.string().uuid(), command: z.string().min(1).max(32_768), directory: z.string().max(4096).optional(),
      timeout_ms: z.number().int().min(100).max(300_000).default(30_000)
    }
  }, async ({ host_id, command, directory, timeout_ms }) => toolCall(() => backend.executeCommand({
    hostId: host_id, command, directory, timeoutMs: timeout_ms
  })));

  server.registerTool("upload_file", {
    title: "Upload file",
    description: "Upload one local file to a policy-approved remote path.",
    inputSchema: { host_id: z.string().uuid(), local_path: z.string().min(1).max(4096), remote_path: z.string().min(1).max(4096) }
  }, async ({ host_id, local_path, remote_path }) => toolCall(() => backend.uploadFile({
    hostId: host_id, localPath: local_path, remotePath: remote_path
  })));

  server.registerTool("download_file", {
    title: "Download file",
    description: "Download one remote file to a policy-approved local path.",
    inputSchema: { host_id: z.string().uuid(), remote_path: z.string().min(1).max(4096), local_path: z.string().min(1).max(4096) }
  }, async ({ host_id, remote_path, local_path }) => toolCall(() => backend.downloadFile({
    hostId: host_id, localPath: local_path, remotePath: remote_path
  })));

  server.registerTool("transfer_file", {
    title: "Transfer file between SSH hosts",
    description: "Stream one regular file from an AI-enabled source host to an AI-enabled destination host through Hoplane. Both hosts must have their host-level file transfer switch enabled and advertise transfer_source / transfer_destination; policy file constraints still apply. SFTP is preferred, with a fixed POSIX SSH exec stream used only when the SFTP subsystem is unavailable. The hosts do not need direct connectivity and file contents are not returned.",
    inputSchema: {
      source_host_id: z.string().uuid(), source_path: z.string().min(1).max(4096),
      destination_host_id: z.string().uuid(), destination_path: z.string().min(1).max(4096)
    }
  }, async ({ source_host_id, source_path, destination_host_id, destination_path }) => toolCall(() => backend.transferFile({
    sourceHostId: source_host_id,
    sourcePath: source_path,
    destinationHostId: destination_host_id,
    destinationPath: destination_path
  })));

  return server;
}

async function toolCall(action: () => Promise<unknown>) {
  try {
    const result = await action();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected error");
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(appError.toJSON(), null, 2) }] };
  }
}
