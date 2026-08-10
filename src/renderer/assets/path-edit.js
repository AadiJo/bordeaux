  /** A tiny external store that confines high-frequency canvas drafts to subscribers. */
  function create() {
    const listeners = new Set();
    let draft = null;
    let revision = 0;
    let cancelRevision = 0;
    let lastResolution = null;
    const emit = () => listeners.forEach((listener) => listener());
    return {
      begin(value) {
        if (draft) return false;
        draft = value;
        lastResolution = null;
        revision += 1;
        return true;
      },
      update(value) {
        if (!draft) return false;
        draft = value;
        revision += 1;
        emit();
        return true;
      },
      finish() {
        if (!draft) return null;
        const value = draft;
        draft = null;
        lastResolution = 'finish';
        revision += 1;
        emit();
        return value;
      },
      cancel() {
        const hadDraft = Boolean(draft);
        draft = null;
        if (hadDraft) lastResolution = 'cancel';
        if (hadDraft) revision += 1;
        cancelRevision += 1;
        emit();
        return hadDraft;
      },
      getSnapshot() {
        return draft;
      },
      getRevision() {
        return revision;
      },
      getCancelRevision() {
        return cancelRevision;
      },
      getLastResolution() {
        return lastResolution;
      },
      materialize(project) {
        if (!draft || !project || !Array.isArray(project.paths)) return project;
        const index = project.paths.findIndex((path) => path.id === draft.id);
        if (index < 0 || project.paths[index] === draft) return project;
        const paths = project.paths.slice();
        paths[index] = draft;
        return { ...project, paths };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

export const PathEdit = Object.freeze({ create });
