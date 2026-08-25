import { describe, expect, it, vi } from "vitest";
import {
  contextMenuPosition,
  copyTerminalSelection,
  pasteTerminalClipboard,
  readClipboardText,
  terminalEditAction,
  terminalShortcutLabel,
  writeClipboardText
} from "../apps/desktop/src/terminal-clipboard.js";

function key(partial: Partial<Parameters<typeof terminalEditAction>[0]> & Pick<Parameters<typeof terminalEditAction>[0], "key" | "code">): Parameters<typeof terminalEditAction>[0] {
  return {
    type: "keydown",
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    altKey: false,
    ...partial
  };
}

describe("terminal edit shortcuts", () => {
  it("copies with Ctrl+Shift+C and pastes with Ctrl+Shift+V", () => {
    expect(terminalEditAction(key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }), false)).toBe("copy");
    expect(terminalEditAction(key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }), false)).toBe("paste");
    expect(terminalEditAction(key({ key: "A", code: "KeyA", ctrlKey: true, shiftKey: true }), false)).toBe("selectAll");
  });

  it("copies with Ctrl+C only when the terminal has a selection", () => {
    expect(terminalEditAction(key({ key: "c", code: "KeyC", ctrlKey: true }), true)).toBe("copy");
    expect(terminalEditAction(key({ key: "c", code: "KeyC", ctrlKey: true }), false)).toBeNull();
  });

  it("uses Command shortcuts on macOS and ignores keyup", () => {
    expect(terminalEditAction(key({ key: "c", code: "KeyC", metaKey: true }), false)).toBe("copy");
    expect(terminalEditAction(key({ key: "v", code: "KeyV", metaKey: true }), false)).toBe("paste");
    expect(terminalEditAction(key({ type: "keyup", key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(terminalEditAction(key({ key: "c", code: "KeyC", ctrlKey: true, altKey: true }), true)).toBeNull();
  });

  it("keeps ordinary terminal keys such as Ctrl+V for the remote shell", () => {
    expect(terminalEditAction(key({ key: "v", code: "KeyV", ctrlKey: true }), false)).toBeNull();
    expect(terminalEditAction(key({ key: "l", code: "KeyL", ctrlKey: true }), false)).toBeNull();
  });
});

describe("terminal clipboard helpers", () => {
  it("labels shortcuts for Windows and macOS", () => {
    expect(terminalShortcutLabel("copy", false)).toBe("Ctrl+Shift+C");
    expect(terminalShortcutLabel("paste", false)).toBe("Ctrl+Shift+V");
    expect(terminalShortcutLabel("selectAll", true)).toBe("⌘A");
  });

  it("keeps the context menu inside the viewport", () => {
    expect(contextMenuPosition(1200, 800, 200, 120, 1280, 820)).toEqual({ left: 1072, top: 692 });
    expect(contextMenuPosition(-10, -4, 180, 90, 800, 600)).toEqual({ left: 8, top: 8 });
  });

  it("prefers the Electron clipboard bridge", async () => {
    const writeClipboard = vi.fn(async () => undefined);
    const readClipboard = vi.fn(async () => "pasted");
    await writeClipboardText("copied", { writeClipboard, readClipboard });
    await expect(readClipboardText({ writeClipboard, readClipboard })).resolves.toBe("pasted");
    expect(writeClipboard).toHaveBeenCalledWith("copied");
  });

  it("copies the current selection and pastes clipboard text into the terminal", async () => {
    const paste = vi.fn();
    const term = { getSelection: () => "ls -la", hasSelection: () => true, selectAll: vi.fn(), paste };
    const writeClipboard = vi.fn(async () => undefined);
    const readClipboard = vi.fn(async () => "echo hi");
    await expect(copyTerminalSelection(term, { writeClipboard, readClipboard })).resolves.toBe(true);
    await expect(copyTerminalSelection({ ...term, getSelection: () => "" }, { writeClipboard, readClipboard })).resolves.toBe(false);
    await expect(pasteTerminalClipboard(term, { writeClipboard, readClipboard })).resolves.toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith("ls -la");
    expect(paste).toHaveBeenCalledWith("echo hi");
  });

  it("returns false when clipboard access fails", async () => {
    const term = { getSelection: () => "text", hasSelection: () => true, selectAll: vi.fn(), paste: vi.fn() };
    await expect(copyTerminalSelection(term, { writeClipboard: async () => { throw new Error("denied"); } })).resolves.toBe(false);
    await expect(pasteTerminalClipboard(term, { readClipboard: async () => { throw new Error("denied"); } })).resolves.toBe(false);
    expect(term.paste).not.toHaveBeenCalled();
  });
});
