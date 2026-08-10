const { contextBridge } = require("electron");

const fixture = JSON.parse(Buffer.from(process.env.BORDEAUX_BENCHMARK_PROJECT, "base64").toString("utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const state = { savedProjects: [], autosavedProjects: [], dirtyValues: [], publishedProjects: [] };
let menuListener = null;
const unsubscribe = () => undefined;

contextBridge.exposeInMainWorld("bordeauxAPI", {
  platform: "linux",
  restoreLastProject: async () => ({ project: clone(fixture) }),
  openProject: async () => ({ project: clone(fixture) }),
  openRecentProject: async () => ({ project: clone(fixture) }),
  newProject: async () => ({ project: clone(fixture) }),
  saveProject: async (project) => { state.savedProjects.push(clone(project)); return { saved: true }; },
  autosaveProject: async (project) => { state.autosavedProjects.push(clone(project)); return { saved: true }; },
  exportJava: async () => ({ exported: false }),
  validateProject: async () => ({ ok: true, errors: [] }),
  listRecentJavaProjects: async () => [],
  linkJavaProject: async () => null,
  openRecentJavaProject: async () => null,
  refreshJavaProject: async () => null,
  installJavaSupport: async () => null,
  buildJavaCatalog: async () => null,
  cancelJavaCatalogBuild: async () => null,
  setDirty: (dirty) => state.dirtyValues.push(Boolean(dirty)),
  publishAgentSession: (snapshot) => state.publishedProjects.push(clone(snapshot.project)),
  updateAgentProposalStatus: () => undefined,
  acknowledgeAgentProposal: () => undefined,
  getActiveAgentProposal: async () => null,
  getMcpStatus: async () => ({ enabled: false }),
  onMcpStatus: () => unsubscribe,
  onAgentProposal: () => unsubscribe,
  onMenuCommand: (listener) => { menuListener = listener; return () => { if (menuListener === listener) menuListener = null; }; },
  __benchmarkCommand: (command) => menuListener?.({ command }),
  __benchmarkState: () => clone(state),
});
