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
    const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(1, config.timeoutMs) : 5000;
    let worker = null;
    let inFlight = null;
    let inFlightTimer = 0;
    let queued = null;
    let directScheduled = false;
    let latestRevision = 0;
    let publishedRevision = 0;
    let destroyed = false;
    let retainCount = 0;
    let retireRevision = 0;
    let snapshot = {
      status: 'idle',
      revision: 0,
      quality: 'final',
      key: null,
      path: null,
      value: null,
      error: null,
      errorKey: null,
      errorPath: null,
      durationMs: 0,
    };

    const notify = () => {
      listeners.forEach((listener) => listener());
    };

    const publish = (job, result) => {
      if (destroyed || job.revision < publishedRevision) return;
      const current = job.revision === latestRevision;
      if (result.error && !current) return;
      if (!result.error) publishedRevision = job.revision;
      snapshot = result.error
        ? { ...snapshot, status: 'error', revision: latestRevision, sourceRevision: job.revision, quality: job.quality, error: result.error, errorKey: job.key, errorPath: job.path }
        : {
            status: current ? 'ready' : 'pending',
            revision: latestRevision,
            sourceRevision: job.revision,
            quality: job.quality,
            key: job.key,
            path: job.path,
            value: result.value,
            error: null,
            errorKey: null,
            errorPath: null,
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

    const clearInFlightTimer = () => {
      if (inFlightTimer) clearTimeout(inFlightTimer);
      inFlightTimer = 0;
    };

    const takeInFlight = () => {
      const job = inFlight;
      inFlight = null;
      clearInFlightTimer();
      return job;
    };

    let recoverWorker;
    const send = (job) => {
      const targetWorker = worker;
      if (!targetWorker) {
        queued = job;
        runDirect();
        return;
      }
      inFlight = job;
      clearInFlightTimer();
      inFlightTimer = setTimeout(() => recoverWorker(targetWorker, 'Path preview worker timed out.'), timeoutMs);
      try {
        targetWorker.postMessage({
          id: job.revision,
          path: job.path,
          robot: job.robot,
          plannerId: job.plannerId,
          perSegment: job.perSegment,
          quality: job.quality,
        });
      } catch (error) {
        recoverWorker(targetWorker, error instanceof Error ? error.message : String(error));
      }
    };

    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      queued = null;
      takeInFlight();
      listeners.clear();
      if (worker) worker.terminate();
      worker = null;
    };

    const attachWorker = (nextWorker) => {
      worker = nextWorker;
      nextWorker.onmessage = (event) => {
        if (worker !== nextWorker || !inFlight) return;
        if (!event.data || event.data.id !== inFlight.revision) {
          recoverWorker(nextWorker, 'Path preview worker returned an invalid response.');
          return;
        }
        const completed = takeInFlight();
        publish(completed, event.data);
        if (queued) {
          const next = queued;
          queued = null;
          send(next);
        }
      };
      nextWorker.onerror = (event) => {
        recoverWorker(nextWorker, event.message || 'Path preview worker failed.');
      };
      nextWorker.onmessageerror = () => recoverWorker(nextWorker, 'Path preview worker returned an unreadable response.');
    };

    recoverWorker = (failedWorker, message) => {
      if (worker !== failedWorker || destroyed) return;
      const completed = takeInFlight();
      failedWorker.terminate();
      worker = null;
      if (!queued && completed && completed.retried) {
        queued = completed;
        runDirect();
        return;
      }
      let next = queued;
      queued = null;
      if (!next && completed) next = { ...completed, retried: true };
      if (!next) return;
      try {
        attachWorker(workerFactory());
        send(next);
      } catch (_error) {
        worker = null;
        queued = next;
        runDirect();
      }
    };

    const ensureWorker = () => {
      if (worker || destroyed) return Boolean(worker);
      try {
        attachWorker(workerFactory());
      } catch (_error) {
        worker = null;
      }
      return Boolean(worker);
    };

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
        snapshot = { ...snapshot, status: 'pending', revision: job.revision, quality, error: null, errorKey: null, errorPath: null };
        notify();
        ensureWorker();
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
      retain() {
        if (destroyed) return () => {};
        retainCount += 1;
        retireRevision += 1;
        let retained = true;
        return () => {
          if (!retained || destroyed) return;
          retained = false;
          retainCount -= 1;
          const revision = ++retireRevision;
          queueMicrotask(() => {
            if (!destroyed && retainCount === 0 && revision === retireRevision) destroy();
          });
        };
      },
      destroy,
    };
  }

export const PathPreview = Object.freeze({ create, samplesForQuality });
