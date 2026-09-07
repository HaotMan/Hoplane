import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSshConfig } from "../packages/core/src/ssh-config-import.js";

let dir = "";
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ""; });

async function write(name: string, content: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

describe("SSH config import", () => {
  it("imports concrete aliases and ignores wildcard entries", async () => {
    dir = await mkdtemp(join(tmpdir(), "hoplane-ssh-config-")); const file = join(dir, "config");
    await writeFile(file, "Host *\n  ServerAliveInterval 30\nHost dev\n  HostName 10.0.0.2\n  User alice\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\nHost prod *.internal\n  HostName prod.example.com\n");
    const { hosts } = await parseSshConfig(file);
    expect(hosts.map((host) => host.alias)).toEqual(["dev", "prod"]);
    expect(hosts[0]).toMatchObject({ hostname: "10.0.0.2", username: "alice", port: 2222, identityFile: `${process.env.HOME}/.ssh/id_ed25519` });
  });

  it("skips Match blocks instead of merging them into the preceding host", async () => {
    dir = await mkdtemp(join(tmpdir(), "hoplane-ssh-match-")); const file = join(dir, "config");
    await writeFile(file, "Host dev\n  HostName 10.0.0.2\n  User alice\nMatch exec \"/usr/bin/confirm\"\n  HostName evil.example.com\n  User attacker\nHost prod\n  HostName 10.0.0.3\n");
    const { hosts, warnings } = await parseSshConfig(file);
    expect(warnings).toEqual([]);
    expect(hosts.map((host) => host.alias)).toEqual(["dev", "prod"]);
    expect(hosts[0]).toMatchObject({ hostname: "10.0.0.2", username: "alice" });
    expect(hosts[1]).toMatchObject({ hostname: "10.0.0.3" });
    expect(hosts[1].username).not.toBe("attacker");
  });

  it("expands Include directives with relative paths, globs, and cycle protection", async () => {
    dir = await mkdtemp(join(tmpdir(), "hoplane-ssh-include-"));
    await mkdir(join(dir, "conf.d"), { recursive: true });
    await writeFile(join(dir, "conf.d", "a.conf"), "Host alpha\n  HostName 10.1.0.1\nInclude a.conf\n");
    await writeFile(join(dir, "conf.d", "b.conf"), "Host beta\n  HostName 10.1.0.2\n");
    const main = await write("config", "Include conf.d/*.conf missing.conf\nHost local\n  HostName 127.0.0.1\n");
    const { hosts, warnings } = await parseSshConfig(main);
    expect(hosts.map((host) => host.alias).sort()).toEqual(["alpha", "beta", "local"]);
    expect(warnings.some((warning) => warning.includes("missing.conf"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("循环"))).toBe(true);
  });

  it("stops Include expansion beyond the depth limit", async () => {
    dir = await mkdtemp(join(tmpdir(), "hoplane-ssh-depth-"));
    for (let level = 1; level <= 7; level++) {
      await writeFile(join(dir, `l${level}.conf`), level < 7
        ? `Include l${level + 1}.conf\nHost deep${level}\n  HostName 10.9.0.${level}\n`
        : "Host deep7\n  HostName 10.9.0.7\n");
    }
    const main = await write("config", "Include l1.conf\n");
    const { hosts, warnings } = await parseSshConfig(main);
    // Include 在其出现位置展开：深层文件的内容先于外层 Host 块输出
    expect(hosts.map((host) => host.alias)).toEqual(["deep5", "deep4", "deep3", "deep2", "deep1"]);
    expect(warnings.some((warning) => warning.includes("l6.conf"))).toBe(true);
  });

  it("extracts the first ProxyJump hop with user, port, and none variants", async () => {
    dir = await mkdtemp(join(tmpdir(), "hoplane-ssh-jump-")); const file = join(dir, "config");
    await writeFile(file, [
      "Host app",
      "  ProxyJump jump@10.0.0.9:2222",
      "Host app2",
      "  ProxyJump bastion,fallback",
      "Host app3",
      "  ProxyJump none",
      "Host app4",
      "  ProxyJump [::1]:22"
    ].join("\n"));
    const { hosts } = await parseSshConfig(file);
    expect(hosts.find((host) => host.alias === "app")?.proxyJump).toBe("10.0.0.9");
    expect(hosts.find((host) => host.alias === "app2")?.proxyJump).toBe("bastion");
    expect(hosts.find((host) => host.alias === "app3")?.proxyJump).toBeUndefined();
    expect(hosts.find((host) => host.alias === "app4")?.proxyJump).toBe("::1");
  });
});
