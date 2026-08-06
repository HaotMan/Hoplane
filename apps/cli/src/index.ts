#!/usr/bin/env node
import { CoreApiClient, AppError } from "../../../packages/shared/src/index.js";

const client = new CoreApiClient(true);
const args = process.argv.slice(2);

try {
  const result = await run(args);
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected error");
  process.stderr.write(`${JSON.stringify(appError.toJSON(), null, 2)}\n`);
  process.exitCode = 1;
}

async function run(argv: string[]): Promise<unknown> {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return usage();
  if (command === "core" && subcommand === "status") return client.request("GET", "/health");
  if (command === "host" && subcommand === "list") return client.request("GET", "/v1/hosts");
  if (command === "host" && subcommand === "test") {
    const hostId = required(rest[0], "host id");
    return client.request("POST", `/v1/hosts/${hostId}/test`, { clientType: "CLI", clientId: "aiterm" });
  }
  if (command === "exec") {
    const hostId = required(subcommand, "host id");
    const separator = rest.indexOf("--");
    const optionArgs = separator >= 0 ? rest.slice(0, separator) : [];
    const commandArgs = separator >= 0 ? rest.slice(separator + 1) : rest;
    const remoteCommand = commandArgs.join(" ").trim();
    if (!remoteCommand) throw new AppError("INVALID_ARGUMENT", "A remote command is required after --");
    return client.request("POST", "/v1/operations/execute", {
      hostId, command: remoteCommand, directory: option(optionArgs, "--directory"),
      timeoutMs: Number(option(optionArgs, "--timeout") ?? 30_000), clientType: "CLI", clientId: "aiterm"
    });
  }
  if (command === "upload") {
    return client.request("POST", "/v1/operations/upload", {
      hostId: required(subcommand, "host id"), localPath: required(rest[0], "local path"), remotePath: required(rest[1], "remote path"),
      clientType: "CLI", clientId: "aiterm"
    });
  }
  if (command === "download") {
    return client.request("POST", "/v1/operations/download", {
      hostId: required(subcommand, "host id"), remotePath: required(rest[0], "remote path"), localPath: required(rest[1], "local path"),
      clientType: "CLI", clientId: "aiterm"
    });
  }
  if (command === "transfer") {
    return client.request("POST", "/v1/operations/transfer", {
      sourceHostId: required(subcommand, "source host id"), sourcePath: required(rest[0], "source path"),
      destinationHostId: required(rest[1], "destination host id"), destinationPath: required(rest[2], "destination path"),
      clientType: "CLI", clientId: "aiterm"
    });
  }
  throw new AppError("INVALID_ARGUMENT", `Unknown command: ${argv.join(" ")}`);
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new AppError("INVALID_ARGUMENT", `Missing ${label}`);
  return value;
}

function option(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function usage(): { usage: string[] } {
  return { usage: [
    "aiterm core status",
    "aiterm host list",
    "aiterm host test <host-id>",
    "aiterm exec <host-id> [--directory /path] [--timeout 30000] -- <command>",
    "aiterm upload <host-id> <local-path> <remote-path>",
    "aiterm download <host-id> <remote-path> <local-path>",
    "aiterm transfer <source-host-id> <source-path> <destination-host-id> <destination-path>"
  ] };
}
