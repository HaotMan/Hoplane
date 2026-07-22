#!/usr/bin/env node
import { CoreApiClient } from "../../shared/src/index.js";

const client = new CoreApiClient(true);
try {
  const [vault, hosts] = await Promise.all([
    client.request<{ localInitialized: boolean; unlocked: boolean }>("GET", "/v1/vault-settings"),
    client.request<Array<{ id: string; name: string }>>("GET", "/v1/hosts?aiOnly=true")
  ]);
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    runtime: process.execPath,
    core: "reachable",
    vault: vault.unlocked ? "unlocked" : vault.localInitialized ? "locked" : "not-initialized",
    aiHosts: hosts.map((host) => ({ id: host.id, name: host.name })),
    next: vault.unlocked ? "Restart Codex if the Hoplane tools are still missing." : "Open Hoplane and unlock the local vault."
  }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "error",
    runtime: process.execPath,
    message: error instanceof Error ? error.message : String(error),
    next: "Open Hoplane, then reinstall the Codex integration from the Agent access page."
  }, null, 2)}\n`);
  process.exitCode = 1;
}
