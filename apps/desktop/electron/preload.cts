import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hoplane", {
  openPoliciesDirectory: async (): Promise<void> => {
    await ipcRenderer.invoke("hoplane:open-policies-directory");
  },
  writeClipboard: async (text: string): Promise<void> => {
    await ipcRenderer.invoke("hoplane:clipboard-write", text);
  },
  readClipboard: async (): Promise<string> => ipcRenderer.invoke("hoplane:clipboard-read")
});
