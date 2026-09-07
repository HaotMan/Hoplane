import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexIntegrationService, JsonAgentIntegrationService, renderMcpConfig, upsertHoplaneMcpConfig, type StdioRuntime } from "../packages/core/src/codex-integration.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

const runtime: StdioRuntime = {
  command: "/Applications/Hoplane.app/Contents/MacOS/Hoplane",
  adapterEntry: "/Applications/Hoplane.app/Contents/Resources/app.asar/dist/packages/mcp-adapter/src/index.js",
  diagnoseEntry: "/Applications/Hoplane.app/Contents/Resources/app.asar/dist/packages/mcp-adapter/src/diagnose.js",
  electronRunAsNode: true
};

describe("Codex integration", () => {
  it("replaces an existing Hoplane HTTP table and preserves unrelated TOML", () => {
    const current = `model = "gpt-test"\n\n[mcp_servers.hoplane]\nurl = "http://127.0.0.1:21722/mcp"\nhttp_headers = { Authorization = "secret" }\n\n[mcp_servers.other]\ncommand = "other"\n`;
    const updated = upsertHoplaneMcpConfig(current, runtime);

    expect(updated).toContain(`model = "gpt-test"`);
    expect(updated).toContain(`[mcp_servers.other]`);
    expect(updated).not.toContain("Authorization");
    expect(updated).toContain(renderMcpConfig(runtime));
    expect(updated).toContain("tool_timeout_sec = 3600");
    expect(upsertHoplaneMcpConfig(updated, runtime)).toBe(updated);
  });

  it("installs the bundled Skill, diagnostic launchers, and managed stdio config", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoplane-codex-test-")); dirs.push(root);
    const codexHome = join(root, "codex-home");
    const source = join(root, "skill-source");
    const command = join(root, "Hoplane");
    const adapterEntry = join(root, "index.js");
    const diagnoseEntry = join(root, "diagnose.js");
    await mkdir(join(source, "agents"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: hoplane\ndescription: test\n---\n", "utf8");
    await writeFile(join(source, "agents", "openai.yaml"), "interface:\n  display_name: \"Hoplane\"\n", "utf8");
    await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
    await chmod(command, 0o700);
    await writeFile(adapterEntry, "", "utf8");
    await writeFile(diagnoseEntry, "", "utf8");
    const service = new CodexIntegrationService({
      codexHome,
      candidateHomes: [],
      skillSource: source,
      runtime: { command, adapterEntry, diagnoseEntry, electronRunAsNode: true }
    });

    const state = await service.install();

    expect(state.installed).toBe(true);
    expect(state.restartRequired).toBe(true);
    expect(await readFile(join(codexHome, "skills", "hoplane", "SKILL.md"), "utf8")).toContain("name: hoplane");
    expect(await readFile(join(codexHome, "skills", "hoplane", "scripts", "diagnose"), "utf8")).toContain("ELECTRON_RUN_AS_NODE=1");
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[mcp_servers.hoplane]");
    expect(config).toContain(`command = ${JSON.stringify(command)}`);
    expect((await service.getState()).restartRequired).toBe(false);
  });

  it("scans only bounded candidates, validates config.toml, and supports manual selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoplane-codex-discovery-")); dirs.push(root);
    const standard = join(root, ".codex");
    const invalid = join(root, "invalid-codex");
    const missing = join(root, "new-codex-home");
    const nestedUnlisted = join(root, "projects", "deep", ".codex");
    await mkdir(standard, { recursive: true });
    await mkdir(invalid, { recursive: true });
    await mkdir(nestedUnlisted, { recursive: true });
    await writeFile(join(standard, "config.toml"), "model = \"gpt-test\"\n", "utf8");
    await writeFile(join(invalid, "config.toml"), "[broken\n", "utf8");
    await writeFile(join(nestedUnlisted, "config.toml"), "model = \"should-not-be-scanned\"\n", "utf8");
    const service = new CodexIntegrationService({
      userHome: root,
      environment: {},
      candidateHomes: [
        { path: standard, label: "standard", source: "DEFAULT" },
        { path: invalid, label: "invalid" },
        { path: missing, label: "missing" }
      ],
      runtime
    });

    const state = await service.getState();
    expect(state.codexHome).toBe(standard);
    expect(state.candidates).toHaveLength(3);
    expect(state.candidates.find((candidate) => candidate.path === standard)?.configStatus).toBe("VALID");
    expect(state.candidates.find((candidate) => candidate.path === invalid)?.configStatus).toBe("INVALID");
    expect(state.candidates.find((candidate) => candidate.path === missing)).toMatchObject({ configStatus: "MISSING", writable: true });
    expect(state.candidates.some((candidate) => candidate.path === nestedUnlisted)).toBe(false);

    const selected = await service.selectCodexHome(missing);
    expect(selected).toMatchObject({ codexHome: missing, canInstall: true });
    await expect(service.selectCodexHome(invalid)).rejects.toThrow(/format|格式|config\.toml/u);
    await expect(service.selectCodexHome("relative/codex")).rejects.toThrow(/absolute/u);
  });

  it("installs user-level Skills and stdio MCP config for JSON-based agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoplane-agent-integrations-")); dirs.push(root);
    const source = join(root, "skill-source");
    const command = join(root, "Hoplane");
    const adapterEntry = join(root, "index.js");
    const diagnoseEntry = join(root, "diagnose.js");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: hoplane\ndescription: test\n---\n", "utf8");
    await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
    await chmod(command, 0o700);
    await writeFile(adapterEntry, "", "utf8");
    await writeFile(diagnoseEntry, "", "utf8");
    await mkdir(join(root, ".cursor"), { recursive: true });
    await mkdir(join(root, "Library", "Application Support", "Trae", "User"), { recursive: true });
    await mkdir(join(root, "Library", "Application Support", "TRAE SOLO", "User"), { recursive: true });
    await writeFile(join(root, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { existing: { command: "existing" } }, keep: true }), "utf8");
    await writeFile(join(root, ".claude.json"), JSON.stringify({ theme: "dark" }), "utf8");
    await writeFile(join(root, "Library", "Application Support", "Trae", "User", "mcp.json"), JSON.stringify({ traeSetting: true }), "utf8");
    await writeFile(join(root, "Library", "Application Support", "TRAE SOLO", "User", "mcp.json"), JSON.stringify({ soloSetting: true }), "utf8");
    const options = { userHome: root, skillSource: source, runtime: { command, adapterEntry, diagnoseEntry, electronRunAsNode: true } };

    const cursor = await new JsonAgentIntegrationService("cursor", options).install();
    const claude = await new JsonAgentIntegrationService("claude-code", options).install();
    const workbuddy = await new JsonAgentIntegrationService("workbuddy", options).install();
    const trae = await new JsonAgentIntegrationService("trae", { ...options, platform: "darwin" }).install();
    const traeSolo = await new JsonAgentIntegrationService("trae", {
      ...options,
      configDirectory: join(root, "Library", "Application Support", "TRAE SOLO", "User"),
      platform: "darwin"
    }).install();

    expect(cursor).toMatchObject({ installed: true, restartRequired: true, skillPath: join(root, ".cursor", "skills", "hoplane") });
    expect(claude).toMatchObject({ installed: true, restartRequired: true, skillPath: join(root, ".claude", "skills", "hoplane") });
    expect(workbuddy).toMatchObject({ installed: true, restartRequired: true, skillPath: join(root, ".workbuddy", "skills", "hoplane"), configPath: join(root, ".workbuddy", "mcp.json") });
    expect(trae).toMatchObject({ installed: true, restartRequired: true, skillPath: join(root, ".trae", "skills", "hoplane"), configPath: join(root, "Library", "Application Support", "Trae", "User", "mcp.json") });
    expect(traeSolo).toMatchObject({ installed: true, restartRequired: true, skillPath: join(root, ".trae", "skills", "hoplane"), configPath: join(root, "Library", "Application Support", "TRAE SOLO", "User", "mcp.json") });
    expect(await readFile(join(cursor.skillPath, "SKILL.md"), "utf8")).toContain("name: hoplane");
    expect(await readFile(join(claude.skillPath, "scripts", "diagnose.cmd"), "utf8")).toContain("ELECTRON_RUN_AS_NODE=1");
    const cursorConfig = JSON.parse(await readFile(join(root, ".cursor", "mcp.json"), "utf8"));
    const claudeConfig = JSON.parse(await readFile(join(root, ".claude.json"), "utf8"));
    const workbuddyConfig = JSON.parse(await readFile(join(root, ".workbuddy", "mcp.json"), "utf8"));
    const traeConfig = JSON.parse(await readFile(join(root, "Library", "Application Support", "Trae", "User", "mcp.json"), "utf8"));
    const traeSoloConfig = JSON.parse(await readFile(join(root, "Library", "Application Support", "TRAE SOLO", "User", "mcp.json"), "utf8"));
    expect(cursorConfig).toMatchObject({ keep: true, mcpServers: { existing: { command: "existing" }, hoplane: { type: "stdio", command, args: [adapterEntry] } } });
    expect(claudeConfig).toMatchObject({ theme: "dark", mcpServers: { hoplane: { type: "stdio", command, args: [adapterEntry] } } });
    expect(workbuddyConfig).toMatchObject({ mcpServers: { hoplane: { type: "stdio", command, args: [adapterEntry] } } });
    expect(traeConfig).toMatchObject({ traeSetting: true, mcpServers: { hoplane: { command, args: [adapterEntry], env: { START_MCP_TIMEOUT_MS: "30000", RUN_MCP_TIMEOUT_MS: "3600000", ELECTRON_RUN_AS_NODE: "1" } } } });
    expect(traeConfig.mcpServers.hoplane).not.toHaveProperty("type");
    expect(traeSoloConfig).toMatchObject({ soloSetting: true, mcpServers: { hoplane: { command, args: [adapterEntry] } } });
    expect((await new JsonAgentIntegrationService("cursor", options).getState()).installed).toBe(true);
    expect((await new JsonAgentIntegrationService("claude-code", options).getState()).installed).toBe(true);
    expect((await new JsonAgentIntegrationService("workbuddy", options).getState()).installed).toBe(true);
    expect((await new JsonAgentIntegrationService("trae", { ...options, platform: "darwin" }).getState()).installed).toBe(true);
    expect((await new JsonAgentIntegrationService("trae", { ...options, configDirectory: join(root, "Library", "Application Support", "TRAE SOLO", "User"), platform: "darwin" }).getState()).installed).toBe(true);
  });

  it("discovers Trae, Trae CN, and TRAE SOLO user configuration directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoplane-trae-discovery-")); dirs.push(root);
    const international = join(root, "Library", "Application Support", "Trae", "User");
    const china = join(root, "Library", "Application Support", "Trae CN", "User");
    const solo = join(root, "Library", "Application Support", "TRAE SOLO", "User");
    await mkdir(international, { recursive: true });
    await mkdir(china, { recursive: true });
    await mkdir(solo, { recursive: true });
    await writeFile(join(china, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");

    const service = new JsonAgentIntegrationService("trae", { userHome: root, environment: {}, platform: "darwin", runtime });
    const state = await service.getState();
    expect(state.configDirectory).toBe(china);
    expect(state.agentHome).toBe(join(root, ".trae-cn"));
    expect(state.skillPath).toBe(join(root, ".trae-cn", "skills", "hoplane"));
    expect(state.configPath).toBe(join(china, "mcp.json"));
    expect(state.candidates.map((candidate) => candidate.path)).toEqual([international, china, solo]);

    const windows = await new JsonAgentIntegrationService("trae", {
      userHome: root,
      environment: { APPDATA: join(root, "AppData", "Roaming") },
      platform: "win32",
      runtime
    }).getState();
    expect(windows.configDirectory).toBe(join(root, "AppData", "Roaming", "Trae", "User"));
  });

  it("installs ZCode skill and merges into the nested mcp.servers block", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoplane-zcode-integration-")); dirs.push(root);
    const source = join(root, "skill-source");
    const command = join(root, "Hoplane");
    const adapterEntry = join(root, "index.js");
    const diagnoseEntry = join(root, "diagnose.js");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: hoplane\ndescription: test\n---\n", "utf8");
    await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
    await chmod(command, 0o700);
    await writeFile(adapterEntry, "", "utf8");
    await writeFile(diagnoseEntry, "", "utf8");
    await mkdir(join(root, ".zcode", "cli"), { recursive: true });
    await writeFile(join(root, ".zcode", "cli", "config.json"), JSON.stringify({
      plugins: { "browser-use": true },
      mcp: { servers: { existing: { command: "existing" } } }
    }), "utf8");
    const options = { userHome: root, skillSource: source, runtime: { command, adapterEntry, diagnoseEntry, electronRunAsNode: true } };

    const state = await new JsonAgentIntegrationService("zcode", options).install();

    expect(state).toMatchObject({
      installed: true,
      restartRequired: true,
      skillPath: join(root, ".zcode", "skills", "hoplane"),
      configPath: join(root, ".zcode", "cli", "config.json")
    });
    expect(await readFile(join(state.skillPath, "SKILL.md"), "utf8")).toContain("name: hoplane");
    const config = JSON.parse(await readFile(join(root, ".zcode", "cli", "config.json"), "utf8"));
    expect(config).toMatchObject({
      plugins: { "browser-use": true },
      mcp: { servers: { existing: { command: "existing" }, hoplane: { command, args: [adapterEntry], env: { ELECTRON_RUN_AS_NODE: "1" } } } }
    });
    expect(config.mcp.servers.hoplane).not.toHaveProperty("type");
    const refreshed = await new JsonAgentIntegrationService("zcode", options).getState();
    expect(refreshed.installed).toBe(true);
    expect(refreshed.configSnippet).toContain('"servers"');
  });

  it("discovers the ZCode CLI directory and refuses malformed mcp blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoplane-zcode-discovery-")); dirs.push(root);
    await mkdir(join(root, ".zcode", "cli"), { recursive: true });
    await writeFile(join(root, ".zcode", "cli", "config.json"), JSON.stringify({ mcp: { servers: [] } }), "utf8");

    const state = await new JsonAgentIntegrationService("zcode", { userHome: root, environment: {}, runtime }).getState();

    expect(state.configDirectory).toBe(join(root, ".zcode", "cli"));
    expect(state.agentHome).toBe(join(root, ".zcode"));
    expect(state.configPath).toBe(join(root, ".zcode", "cli", "config.json"));
    expect(state.skillPath).toBe(join(root, ".zcode", "skills", "hoplane"));
    expect(state.canInstall).toBe(false);
    expect(state.configError).toMatch(/mcp\.servers/u);
  });

  it("scans bounded Cursor and Claude Code config directories and supports manual selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoplane-agent-discovery-")); dirs.push(root);
    const cursorValid = join(root, ".cursor");
    const cursorInvalid = join(root, "cursor-invalid");
    const cursorMissing = join(root, "cursor-new");
    const cursorNested = join(root, "projects", "deep", ".cursor");
    await mkdir(cursorValid, { recursive: true });
    await mkdir(cursorInvalid, { recursive: true });
    await mkdir(cursorNested, { recursive: true });
    await writeFile(join(cursorValid, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    await writeFile(join(cursorInvalid, "mcp.json"), "{broken", "utf8");
    await writeFile(join(cursorNested, "mcp.json"), JSON.stringify({ nested: true }), "utf8");
    const cursorService = new JsonAgentIntegrationService("cursor", {
      userHome: root,
      environment: {},
      candidateDirectories: [
        { path: cursorValid, label: "valid", source: "DEFAULT" },
        { path: cursorInvalid, label: "invalid" },
        { path: cursorMissing, label: "missing" }
      ],
      runtime
    });
    const cursor = await cursorService.getState();
    expect(cursor.configDirectory).toBe(cursorValid);
    expect(cursor.candidates).toHaveLength(3);
    expect(cursor.candidates.find((candidate) => candidate.path === cursorInvalid)?.configStatus).toBe("INVALID");
    expect(cursor.candidates.some((candidate) => candidate.path === cursorNested)).toBe(false);
    expect(await cursorService.selectConfigDirectory(cursorMissing)).toMatchObject({
      configDirectory: cursorMissing,
      configPath: join(cursorMissing, "mcp.json"),
      skillPath: join(cursorMissing, "skills", "hoplane"),
      canInstall: true
    });
    await expect(cursorService.selectConfigDirectory(cursorInvalid)).rejects.toThrow(/JSON/u);
    await expect(cursorService.selectConfigDirectory("relative/cursor")).rejects.toThrow(/绝对路径/u);

    const claudeValidRoot = join(root, "claude-user");
    const claudeMissingRoot = join(root, "claude-new-user");
    await mkdir(claudeValidRoot, { recursive: true });
    await writeFile(join(claudeValidRoot, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    const claudeService = new JsonAgentIntegrationService("claude-code", {
      userHome: root,
      environment: {},
      candidateDirectories: [
        { path: claudeValidRoot, label: "valid", source: "DEFAULT" },
        { path: claudeMissingRoot, label: "missing" }
      ],
      runtime
    });
    expect(await claudeService.getState()).toMatchObject({
      configDirectory: claudeValidRoot,
      agentHome: join(claudeValidRoot, ".claude"),
      configPath: join(claudeValidRoot, ".claude.json")
    });
    expect(await claudeService.selectConfigDirectory(claudeMissingRoot)).toMatchObject({
      configDirectory: claudeMissingRoot,
      skillPath: join(claudeMissingRoot, ".claude", "skills", "hoplane"),
      canInstall: true
    });
  });

  it("refuses to overwrite malformed agent JSON config", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoplane-agent-invalid-")); dirs.push(root);
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(join(root, ".cursor", "mcp.json"), "{broken", "utf8");
    const state = await new JsonAgentIntegrationService("cursor", { userHome: root, runtime }).getState();
    expect(state.canInstall).toBe(false);
    expect(state.configError).toMatch(/JSON/u);
  });
});
