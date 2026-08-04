import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoreConfig } from "../../../packages/core/src/config.js";
import type { CoreRuntime } from "../../../packages/core/src/server.js";

process.stderr.write("Hoplane desktop initializing\n");

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: CoreRuntime | null = null;
let quitting = false;
let shutdownComplete = false;
let coreUrl = "http://127.0.0.1:21722";

void app.whenReady().then(async () => {
  process.stderr.write("Hoplane desktop ready\n");
  process.env.HOPLANE_MCP_RUNTIME = process.execPath;
  process.env.HOPLANE_MCP_ENTRY = join(app.getAppPath(), "dist", "packages", "mcp-adapter", "src", "index.js");
  process.env.HOPLANE_MCP_DIAGNOSE_ENTRY = join(app.getAppPath(), "dist", "packages", "mcp-adapter", "src", "diagnose.js");
  process.env.HOPLANE_MCP_RUNTIME_IS_ELECTRON = "1";
  process.env.HOPLANE_CODEX_SKILL_SOURCE = join(process.resourcesPath, "codex", "hoplane");
  const { loadConfig } = await import("../../../packages/core/src/config.js");
  const { computeUiBuildId, startCore } = await import("../../../packages/core/src/server.js");
  const config = loadConfig();
  const staticRoot = join(app.getAppPath(), "apps", "desktop", "dist");
  const expectedUiBuildId = await computeUiBuildId(staticRoot);
  if (!expectedUiBuildId) throw new Error(`Packaged Hoplane UI is missing from ${staticRoot}`);
  coreUrl = `http://${config.host}:${config.port}`;
  const existing = await readCoreHealth(coreUrl);
  if (existing && existing.uiBuildId !== expectedUiBuildId) {
    process.stderr.write(`Replacing stale Hoplane Core (${existing.uiBuildId ?? "legacy"}) with UI build ${expectedUiBuildId}\n`);
    await stopExistingCore(config, coreUrl);
  }
  if (!existing || existing.uiBuildId !== expectedUiBuildId) {
    runtime = await startCore({ staticRoot });
  } else {
    process.stderr.write(`Reusing Hoplane Core with matching UI build ${expectedUiBuildId}\n`);
  }
  ipcMain.handle("hoplane:open-policies-directory", async () => { await shell.openPath(config.policyDir); });
  createWindow();
  createTray();
}).catch((error: unknown) => {
  process.stderr.write(`Hoplane desktop failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.quit();
});

app.on("activate", () => {
  if (!window) createWindow();
  else window.show();
});

app.on("window-all-closed", () => undefined);

app.on("before-quit", (event) => {
  quitting = true;
  if (shutdownComplete || !runtime) return;
  event.preventDefault();
  void runtime.close().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

function createWindow(): void {
  window = new BrowserWindow({
    title: "Hoplane",
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0a0b0b",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, "preload.cjs")
    }
  });
  window.setMenuBarVisibility(false);
  void window.loadURL(runtime?.url ?? coreUrl);
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on("closed", () => { window = null; });
}

function createTray(): void {
  // Colored logo icon; the @2x sibling file is picked up automatically for retina.
  const trayImage = nativeImage.createFromPath(join(app.getAppPath(), "apps", "desktop", "electron", "tray.png"));
  tray = new Tray(trayImage);
  tray.setToolTip("Hoplane AI SSH Gateway");
  tray.on("click", () => showWindow());
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Hoplane", click: () => showWindow() },
    { type: "separator" },
    {
      label: "登录时启动",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
        refreshTrayMenu();
      }
    },
    { type: "separator" },
    { label: "退出", role: "quit" }
  ]));
}

function showWindow(): void {
  if (!window) createWindow();
  window?.show();
  window?.focus();
}

interface CoreHealth {
  status: string;
  version?: string;
  uiBuildId?: string;
}

async function readCoreHealth(url: string): Promise<CoreHealth | null> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return null;
    return await response.json() as CoreHealth;
  } catch {
    return null;
  }
}

async function stopExistingCore(config: CoreConfig, url: string): Promise<void> {
  const rawPid = await readFile(config.pidPath, "utf8").catch(() => "");
  if (!/^[1-9][0-9]*\s*$/u.test(rawPid)) {
    throw new Error(`A stale Hoplane Core is listening at ${url}, but ${config.pidPath} does not contain a valid process ID`);
  }
  const pid = Number(rawPid.trim());
  if (pid === process.pid) throw new Error("Refusing to stop the current Hoplane desktop process");
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!await readCoreHealth(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out while replacing the stale Hoplane Core at ${url}`);
}
