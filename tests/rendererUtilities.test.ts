import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function unitPreferences(stored?: string) {
  const values = new Map<string, string>();
  if (stored !== undefined) values.set("bordeaux.unitSystem", stored);
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  const window: Record<string, unknown> = {};
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const source = fs.readFileSync(new URL("../public/renderer/assets/unit-preferences.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { window, document, localStorage });
  return { prefs: window.UnitPrefs as any, document, values };
}

function fieldZoom() {
  const window: Record<string, unknown> = {};
  const source = fs.readFileSync(new URL("../public/renderer/assets/field-view.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { window, React: {}, Math });
  return window.FieldZoom as { wheelZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number };
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
    const { wheelZoomFactor } = fieldZoom();
    const down = wheelZoomFactor(120, 0, 800);
    const up = wheelZoomFactor(-120, 0, 800);
    expect(down).toBeLessThanOrEqual(1.08);
    expect(down * up).toBeCloseTo(1, 12);
    expect(wheelZoomFactor(10, 0, 800)).toBeCloseTo(Math.pow(wheelZoomFactor(1, 0, 800), 10), 12);
    expect(wheelZoomFactor(10_000, 0, 800)).toBeCloseTo(down, 12);
    expect(wheelZoomFactor(3, 1, 800)).toBeGreaterThan(wheelZoomFactor(3, 0, 800));
  });
});
