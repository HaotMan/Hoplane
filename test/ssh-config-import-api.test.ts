import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCore } from "../packages/core/src/server.js";
import type { Host } from "../packages/shared/src/index.js";

const dirs: string[] = [];
const originalDataDir = process.env.HOPLANE_DATA_DIR;
const originalPort = process.env.HOPLANE_CORE_PORT;

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.HOPLANE_DATA_DIR; else process.env.HOPLANE_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.HOPLANE_CORE_PORT; else process.env.HOPLANE_CORE_PORT = originalPort;
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), "hoplane-ssh-import-"));
  dirs.push(dataDir);
  process.env.HOPLANE_DATA_DIR = dataDir;
  process.env.HOPLANE_CORE_PORT = String(await availablePort());
  const runtime = await startCore({ staticRoot: dataDir });
  const token = (await readFile(join(dataDir, "core.token"), "utf8")).trim();
  return { dataDir, runtime, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

async function writeSshConfig(dir: string, content: string): Promise<string> {
  const file = join(dir, "config");
  await writeFile(file, content);
  return file;
}

describe("ssh config import API", () => {
  it("previews parsed entries with duplicate markers and warnings", async () => {
    const { dataDir, runtime, headers } = await startRuntime();
    try {
      const created = await fetch(`${runtime.url}/v1/hosts`, {
        method: "POST", headers, body: JSON.stringify({
          name: "existing", hostname: "10.0.0.3", port: 22, username: "root", enabled: true, aiAccessEnabled: false, credential: { mode: "NONE" }
        })
      });
      expect(created.status).toBe(201);
      const configFile = await writeSshConfig(dataDir, "Host dev\n  HostName 10.0.0.2\n  Port 2222\n  User alice\nHost existing\n  HostName 10.0.0.4\n");
      const response = await fetch(`${runtime.url}/v1/hosts/ssh-config/preview`, { method: "POST", headers, body: JSON.stringify({ path: configFile }) });
      expect(response.status).toBe(200);
      const body = await response.json() as { hosts: Array<{ alias: string; hostname: string; duplicate: boolean }>; warnings: string[] };
      expect(body.warnings).toEqual([]);
      expect(body.hosts.map((host) => [host.alias, host.duplicate])).toEqual([["dev", false], ["existing", true]]);
      expect(body.hosts[0]).toMatchObject({ hostname: "10.0.0.2", username: "alice" });
    } finally {
      await runtime.close();
    }
  });

  it("imports selected aliases into a custom group with proxy jump topology", async () => {
    const { dataDir, runtime, headers } = await startRuntime();
    try {
      const configFile = await writeSshConfig(dataDir, [
        "Host bastion",
        "  HostName 10.0.0.9",
        "  Port 2222",
        "Host app",
        "  HostName 10.0.0.10",
        "  ProxyJump bastion",
        "Host orphan",
        "  HostName 10.0.0.11",
        "  ProxyJump ghost",
        "Host loopA",
        "  HostName 10.0.0.12",
        "  ProxyJump loopB",
        "Host loopB",
        "  HostName 10.0.0.13",
        "  ProxyJump loopA"
      ].join("\n"));
      const response = await fetch(`${runtime.url}/v1/hosts/import-ssh-config`, {
        method: "POST", headers, body: JSON.stringify({
          path: configFile, groupName: "基础设施", aliases: ["bastion", "app", "orphan", "loopA", "loopB", "ghost"]
        })
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { imported: number; skipped: number; hosts: Host[]; warnings: string[] };
      expect(body.imported).toBe(5);
      expect(body.skipped).toBe(0);
      const byName = new Map(body.hosts.map((host) => [host.name, host]));
      expect(byName.get("app")!.jumpHostId).toBe(byName.get("bastion")!.id);
      expect(byName.get("orphan")!.jumpHostId).toBeNull();
      expect(byName.get("loopA")!.jumpHostId).toBeNull();
      expect(byName.get("loopB")!.jumpHostId).toBeNull();
      const app = byName.get("app")!;
      expect(app.groupName).toBe("基础设施");
      expect(app.enabled).toBe(true);
      expect(app.aiAccessEnabled).toBe(false);
      expect(app.tags).toContain("imported");
      expect(app.policyId).toBeTruthy();
      expect(body.warnings.some((warning) => warning.includes("未找到主机别名"))).toBe(true);
      expect(body.warnings.some((warning) => warning.includes("无法解析"))).toBe(true);
      expect(body.warnings.some((warning) => warning.includes("循环"))).toBe(true);
      const hosts = await (await fetch(`${runtime.url}/v1/hosts`, { headers })).json() as Host[];
      expect(hosts).toHaveLength(5);
    } finally {
      await runtime.close();
    }
  });

  it("skips hosts whose names already exist and reports unknown aliases", async () => {
    const { dataDir, runtime, headers } = await startRuntime();
    try {
      const created = await fetch(`${runtime.url}/v1/hosts`, {
        method: "POST", headers, body: JSON.stringify({
          name: "dev", hostname: "10.0.0.99", port: 22, username: "root", enabled: true, aiAccessEnabled: false, credential: { mode: "NONE" }
        })
      });
      expect(created.status).toBe(201);
      const configFile = await writeSshConfig(dataDir, "Host dev\n  HostName 10.0.0.2\n");
      const response = await fetch(`${runtime.url}/v1/hosts/import-ssh-config`, {
        method: "POST", headers, body: JSON.stringify({ path: configFile, aliases: ["dev", "missing"] })
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { imported: number; skipped: number; hosts: Host[]; warnings: string[] };
      expect(body.imported).toBe(0);
      expect(body.skipped).toBe(1);
      expect(body.warnings.some((warning) => warning.includes("已跳过同名主机"))).toBe(true);
      expect(body.warnings.some((warning) => warning.includes("未找到主机别名"))).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
