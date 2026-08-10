import { describe, expect, it } from "vitest";
import { loadRendererExport } from "./helpers/loadRendererExport";

interface WorkerJob { id: number; quality: "interactive" | "final"; perSegment: number }

class FakeWorker {
  readonly jobs: WorkerJob[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(job: WorkerJob) { this.jobs.push(job); }
  resolve(data: unknown) { this.onmessage?.({ data }); }
  terminate() { this.terminated = true; }
}

function previewModule() {
  return loadRendererExport<{
    create(options: { workerFactory: () => FakeWorker }): {
      request(input: { path: unknown; robot: unknown; plannerId: string; quality: "interactive" | "final"; key?: string }): number;
      getSnapshot(): { status: string; revision: number; quality: string; path: unknown; value: unknown };
      destroy(): void;
    };
    samplesForQuality(quality: string): number;
  }>(new URL("../src/renderer/assets/path-preview.js", import.meta.url), "PathPreview", {
    context: { performance, queueMicrotask },
    replacements: [[
      "const workerFactory = config.workerFactory || (() => new Worker(new URL('./path-preview-worker.js', import.meta.url), { type: 'module' }));",
      "const workerFactory = config.workerFactory;",
    ]],
  });
}

describe("renderer path preview scheduler", () => {
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
});
