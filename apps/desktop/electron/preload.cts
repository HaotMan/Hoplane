import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hoplane", {
  openPoliciesDirectory: async (): Promise<void> => {
    await ipcRenderer.invoke("hoplane:open-policies-directory");
  }
});
