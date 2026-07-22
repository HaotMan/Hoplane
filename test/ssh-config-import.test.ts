import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSshConfig } from "../packages/core/src/ssh-config-import.js";

let dir = "";
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ""; });

describe("SSH config import", () => {
  it("imports concrete aliases and ignores wildcard entries", async () => {
    dir = await mkdtemp(join(tmpdir(), "hoplane-ssh-config-")); const file = join(dir, "config");
    await writeFile(file, "Host *\n  ServerAliveInterval 30\nHost dev\n  HostName 10.0.0.2\n  User alice\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\nHost prod *.internal\n  HostName prod.example.com\n");
    const hosts = await parseSshConfig(file);
    expect(hosts.map((host) => host.alias)).toEqual(["dev", "prod"]);
    expect(hosts[0]).toMatchObject({ hostname: "10.0.0.2", username: "alice", port: 2222 });
  });
});
