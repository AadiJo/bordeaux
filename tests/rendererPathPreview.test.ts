import { describe, expect, it } from "vitest";
import { PathPreview } from "../src/renderer/assets/path-preview";
import { processPathPreviewJob } from "../src/renderer/assets/path-preview-worker";

interface WorkerJob {
  id: number;
  quality: "interactive" | "final";
  perSegment: number;
}

class FakeWorker {
  readonly jobs: WorkerJob[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  postMessage(job: WorkerJob) {
    this.jobs.push(job);
  }

  resolve(data: unknown) {
    this.onmessage?.({ data });
  }

  terminate() {
    this.terminated = true;
  }
}

function previewModule(worker: FakeWorker) {
  return (PathPreview as {
    create(options: { workerFactory: () => FakeWorker }): {
      request(input: { path: unknown; robot: unknown; plannerId: string; quality: "interactive" | "final" }): number;
      getSnapshot(): { status: string; revision: number; quality: string; value: unknown };
      subscribe(listener: () => void): () => void;
      destroy(): void;
    };
    samplesForQuality(quality: string): number;
  });
}

describe("renderer path preview scheduler", () => {
  it("keeps only the latest replacement while a worker job is running", () => {
    const worker = new FakeWorker();
    const preview = previewModule(worker).create({ workerFactory: () => worker });
    const input = { path: {}, robot: {}, plannerId: "profiledSpline" };

    const first = preview.request({ ...input, quality: "interactive" });
    const second = preview.request({ ...input, quality: "interactive" });
    const third = preview.request({ ...input, quality: "final" });

    expect(worker.jobs.map((job) => job.id)).toEqual([first]);
    worker.resolve({ id: first, value: { stale: true }, durationMs: 12 });
    expect(worker.jobs.map((job) => job.id)).toEqual([first, third]);
    expect(worker.jobs).not.toContainEqual(expect.objectContaining({ id: second }));

    worker.resolve({ id: third, value: { fresh: true }, durationMs: 8 });
    expect(preview.getSnapshot()).toMatchObject({
      status: "ready",
      revision: third,
      quality: "final",
      value: { fresh: true },
    });
  });

  it("uses lower sampling quality for interaction and releases its worker", () => {
    const worker = new FakeWorker();
    const module = previewModule(worker);
    const preview = module.create({ workerFactory: () => worker });

    preview.request({ path: {}, robot: {}, plannerId: "profiledSpline", quality: "interactive" });
    expect(worker.jobs[0]).toMatchObject({ quality: "interactive", perSegment: 14 });
    expect(module.samplesForQuality("final")).toBe(56);

    preview.destroy();
    expect(worker.terminated).toBe(true);
  });
});

describe("renderer path preview worker", () => {
  it("derives the requested sampling quality and reports timing", () => {
    const result = processPathPreviewJob(
      { id: 7, path: {}, robot: {}, plannerId: "profiledSpline", quality: "interactive", perSegment: 14 },
      (_path: unknown, _robot: unknown, perSegment: number) => ({ perSegment }),
    );

    expect(result).toMatchObject({ id: 7, quality: "interactive", value: { perSegment: 14 } });
    expect(result).toHaveProperty("durationMs");
  });
});
