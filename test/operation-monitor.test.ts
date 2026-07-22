import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HoplaneDatabase } from "../packages/core/src/database.js";
import { HostMonitor } from "../packages/core/src/host-monitor.js";
import { OperationService } from "../packages/core/src/operation-service.js";
import { PolicyService } from "../packages/policy/src/index.js";
import type { SSHConnectionManager } from "../packages/ssh-core/src/connection-manager.js";
import type { HostMonitorEvent } from "../packages/shared/src/index.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

describe("operation monitor", () => {
  it("streams redacted command output without persisting it in the audit row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoplane-monitor-test-")); dirs.push(dir);
    const database = new HoplaneDatabase(join(dir, "test.sqlite3"));
    const policy = database.listPolicies()[0]!;
    const host = database.createHost({
      name: "test", hostname: "127.0.0.1", port: 22, username: "tester", credentialId: null,
      policyId: policy.id, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: true,
      monitorOutputEnabled: true
    });
    const ssh = {
      getStatus: () => "CONNECTED",
      execute: async (_hostId: string, _command: string, options: { onStdout?: (chunk: Buffer) => void; onStderr?: (chunk: Buffer) => void }) => {
        options.onStdout?.(Buffer.from("token=supersecret\nready\n"));
        options.onStderr?.(Buffer.from("warning\n"));
        return { stdout: "token=supersecret\nready\n", stderr: "warning\n", stdoutTruncated: false, stderrTruncated: false, exitCode: 0 };
      }
    } as unknown as SSHConnectionManager;
    const monitor = new HostMonitor();
    const events: HostMonitorEvent[] = [];
    monitor.subscribe(host.id, (event) => events.push(event));
    const operations = new OperationService(database, new PolicyService(), ssh, monitor);

    const result = await operations.executeCommand({ hostId: host.id, command: "uptime", clientType: "MCP", clientId: "agent-test" });

    expect(result.stdout).toContain("supersecret");
    expect(events.find((event) => event.kind === "STDOUT")?.content).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain("supersecret");
    const audit = database.listAudit({ hostId: host.id, limit: 10 })[0]!;
    expect(audit.status).toBe("SUCCEEDED");
    expect(audit.exitCode).toBe(0);
    expect(audit).not.toHaveProperty("stdout");

    database.updateHost(host.id, { monitorOutputEnabled: false });
    const eventCount = events.length;
    await operations.executeCommand({ hostId: host.id, command: "uptime", clientType: "MCP", clientId: "agent-test" });
    expect(events.slice(eventCount).some((event) => event.kind === "STDOUT" || event.kind === "STDERR")).toBe(false);
    database.close();
  });
});
