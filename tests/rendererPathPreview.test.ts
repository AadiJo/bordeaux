import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRendererExport } from "./helpers/loadRendererExport";

interface WorkerJob { id: number; quality: "interactive" | "final"; perSegment: number }

class FakeWorker {
  readonly jobs: WorkerJob[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessageerror: ((event: { data?: unknown }) => void) | null = null;
  postError: Error | null = null;
  postMessage(job: WorkerJob) {
    if (this.postError) throw this.postError;
    this.jobs.push(job);
  }
  resolve(data: unknown) { this.onmessage?.({ data }); }
  fail(message = "worker failed") { this.onerror?.({ message }); }
  failMessage(data?: unknown) { this.onmessageerror?.({ data }); }
  terminate() { this.terminated = true; }
}

function previewModule() {
  return loadRendererExport<{
    create(options: { workerFactory: () => FakeWorker; derive?: (job: unknown) => unknown; timeoutMs?: number }): {
      request(input: { path: unknown; robot: unknown; plannerId: string; quality: "interactive" | "final"; key?: string }): number;
      getSnapshot(): { status: string; revision: number; quality: string; path: unknown; value: unknown };
      retain(): () => void;
      destroy(): void;
    };
    samplesForQuality(quality: string): number;
  }>(new URL("../src/renderer/assets/path-preview.js", import.meta.url), "PathPreview", {
    context: { performance, queueMicrotask, setTimeout, clearTimeout },
    replacements: [[
      "const workerFactory = config.workerFactory || (() => new Worker(new URL('./path-preview-worker.js', import.meta.url), { type: 'module' }));",
      "const workerFactory = config.workerFactory;",
    ]],
  });
}

describe("renderer path preview scheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("does not allocate a worker until the scheduler receives work", () => {
    const worker = new FakeWorker();
    let allocations = 0;
    const preview = previewModule().create({ workerFactory: () => { allocations += 1; return worker; } });

    expect(allocations).toBe(0);
    preview.request({ path: {}, robot: {}, plannerId: "profiledSpline", quality: "interactive" });
    expect(allocations).toBe(1);
    preview.destroy();
  });

  it("keeps only the latest replacement while a worker job is running", () => {
    const worker = new FakeWorker();
    const module = previewModule();
    const preview = module.create({ workerFactory: () => worker });
    const input = { path: {}, robot: {}, plannerId: "profiledSpline" };

    const first = preview.request({ ...input, quality: "interactive" });
    const second = preview.request({ ...input, quality: "interactive" });
    const third = preview.request({ ...input, quality: "final" });

    expect(worker.jobs).toEqual([expect.objectContaining({ id: first, quality: "interactive", perSegment: 14 })]);
    worker.resolve({ id: first, value: { stale: true }, durationMs: 12 });
    expect(worker.jobs.map((job) => job.id)).toEqual([first, third]);
    expect(worker.jobs).not.toContainEqual(expect.objectContaining({ id: second }));
    expect(worker.jobs[1]).toMatchObject({ quality: "final", perSegment: 56 });

    worker.resolve({ id: third, value: { fresh: true }, durationMs: 8 });
    expect(preview.getSnapshot()).toMatchObject({
      status: "ready",
      revision: third,
      quality: "final",
      value: { fresh: true },
    });
    expect(module.samplesForQuality("final")).toBe(56);
    preview.destroy();
    expect(worker.terminated).toBe(true);
  });

  it("retains exact source provenance until its replacement completes", () => {
    const worker = new FakeWorker();
    const preview = previewModule().create({ workerFactory: () => worker });
    const firstPath = { id: "same-id", waypointX: 0 };
    const secondPath = { id: "same-id", waypointX: 10 };
    const first = preview.request({ path: firstPath, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: firstPath.id });
    worker.resolve({ id: first, value: { waypointX: 0 }, durationMs: 1 });

    preview.request({ path: secondPath, robot: {}, plannerId: "profiledSpline", quality: "final", key: secondPath.id });

    expect(preview.getSnapshot()).toMatchObject({
      status: "pending",
      key: firstPath.id,
      path: firstPath,
      value: { waypointX: 0 },
    });
    expect(preview.getSnapshot().path).not.toBe(secondPath);
  });

  it("publishes completed geometry while a newer drag request is queued", () => {
    const worker = new FakeWorker();
    const preview = previewModule().create({ workerFactory: () => worker });
    const firstPath = { id: "path", x: 1 };
    const nextPath = { id: "path", x: 2 };
    const first = preview.request({ path: firstPath, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: firstPath.id });
    preview.request({ path: nextPath, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: nextPath.id });

    worker.resolve({ id: first, value: { x: 1 }, durationMs: 2 });

    expect(preview.getSnapshot()).toMatchObject({ status: "pending", path: firstPath, value: { x: 1 } });
  });

  it("replaces a failed worker before processing the queued preview", () => {
    const workers = [new FakeWorker(), new FakeWorker()];
    let workerIndex = 0;
    const preview = previewModule().create({ workerFactory: () => workers[workerIndex++] });
    const first = preview.request({ path: { id: "path", x: 1 }, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: "path" });
    const second = preview.request({ path: { id: "path", x: 2 }, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: "path" });

    workers[0].fail();

    expect(workers[0].terminated).toBe(true);
    expect(workers[1].jobs).toEqual([expect.objectContaining({ id: second })]);
    expect(workers[1].jobs).not.toContainEqual(expect.objectContaining({ id: first }));
  });

  it("falls back to direct derivation when a retried worker job also fails", async () => {
    const workers = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
    let workerIndex = 0;
    const preview = previewModule().create({
      workerFactory: () => workers[workerIndex++],
      derive: () => ({ recovered: true }),
    });
    const revision = preview.request({ path: { id: "path" }, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: "path" });

    workers[0].fail();
    workers[1].fail();
    await Promise.resolve();

    expect(workerIndex).toBe(2);
    expect(preview.getSnapshot()).toMatchObject({ status: "ready", revision, value: { recovered: true } });

    const nextRevision = preview.request({ path: { id: "path", x: 2 }, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: "path" });
    expect(workerIndex).toBe(3);
    workers[2].resolve({ id: nextRevision, value: { recovered: "worker" }, durationMs: 1 });
    expect(preview.getSnapshot()).toMatchObject({ status: "ready", revision: nextRevision, value: { recovered: "worker" } });
  });

  it("recovers when posting to the worker throws", async () => {
    const workers = [new FakeWorker(), new FakeWorker()];
    workers[0].postError = new DOMException("could not clone", "DataCloneError");
    let workerIndex = 0;
    const preview = previewModule().create({ workerFactory: () => workers[workerIndex++] });

    const revision = preview.request({ path: { id: "path" }, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: "path" });

    expect(workers[0].terminated).toBe(true);
    expect(workers[1].jobs).toEqual([expect.objectContaining({ id: revision })]);
    workers[1].resolve({ id: revision, value: { recovered: true }, durationMs: 1 });
    expect(preview.getSnapshot()).toMatchObject({ status: "ready", revision, value: { recovered: true } });
  });

  it.each(["messageerror", "invalid response"])("recovers from a worker %s", (failure) => {
    const workers = [new FakeWorker(), new FakeWorker()];
    let workerIndex = 0;
    const preview = previewModule().create({ workerFactory: () => workers[workerIndex++] });
    const revision = preview.request({ path: { id: "path" }, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: "path" });

    if (failure === "messageerror") workers[0].failMessage();
    else workers[0].resolve({ id: revision + 1, value: { wrong: true } });

    expect(workers[0].terminated).toBe(true);
    expect(workers[1].jobs).toEqual([expect.objectContaining({ id: revision })]);
  });

  it("recovers when a worker stops responding", async () => {
    vi.useFakeTimers();
    const workers = [new FakeWorker(), new FakeWorker()];
    let workerIndex = 0;
    const preview = previewModule().create({
      workerFactory: () => workers[workerIndex++],
      derive: () => ({ recovered: true }),
      timeoutMs: 20,
    });
    const revision = preview.request({ path: { id: "path" }, robot: {}, plannerId: "profiledSpline", quality: "interactive", key: "path" });

    await vi.advanceTimersByTimeAsync(20);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].jobs).toEqual([expect.objectContaining({ id: revision })]);
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    expect(preview.getSnapshot()).toMatchObject({ status: "ready", revision, value: { recovered: true } });
  });

  it("survives a StrictMode cleanup followed immediately by remount", async () => {
    const worker = new FakeWorker();
    const preview = previewModule().create({ workerFactory: () => worker });
    const release = preview.retain();
    preview.request({ path: {}, robot: {}, plannerId: "profiledSpline", quality: "interactive" });
    release();
    const releaseAfterReplay = preview.retain();
    await Promise.resolve();

    expect(worker.terminated).toBe(false);
    releaseAfterReplay();
    await Promise.resolve();
    expect(worker.terminated).toBe(true);
  });
});
