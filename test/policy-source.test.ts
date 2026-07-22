import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { HoplaneDatabase } from "../packages/core/src/database.js";
import { PolicySourceService } from "../packages/core/src/policy-source.js";
import type { CoreConfig } from "../packages/core/src/config.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

function config(dir: string): CoreConfig {
  return { dataDir: dir, databasePath: join(dir, "hoplane.sqlite3"), tokenPath: join(dir, "core.token"), pidPath: join(dir, "core.pid"), logPath: join(dir, "core.log"), vaultPath: join(dir, "vault.enc"), policyDir: join(dir, "policies"), host: "127.0.0.1", port: 21722, outputLimitBytes: 1024 };
}

describe("PolicySourceService", () => {
  it("persists templates, syncs external YAML, rejects invalid edits, and restores deletion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoplane-policy-source-")); dirs.push(dir);
    const database = new HoplaneDatabase(join(dir, "hoplane.sqlite3"));
    const service = new PolicySourceService(config(dir), database, { watch: false });
    await service.initialize();
    try {
      const selected = database.listPolicies()[0]!;
      const source = await service.getSource(selected.id);
      expect(source.path).toMatch(/\.yaml$/u);
      expect((await readFile(source.path, "utf8"))).toContain("schemaVersion: 3");

      const parsed = parse(source.yaml) as Record<string, unknown>;
      parsed.name = "外部编辑策略";
      await writeFile(source.path, stringify(parsed));
      const scan = await service.rescan();
      expect(scan.updated).toBe(1);
      const externallyUpdated = database.getPolicy(selected.id)!;
      expect(externallyUpdated).toMatchObject({ name: "外部编辑策略", version: selected.version + 1, sourceStatus: "SYNCED", enabled: true });

      await writeFile(source.path, "id: not-a-uuid\nname: broken\nschemaVersion: 3\n");
      expect((await service.rescan()).errors).toBe(1);
      expect(database.getPolicy(selected.id)).toMatchObject({ name: "外部编辑策略", sourceStatus: "ERROR", enabled: true });

      await unlink(source.path);
      await service.rescan();
      expect(database.getPolicy(selected.id)).toMatchObject({ sourceStatus: "MISSING", enabled: false });
      const restored = await service.restore(selected.id);
      expect(restored).toMatchObject({ sourceStatus: "SYNCED", enabled: true });
      expect(await readFile(restored.sourcePath!, "utf8")).toContain("name: 外部编辑策略");
    } finally { await service.close(); database.close(); }
  });

  it("imports id-less YAML and enforces optimistic versions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoplane-policy-import-")); dirs.push(dir);
    const database = new HoplaneDatabase(join(dir, "hoplane.sqlite3"));
    const service = new PolicySourceService(config(dir), database, { watch: false });
    await service.initialize();
    try {
      const source = await service.getSource(database.listPolicies()[0]!.id);
      const parsed = parse(source.yaml) as Record<string, unknown>;
      delete parsed.id; parsed.name = "目录导入策略";
      await writeFile(join(dir, "policies", "imported.yaml"), stringify(parsed));
      expect((await service.rescan()).updated).toBe(1);
      const imported = database.listPolicies().find((policy) => policy.name === "目录导入策略")!;
      expect(imported.id).toMatch(/^[0-9a-f-]{36}$/u);
      await expect(service.saveSource(imported.id, (await service.getSource(imported.id)).yaml, imported.version - 1)).rejects.toMatchObject({ code: "POLICY_VERSION_CONFLICT" });
    } finally { await service.close(); database.close(); }
  });
});
