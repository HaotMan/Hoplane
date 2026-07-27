import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from "electron";
import { join } from "node:path";
import type { CoreRuntime } from "../../../packages/core/src/server.js";

process.stderr.write("Hoplane desktop initializing\n");

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: CoreRuntime | null = null;
let quitting = false;
let shutdownComplete = false;
const coreUrl = "http://127.0.0.1:21722";

void app.whenReady().then(async () => {
  process.stderr.write("Hoplane desktop ready\n");
  try {
    process.env.HOPLANE_MCP_RUNTIME = process.execPath;
    process.env.HOPLANE_MCP_ENTRY = join(app.getAppPath(), "dist", "packages", "mcp-adapter", "src", "index.js");
    process.env.HOPLANE_MCP_DIAGNOSE_ENTRY = join(app.getAppPath(), "dist", "packages", "mcp-adapter", "src", "diagnose.js");
    process.env.HOPLANE_MCP_RUNTIME_IS_ELECTRON = "1";
    process.env.HOPLANE_CODEX_SKILL_SOURCE = join(process.resourcesPath, "codex", "hoplane");
    const { startCore } = await import("../../../packages/core/src/server.js");
    runtime = await startCore({ staticRoot: join(app.getAppPath(), "apps", "desktop", "dist") });
    const { loadConfig } = await import("../../../packages/core/src/config.js");
    ipcMain.handle("hoplane:open-policies-directory", async () => { await shell.openPath(loadConfig().policyDir); });
  } catch (error) {
    const healthy = await fetch(`${coreUrl}/health`).then((response) => response.ok).catch(() => false);
    if (!healthy) throw error;
  }
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
