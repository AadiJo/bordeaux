import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const ENABLED_KEY = "bordeaux.dev.optimizerShadow.enabled";
const METRICS_KEY = "bordeaux.dev.optimizerShadow.metrics.v1";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}

interface ShadowApi {
  enabled(): boolean;
  setEnabled(value: boolean): boolean;
  record(input: unknown): boolean;
  recordWorkerError(mode: string): boolean;
  snapshot(): {
    records: number;
    modes: Record<string, number>;
    statuses: Record<string, number>;
    plannerUsed: Record<string, number>;
    comparisons: Record<string, number>;
    solveTimeMs: { sum: number; max: number; histogram: Record<string, number> };
    deltaTimeS: { sum: number; min: number; max: number };
    constraintViolations: number;
    workerErrors: number;
    averages: Record<string, number>;
    percentiles: Record<string, number | null>;
  };
  clear(): boolean;
}

function shadowApi(storage = new MemoryStorage()) {
  const window = { localStorage: storage } as unknown as { BordeauxOptimizerShadow: ShadowApi };
  vm.runInNewContext(
    fs.readFileSync(new URL("../public/renderer/assets/optimizer-shadow.js", import.meta.url), "utf8"),
    { window, Object, Number, JSON, Math, String, Array, Set, Map },
  );
  return { api: window.BordeauxOptimizerShadow, storage };
}

describe("optimizer shadow metrics", () => {
  it("is disabled by default and never records project-shaped input while disabled", () => {
    const { api, storage } = shadowApi();
    expect(api.enabled()).toBe(false);
    expect(api.record({ project: { name: "private" } })).toBe(false);
    expect(storage.getItem(METRICS_KEY)).toBeNull();
  });

  it("stores only bounded aggregate timing and status fields", () => {
    const { api, storage } = shadowApi();
    expect(api.setEnabled(true)).toBe(true);
    expect(storage.getItem(ENABLED_KEY)).toBe("1");
    expect(api.record({
      mode: "profiled-shadow",
      project: { name: "do-not-store" },
      path: { id: "secret-path" },
      profiled: { prof: { totalTime: 2 } },
      optimized: {
        prof: { totalTime: 1.5 },
        optimization: {
          status: "optimal",
          plannerUsed: "optimizedTrajectory",
          solveTimeMs: 3.25,
          constraintViolations: 0,
          fallback: false,
        },
      },
    })).toBe(true);

    const snapshot = api.snapshot();
    expect(snapshot).toMatchObject({
      records: 1,
      modes: { "profiled-shadow": 1, "optimized-opt-in": 0 },
      statuses: { optimal: 1 },
      plannerUsed: { optimizedTrajectory: 1 },
      comparisons: { faster: 1, equal: 0, slower: 0 },
      solveTimeMs: { sum: 3.25, max: 3.25, histogram: { "5": 1 } },
      deltaTimeS: { sum: -0.5, min: -0.5, max: -0.5 },
      constraintViolations: 0,
      workerErrors: 0,
      averages: { solveTimeMs: 3.25, profiledTimeS: 2, optimizedTimeS: 1.5, deltaTimeS: -0.5 },
      percentiles: { solveTimeP50UpperBoundMs: 5, solveTimeP95UpperBoundMs: 5 },
    });
    expect(storage.getItem(METRICS_KEY)).not.toMatch(/do-not-store|secret-path|project|path/);
  });

  it("classifies worker failures without storing their messages", () => {
    const { api, storage } = shadowApi();
    api.setEnabled(true);
    expect(api.recordWorkerError("optimized-opt-in")).toBe(true);
    expect(api.snapshot()).toMatchObject({
      records: 1,
      modes: { "optimized-opt-in": 1 },
      statuses: { "worker-error": 1 },
      workerErrors: 1,
    });
    expect(storage.getItem(METRICS_KEY)).not.toContain("message");
  });

  it("recovers from malformed nested counters and enforces the record ceiling", () => {
    const { api, storage } = shadowApi();
    api.setEnabled(true);
    storage.setItem(METRICS_KEY, JSON.stringify({
      schemaVersion: 1,
      records: 1_000_000,
      statuses: { optimal: "many" },
      modes: null,
      solveTimeMs: { sum: "fast", max: null },
    }));
    expect(api.snapshot()).toMatchObject({ records: 1_000_000, statuses: { optimal: 0 }, solveTimeMs: { sum: 0, max: 0 } });
    expect(api.record({})).toBe(false);
    expect(api.clear()).toBe(true);
    expect(api.snapshot().records).toBe(0);
  });
});
