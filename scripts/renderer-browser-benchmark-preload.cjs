const { contextBridge } = require("electron");

const fixture = JSON.parse(Buffer.from(process.env.BORDEAUX_BENCHMARK_PROJECT, "base64").toString("utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const openedFixture = clone(fixture);
openedFixture.name = "Opened renderer browser benchmark";
const reopenedFixture = clone(fixture);
reopenedFixture.name = "Reopened renderer browser benchmark";
const state = {
  savedProjects: [],
  autosavedProjects: [],
  dirtyValues: [],
  publishedProjects: [],
  currentFile: "original",
  files: { original: clone(fixture), opened: clone(openedFixture), reopened: clone(reopenedFixture) },
  projectWrites: [],
  projectOperations: [],
  activeProjectOperations: 0,
  maxConcurrentProjectOperations: 0,
  saveDelayMs: 0,
  mainDirty: false,
};
let menuListener = null;
let releaseRestore;
const restoreGate = new Promise((resolve) => { releaseRestore = resolve; });
const unsubscribe = () => undefined;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const projectOperation = async (kind, operation) => {
  state.activeProjectOperations += 1;
  state.maxConcurrentProjectOperations = Math.max(state.maxConcurrentProjectOperations, state.activeProjectOperations);
  state.projectOperations.push(`${kind}:start:${state.currentFile}`);
  try {
    return await operation();
  } finally {
    state.projectOperations.push(`${kind}:finish:${state.currentFile}`);
    state.activeProjectOperations -= 1;
  }
};
const openProject = () => projectOperation("open", async () => {
  const reopening = state.currentFile === "opened";
  state.currentFile = reopening ? "reopened" : "opened";
  state.mainDirty = false;
  state.dirtyValues.push(false);
  return { project: clone(reopening ? reopenedFixture : openedFixture) };
});

contextBridge.exposeInMainWorld("bordeauxAPI", {
  platform: "linux",
  restoreLastProject: () => projectOperation("restore", async () => {
    await restoreGate;
    state.currentFile = "original";
    state.mainDirty = false;
    state.dirtyValues.push(false);
    return { project: clone(fixture) };
  }),
  openProject,
  openRecentProject: openProject,
  newProject: async () => {
    state.currentFile = null;
    state.mainDirty = false;
    state.dirtyValues.push(false);
    return { project: clone(fixture) };
  },
  saveProject: (project) => projectOperation("save", async () => {
    const target = state.currentFile;
    if (state.saveDelayMs) await delay(state.saveDelayMs);
    const saved = clone(project);
    state.savedProjects.push(saved);
    state.projectWrites.push({ kind: "save", target, projectName: saved.name });
    if (target) state.files[target] = saved;
    // Models the old main-process behavior: a late save reattached its target.
    state.currentFile = target;
    return { saved: true };
  }),
  autosaveProject: (project) => projectOperation("autosave", async () => {
    const target = state.currentFile;
    const saved = clone(project);
    state.autosavedProjects.push(saved);
    state.projectWrites.push({ kind: "autosave", target, projectName: saved.name });
    if (target) state.files[target] = saved;
    return { saved: Boolean(target) };
  }),
  exportJava: async () => ({ exported: false }),
  validateProject: async () => ({ ok: true, errors: [] }),
  listRecentJavaProjects: async () => [],
  linkJavaProject: async () => null,
  openRecentJavaProject: async () => null,
  refreshJavaProject: async () => null,
  installJavaSupport: async () => null,
  buildJavaCatalog: async () => null,
  cancelJavaCatalogBuild: async () => null,
  setDirty: (dirty) => { state.mainDirty = Boolean(dirty); state.dirtyValues.push(state.mainDirty); },
  publishAgentSession: (snapshot) => state.publishedProjects.push(clone(snapshot.project)),
  updateAgentProposalStatus: () => undefined,
  acknowledgeAgentProposal: () => undefined,
  getActiveAgentProposal: async () => null,
  getMcpStatus: async () => ({ enabled: false }),
  onMcpStatus: () => unsubscribe,
  onAgentProposal: () => unsubscribe,
  onMenuCommand: (listener) => { menuListener = listener; return () => { if (menuListener === listener) menuListener = null; }; },
  __benchmarkCommand: (command) => menuListener?.({ command }),
  __benchmarkConfigure: (options) => { state.saveDelayMs = Math.max(0, Number(options?.saveDelayMs) || 0); },
  __benchmarkReleaseRestore: () => releaseRestore(),
  __benchmarkState: () => clone(state),
});
