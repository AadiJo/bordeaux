  /** A tiny external store that confines high-frequency canvas drafts to subscribers. */
  function create() {
    const listeners = new Set();
    let draft = null;
    const emit = () => listeners.forEach((listener) => listener());
    return {
      begin(value) {
        if (draft) return false;
        draft = value;
        return true;
      },
      update(value) {
        if (!draft) return false;
        draft = value;
        emit();
        return true;
      },
      finish() {
        if (!draft) return null;
        const value = draft;
        draft = null;
        emit();
        return value;
      },
      cancel() {
        if (!draft) return false;
        draft = null;
        emit();
        return true;
      },
      getSnapshot() {
        return draft;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

export const PathEdit = Object.freeze({ create });
