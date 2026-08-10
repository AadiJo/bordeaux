import { PM } from "../lib/pathMath";

  const SAMPLES_BY_QUALITY = Object.freeze({ interactive: 14, final: 56 });

  function samplesForQuality(quality) {
    return SAMPLES_BY_QUALITY[quality] || SAMPLES_BY_QUALITY.final;
  }

  /**
   * Owns path-preview scheduling. At most one worker job and one replacement job
   * are retained, so pointer motion cannot build an obsolete rendering backlog.
   */
  function create(options) {
    const config = options || {};
    const listeners = new Set();
    const derive = config.derive || ((job) => PM.derivePath(job.path, job.robot, job.perSegment, job.plannerId));
    const workerFactory = config.workerFactory || (() => new Worker(new URL('./path-preview-worker.js', import.meta.url), { type: 'module' }));
    let worker = null;
    let inFlight = null;
    let queued = null;
    let directScheduled = false;
    let latestRevision = 0;
    let destroyed = false;
    let snapshot = {
      status: 'idle',
      revision: 0,
      quality: 'final',
      value: null,
      error: null,
      durationMs: 0,
    };

    try {
      worker = workerFactory();
    } catch (_error) {
      worker = null;
    }

    const notify = () => {
      listeners.forEach((listener) => listener());
    };

    const publish = (job, result) => {
      if (destroyed || job.revision !== latestRevision) return;
      snapshot = result.error
        ? { ...snapshot, status: 'error', revision: job.revision, quality: job.quality, error: result.error }
        : {
            status: 'ready',
            revision: job.revision,
            quality: job.quality,
            value: result.value,
            error: null,
            durationMs: result.durationMs || 0,
          };
      notify();
    };

    const runDirect = () => {
      if (directScheduled || destroyed) return;
      directScheduled = true;
      queueMicrotask(() => {
        directScheduled = false;
        const job = queued;
        queued = null;
        if (!job || destroyed) return;
        const startedAt = performance.now();
        try {
          publish(job, { value: derive(job), durationMs: performance.now() - startedAt });
        } catch (error) {
          publish(job, { error: { message: error instanceof Error ? error.message : String(error) } });
        }
        if (queued) runDirect();
      });
    };

    const send = (job) => {
      inFlight = job;
      worker.postMessage({
        id: job.revision,
        path: job.path,
        robot: job.robot,
        plannerId: job.plannerId,
        perSegment: job.perSegment,
        quality: job.quality,
      });
    };

    if (worker) {
      worker.onmessage = (event) => {
        const completed = inFlight;
        inFlight = null;
        if (completed && event.data.id === completed.revision) publish(completed, event.data);
        if (queued) {
          const next = queued;
          queued = null;
          send(next);
        }
      };
      worker.onerror = (event) => {
        const completed = inFlight;
        inFlight = null;
        if (completed) publish(completed, { error: { message: event.message || 'Path preview worker failed.' } });
        if (queued) {
          const next = queued;
          queued = null;
          send(next);
        }
      };
    }

    return {
      request(input) {
        if (destroyed) return latestRevision;
        const quality = input.quality === 'interactive' ? 'interactive' : 'final';
        const job = {
          ...input,
          quality,
          perSegment: samplesForQuality(quality),
          revision: ++latestRevision,
        };
        snapshot = { ...snapshot, status: 'pending', revision: job.revision, quality, error: null };
        notify();
        if (!worker) {
          queued = job;
          runDirect();
        } else if (inFlight) {
          queued = job;
        } else {
          send(job);
        }
        return job.revision;
      },
      getSnapshot() {
        return snapshot;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      destroy() {
        destroyed = true;
        queued = null;
        listeners.clear();
        if (worker) worker.terminate();
      },
    };
  }

export const PathPreview = Object.freeze({ create, samplesForQuality });
