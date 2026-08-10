import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { createUnitPreferences } from "../src/renderer/lib/unitPreferences";
import { wheelZoomFactor } from "../src/renderer/lib/zoom";

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
  interface PointerEventLike { pointerId: number; clientX?: number }
  type Listener = (event: PointerEventLike) => void;
  const windowListeners = new Map<string, Set<Listener>>();
  const targetListeners = new Map<string, Set<Listener>>();
  const add = (listeners: Map<string, Set<Listener>>, type: string, listener: Listener) => {
    const current = listeners.get(type) ?? new Set();
    current.add(listener);
    listeners.set(type, current);
  };
  const remove = (listeners: Map<string, Set<Listener>>, type: string, listener: Listener) => listeners.get(type)?.delete(listener);
  const window = {
    addEventListener: (type: string, listener: Listener) => add(windowListeners, type, listener),
    removeEventListener: (type: string, listener: Listener) => remove(windowListeners, type, listener),
  } as Record<string, unknown>;
  const target = {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    addEventListener: (type: string, listener: Listener) => add(targetListeners, type, listener),
    removeEventListener: (type: string, listener: Listener) => remove(targetListeners, type, listener),
  };
  const document = { body: { style: { cursor: "" } } };
  const source = fs.readFileSync(new URL("../src/renderer/hooks/usePointerDrag.js", import.meta.url), "utf8")
    .replace('import * as React from "react";\n', "")
    .replace("export const PointerDrag =", "window.PointerDrag =");
  vm.runInNewContext(source, { window, document, React: {} });
  const dispatch = (listeners: Map<string, Set<Listener>>, type: string, event: PointerEventLike) => {
    listeners.get(type)?.forEach((listener) => listener(event));
  };
  return {
    pointerDrag: window.PointerDrag as {
      begin(
        event: PointerEventLike & { currentTarget: typeof target },
        handlers: { move: Listener; end?: Listener; cancel?: Listener },
      ): () => void;
    },
    target,
    dispatchWindow: (type: string, event: any) => dispatch(windowListeners, type, event),
    dispatchTarget: (type: string, event: any) => dispatch(targetListeners, type, event),
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

  it("finishes fast drags globally and ignores stale capture-loss events", () => {
    const harness = pointerDragHarness();
    const moved: number[] = [];
    const ended: number[] = [];
    const canceled: number[] = [];
    harness.pointerDrag.begin({ currentTarget: harness.target, pointerId: 7 }, {
      move: (event) => moved.push(event.pointerId),
      end: (event) => ended.push(event.pointerId),
      cancel: (event) => canceled.push(event.pointerId),
    });

    harness.dispatchWindow("pointermove", { pointerId: 7 });
    harness.dispatchTarget("lostpointercapture", { pointerId: 99 });
    harness.dispatchWindow("pointerup", { pointerId: 7 });

    expect(moved).toEqual([7]);
    expect(ended).toEqual([7]);
    expect(canceled).toEqual([]);
  });

  it("continues an active drag after pointer capture is lost", () => {
    const harness = pointerDragHarness();
    const moved: number[] = [];
    const ended: number[] = [];
    const canceled: number[] = [];
    harness.pointerDrag.begin({ currentTarget: harness.target, pointerId: 7 }, {
      move: (event) => { if (event.clientX !== undefined) moved.push(event.clientX); },
      end: (event) => { if (event.clientX !== undefined) ended.push(event.clientX); },
      cancel: (event) => canceled.push(event.pointerId),
    });

    harness.dispatchTarget("lostpointercapture", { pointerId: 7 });
    harness.dispatchWindow("pointermove", { pointerId: 7, clientX: 20 });
    harness.dispatchTarget("lostpointercapture", { pointerId: 7 });
    harness.dispatchWindow("pointermove", { pointerId: 7, clientX: 80 });
    harness.dispatchWindow("pointerup", { pointerId: 7, clientX: 80 });

    expect(moved).toEqual([20, 80]);
    expect(ended).toEqual([80]);
    expect(canceled).toEqual([]);
  });
});
