import { describe, expect, it } from "vitest";
import { createUnitPreferences } from "../src/renderer/lib/unitPreferences";
import { wheelZoomFactor } from "../src/renderer/lib/zoom";
import { loadRendererExport } from "./helpers/loadRendererExport";

interface PointerEventLike { pointerId: number; clientX?: number }
type PointerListener = (event: PointerEventLike) => void;

function unitPreferences(stored?: string) {
  const values = new Map<string, string>();
  if (stored !== undefined) values.set("bordeaux.unitSystem", stored);
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  return { prefs: createUnitPreferences(localStorage, document.documentElement), document, values };
}

function pointerDragHarness() {
  const listeners = new Map<string, PointerListener>();
  const captureListeners: string[] = [];
  let frame: FrameRequestCallback | null = null;
  const window = {
    addEventListener: (type: string, listener: PointerListener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as Record<string, unknown>;
  const target = {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    addEventListener: (type: string) => captureListeners.push(type),
    removeEventListener: () => undefined,
  };
  const document = { body: { style: { cursor: "" } } };
  const pointerDrag = loadRendererExport<{
    begin(
      event: PointerEventLike & { currentTarget: typeof target },
      handlers: { move: PointerListener; end?: PointerListener; cancel?: PointerListener; coalesce?: boolean },
    ): () => void;
  }>(new URL("../src/renderer/hooks/usePointerDrag.js", import.meta.url), "PointerDrag", {
    context: {
      document,
      React: {},
      requestAnimationFrame: (callback: FrameRequestCallback) => { frame = callback; return 1; },
      cancelAnimationFrame: () => { frame = null; },
    },
    window,
  });
  return {
    pointerDrag,
    target,
    captureListeners,
    dispatch: (type: string, event: PointerEventLike) => listeners.get(type)?.(event),
    flushFrame: () => { const pending = frame; frame = null; pending?.(0); },
  };
}

describe("renderer utilities", () => {
  it("converts display units without changing canonical SI values", () => {
    const { prefs, document, values } = unitPreferences();
    expect(prefs.current()).toBe("metric");
    expect(prefs.fromCanonical(1, "m")).toBe(1);

    prefs.set("imperial");
    expect(document.documentElement.dataset.units).toBe("imperial");
    expect(values.get("bordeaux.unitSystem")).toBe("imperial");
    expect(prefs.fromCanonical(1, "m")).toBeCloseTo(3.280839895, 9);
    expect(prefs.toCanonical(prefs.fromCanonical(2.4, "m/s"), "m/s")).toBeCloseTo(2.4, 12);
    expect(prefs.fromCanonical(1, "m", "in")).toBeCloseTo(39.37007874, 8);
    expect(prefs.label("kg·m²")).toBe("lb·ft²");
  });

  it("falls back to metric for an invalid stored unit preference", () => {
    expect(unitPreferences("yards").prefs.current()).toBe("metric");
  });

  it("normalizes and bounds wheel zoom across input devices", () => {
    const down = wheelZoomFactor(120, 0, 800);
    const up = wheelZoomFactor(-120, 0, 800);
    expect(down).toBeLessThanOrEqual(1.08);
    expect(down * up).toBeCloseTo(1, 12);
    expect(wheelZoomFactor(10, 0, 800)).toBeCloseTo(Math.pow(wheelZoomFactor(1, 0, 800), 10), 12);
    expect(wheelZoomFactor(10_000, 0, 800)).toBeCloseTo(down, 12);
    expect(wheelZoomFactor(3, 1, 800)).toBeGreaterThan(wheelZoomFactor(3, 0, 800));
  });

  it("flushes the final coalesced move before a fast drag commits", () => {
    const harness = pointerDragHarness();
    const edit = loadRendererExport<{
      create<T>(): {
        begin(value: T): boolean;
        update(value: T): boolean;
        finish(): T | null;
        getSnapshot(): T | null;
        subscribe(listener: () => void): () => void;
      };
    }>(new URL("../src/renderer/assets/path-edit.js", import.meta.url), "PathEdit").create<{ x: number }>();
    const committed: Array<{ x: number }> = [];
    const snapshots: Array<{ x: number } | null> = [];
    const canceled: number[] = [];
    edit.subscribe(() => snapshots.push(edit.getSnapshot()));
    harness.pointerDrag.begin({ currentTarget: harness.target, pointerId: 7 }, {
      coalesce: true,
      move: (event) => {
        if (event.clientX === undefined) return;
        if (!edit.getSnapshot()) edit.begin({ x: 0 });
        edit.update({ x: event.clientX });
      },
      end: () => { const value = edit.finish(); if (value) committed.push(value); },
      cancel: (event) => canceled.push(event.pointerId),
    });

    harness.dispatch("pointermove", { pointerId: 7, clientX: 20 });
    harness.dispatch("pointermove", { pointerId: 7, clientX: 80 });
    harness.dispatch("pointerup", { pointerId: 7, clientX: 80 });
    harness.flushFrame();

    expect(committed).toEqual([{ x: 80 }]);
    expect(snapshots).toEqual([{ x: 80 }, null]);
    expect(canceled).toEqual([]);
    expect(harness.captureListeners).not.toContain("lostpointercapture");
  });
});
