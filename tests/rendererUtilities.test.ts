import { afterEach, describe, expect, it, vi } from "vitest";
import { PointerDrag } from "../src/renderer/hooks/usePointerDrag";
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
  const windowListeners = new Map<string, Set<(event: any) => void>>();
  const targetListeners = new Map<string, Set<(event: any) => void>>();
  const add = (listeners: Map<string, Set<(event: any) => void>>, type: string, listener: (event: any) => void) => {
    const current = listeners.get(type) ?? new Set();
    current.add(listener);
    listeners.set(type, current);
  };
  const remove = (listeners: Map<string, Set<(event: any) => void>>, type: string, listener: (event: any) => void) => listeners.get(type)?.delete(listener);
  const window = {
    addEventListener: (type: string, listener: (event: any) => void) => add(windowListeners, type, listener),
    removeEventListener: (type: string, listener: (event: any) => void) => remove(windowListeners, type, listener),
  } as Record<string, any>;
  const target = {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    addEventListener: (type: string, listener: (event: any) => void) => add(targetListeners, type, listener),
    removeEventListener: (type: string, listener: (event: any) => void) => remove(targetListeners, type, listener),
  };
  const document = { body: { style: { cursor: "" } } };
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  const dispatch = (listeners: Map<string, Set<(event: any) => void>>, type: string, event: any) => {
    listeners.get(type)?.forEach((listener) => listener(event));
  };
  return {
    pointerDrag: PointerDrag,
    target,
    dispatchWindow: (type: string, event: any) => dispatch(windowListeners, type, event),
    dispatchTarget: (type: string, event: any) => dispatch(targetListeners, type, event),
  };
}

afterEach(() => vi.unstubAllGlobals());

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
      move: (event) => moved.push(event.clientX),
      end: (event) => ended.push(event.clientX),
      cancel: (event) => canceled.push(event.pointerId),
    });

    harness.dispatchWindow("pointermove", { pointerId: 7, clientX: 20 });
    harness.dispatchTarget("lostpointercapture", { pointerId: 7 });
    harness.dispatchWindow("pointermove", { pointerId: 7, clientX: 80 });
    harness.dispatchWindow("pointerup", { pointerId: 7, clientX: 80 });

    expect(moved).toEqual([20, 80]);
    expect(ended).toEqual([80]);
    expect(canceled).toEqual([]);
  });
});
