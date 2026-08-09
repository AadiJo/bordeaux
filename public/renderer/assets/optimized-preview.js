// Owns the cancellable worker boundary for optimized renderer previews.
(function () {
  class OptimizedPreviewController {
    constructor(workerUrl, WorkerType) {
      this.workerUrl = workerUrl || 'assets/trajectory-worker.js';
      this.WorkerType = WorkerType || window.Worker;
      this.generation = 0;
      this.worker = null;
    }

    request(payload, onResult, onError) {
      this.cancel();
      const generation = ++this.generation;
      const worker = new this.WorkerType(this.workerUrl);
      this.worker = worker;
      worker.onmessage = (event) => {
        if (this.worker !== worker || !event.data || event.data.generation !== generation) return;
        this.worker = null;
        worker.terminate();
        if (event.data.ok) onResult(event.data.value, generation);
        else onError(new Error(event.data.error || 'Optimized preview failed.'), generation);
      };
      worker.onerror = (event) => {
        if (this.worker !== worker || generation !== this.generation) return;
        this.worker = null;
        worker.terminate();
        onError(new Error(event.message || 'Optimized preview worker failed.'), generation);
      };
      worker.postMessage({ ...payload, generation });
      return generation;
    }

    cancel() {
      this.generation += 1;
      if (this.worker) this.worker.terminate();
      this.worker = null;
    }
  }

  window.OptimizedPreviewController = OptimizedPreviewController;
})();
