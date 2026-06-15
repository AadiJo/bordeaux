import { contextBridge, ipcRenderer } from "electron";
import type { BordeauxProject } from "../shared/types";

contextBridge.exposeInMainWorld("bordeauxAPI", {
  openProject: () => ipcRenderer.invoke("project:open"),
  openRecentProject: (path: string) => ipcRenderer.invoke("project:openRecent", path),
  saveProject: (project: BordeauxProject, path?: string | null) => ipcRenderer.invoke("project:save", project, path),
  exportBdx: (project: BordeauxProject, outputPath?: string | null) => ipcRenderer.invoke("project:exportBdx", project, outputPath),
  validateProject: (project: BordeauxProject) => ipcRenderer.invoke("project:validate", project),
  showItemInFolder: (path: string) => ipcRenderer.invoke("shell:showItem", path),
  onMenuCommand: (handler: (event: { command: string; payload?: unknown }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { command: string; payload?: unknown }) => handler(payload);
    ipcRenderer.on("menu-command", listener);
    return () => ipcRenderer.removeListener("menu-command", listener);
  },
});
