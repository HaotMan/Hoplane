import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { computeUiBuildId } from "../packages/core/src/server.js";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("Core UI build identity", () => {
  it("returns null for an API-only Core without packaged UI files", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "hoplane-ui-build-"));
    dirs.push(staticRoot);

    expect(await computeUiBuildId(staticRoot)).toBeNull();
  });

  it("changes when the packaged UI index changes", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "hoplane-ui-build-"));
    dirs.push(staticRoot);
    const first = "<!doctype html><script src=\"/assets/app-a.js\"></script>";
    await writeFile(join(staticRoot, "index.html"), first);

    const firstId = await computeUiBuildId(staticRoot);
    expect(firstId).toBe(createHash("sha256").update(first).digest("hex").slice(0, 16));

    await writeFile(join(staticRoot, "index.html"), "<!doctype html><script src=\"/assets/app-b.js\"></script>");
    expect(await computeUiBuildId(staticRoot)).not.toBe(firstId);
  });
});
