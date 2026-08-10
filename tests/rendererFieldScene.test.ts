import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

interface Point { x: number; y: number; s: number }
interface Range { start: number; end: number }

function fieldScene() {
  const window: Record<string, unknown> = {};
  const source = fs.readFileSync(new URL("../src/renderer/assets/field-scene.js", import.meta.url), "utf8")
    .replace("export const FieldScene =", "window.FieldScene =");
  vm.runInNewContext(source, { window, Object, Math, Number });
  return window.FieldScene as {
    fractionRange(points: Point[], total: number, first: number, last: number): Range;
    segmentRange(derived: { sample: { pts: Point[]; length: number }; wpIdx: number[] }, segment: number): Range;
    pathData(points: Point[], range: Range | null, project: (point: Point) => Point, precision?: number): string;
  };
}

describe("renderer field scene construction", () => {
  const points = Array.from({ length: 101 }, (_, index) => ({ x: index, y: index / 2, s: index }));

  it("finds fraction spans without scanning from the start", () => {
    expect(fieldScene().fractionRange(points, 100, 0.7, 0.8)).toEqual({ start: 69, end: 80 });
  });

  it("uses waypoint indexes as exact segment boundaries", () => {
    const derived = { sample: { pts: points, length: 100 }, wpIdx: [0, 30, 70, 100] };
    expect(fieldScene().segmentRange(derived, 1)).toEqual({ start: 30, end: 70 });
  });

  it("serializes only the requested point span", () => {
    let projections = 0;
    const data = fieldScene().pathData(points, { start: 30, end: 32 }, (point) => {
      projections += 1;
      return point;
    }, 1);
    expect(data).toBe("M 30.0 15.0 L 31.0 15.5 L 32.0 16.0");
    expect(projections).toBe(3);
  });
});

describe("renderer path hit testing", () => {
  it("keeps separate visits when a path crosses the same field point", () => {
    const window: Record<string, unknown> = {};
    const source = fs.readFileSync(new URL("../src/renderer/lib/pathMath.js", import.meta.url), "utf8")
      .replace("export const PM =", "window.PM =");
    vm.runInNewContext(source, { window, console, Math, Number, Set, Map, Infinity, isFinite });
    const math = window.PM as {
      nearestVisits(x: number, y: number, points: Array<Point & { seg: number; t: number; heading: number }>, options: { tolerance: number }): Array<{ f: number }>;
    };
    const crossing = [
      { x: -1, y: 0, s: 0, seg: 0, t: 0, heading: 0 },
      { x: 1, y: 0, s: 2, seg: 0, t: 1, heading: 0 },
      { x: 3, y: 3, s: 6, seg: 1, t: 0, heading: 1 },
      { x: 3, y: -3, s: 12, seg: 1, t: 1, heading: -1 },
      { x: 0, y: -1, s: 16, seg: 2, t: 0, heading: Math.PI / 2 },
      { x: 0, y: 1, s: 18, seg: 2, t: 1, heading: Math.PI / 2 },
    ];

    const visits = math.nearestVisits(0, 0, crossing, { tolerance: 0.1 });
    expect(visits).toHaveLength(2);
    expect(visits[0].f).toBeLessThan(visits[1].f);
  });
});
