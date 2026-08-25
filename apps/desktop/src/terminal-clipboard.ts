export type TerminalEditAction = "copy" | "paste" | "selectAll";

export interface TerminalKeyEvent {
  type?: string;
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface ClipboardBridge {
  writeClipboard?(text: string): Promise<void>;
  readClipboard?(): Promise<string>;
}

export function isApplePlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function terminalShortcutLabel(action: TerminalEditAction, apple = isApplePlatform()): string {
  if (apple) {
    if (action === "copy") return "⌘C";
    if (action === "paste") return "⌘V";
    return "⌘A";
  }
  if (action === "copy") return "Ctrl+Shift+C";
  if (action === "paste") return "Ctrl+Shift+V";
  return "Ctrl+Shift+A";
}

export function terminalEditAction(event: TerminalKeyEvent, hasSelection: boolean): TerminalEditAction | null {
  if (event.type && event.type !== "keydown") return null;
  if (event.altKey) return null;

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const isC = key === "c" || event.code === "KeyC";
  const isV = key === "v" || event.code === "KeyV";
  const isA = key === "a" || event.code === "KeyA";

  if (event.metaKey && !event.ctrlKey) {
    if (isC) return "copy";
    if (isV) return "paste";
    if (isA) return "selectAll";
    return null;
  }

  if (event.ctrlKey && event.shiftKey && !event.metaKey) {
    if (isC) return "copy";
    if (isV) return "paste";
    if (isA) return "selectAll";
    return null;
  }

  if (event.ctrlKey && !event.shiftKey && !event.metaKey && isC && hasSelection) return "copy";
  return null;
}

export function contextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 8
): { left: number; top: number } {
  return {
    left: Math.min(Math.max(padding, x), Math.max(padding, viewportWidth - width - padding)),
    top: Math.min(Math.max(padding, y), Math.max(padding, viewportHeight - height - padding))
  };
}

export interface TerminalClipboardTarget {
  getSelection(): string;
  hasSelection(): boolean;
  selectAll(): void;
  paste(data: string): void;
}

export async function writeClipboardText(text: string, bridge?: ClipboardBridge): Promise<void> {
  if (bridge?.writeClipboard) {
    await bridge.writeClipboard(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function readClipboardText(bridge?: ClipboardBridge): Promise<string> {
  if (bridge?.readClipboard) return bridge.readClipboard();
  return navigator.clipboard.readText();
}

export async function copyTerminalSelection(term: TerminalClipboardTarget, bridge?: ClipboardBridge): Promise<boolean> {
  const text = term.getSelection();
  if (!text) return false;
  try {
    await writeClipboardText(text, bridge);
    return true;
  } catch {
    return false;
  }
}

export async function pasteTerminalClipboard(term: TerminalClipboardTarget, bridge?: ClipboardBridge): Promise<boolean> {
  try {
    const text = await readClipboardText(bridge);
    if (!text) return false;
    term.paste(text);
    return true;
  } catch {
    return false;
  }
}
