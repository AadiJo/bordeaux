import { describe, expect, it } from "vitest";
import { loadRendererExport } from "./helpers/loadRendererExport";

interface Point { x: number; y: number }
interface Waypoint extends Point {
  prevC: Point;
  nextC: Point;
  linked: boolean;
  theta: number;
  thetaOn: boolean;
  stop: boolean;
  segType?: string;
}
interface Path {
  waypoints: Waypoint[];
  ranges: Array<{ anchor: string; w0: number; w1: number; t0?: number; t1?: number }>;
}

function brush() {
  return loadRendererExport<{
    apply(path: Path, stroke: { kind: string; center: Point; previous: Point; radius: number; strength: number }): { path: Path; added: number };
  }>(new URL("../src/renderer/lib/pathBrush.js", import.meta.url), "PathBrush");
}

function straightPath(): Path {
  return {
    waypoints: [
      { x: 1, y: 4, prevC: { x: 1, y: 4 }, nextC: { x: 4, y: 4 }, linked: true, theta: 0, thetaOn: true, stop: false, segType: "bezier" },
      { x: 10, y: 4, prevC: { x: 7, y: 4 }, nextC: { x: 10, y: 4 }, linked: true, theta: 0, thetaOn: true, stop: false },
    ],
    ranges: [{ anchor: "wp", w0: 0, w1: 1 }],
  };
}

describe("path sculpting brushes", () => {
  it("subdivides only the influenced curve and pushes the new waypoints", () => {
    const path = straightPath();
    const result = brush().apply(path, {
      kind: "push",
      previous: { x: 5.5, y: 4 },
      center: { x: 5.5, y: 5 },
      radius: 1.6,
      strength: 1,
    });

    expect(result.added).toBeGreaterThan(1);
    expect(path.waypoints.length).toBe(2 + result.added);
    expect(path.waypoints[0]).toMatchObject({ x: 1, y: 4 });
    expect(path.waypoints.at(-1)).toMatchObject({ x: 10, y: 4 });
    expect(path.waypoints.slice(1, -1).some((waypoint) => waypoint.y > 4.1)).toBe(true);
    expect(path.ranges[0].w1).toBe(path.waypoints.length - 1);
    expect(path.waypoints.every((waypoint) => [waypoint.x, waypoint.y, waypoint.prevC.x, waypoint.nextC.y].every(Number.isFinite))).toBe(true);
  });

  it("preserves local constraint-range anchors when a segment is split", () => {
    const path = straightPath();
    path.ranges = [{ anchor: "wp", w0: 0, t0: 0.25, w1: 0, t1: 0.75 }];
    brush().apply(path, {
      kind: "smooth",
      previous: { x: 5.5, y: 4 },
      center: { x: 5.5, y: 4 },
      radius: 4,
      strength: 1,
    });

    const position = (waypointIndex: number, local: number) => {
      const start = path.waypoints[waypointIndex];
      const end = path.waypoints[waypointIndex + 1];
      const oneMinusT = 1 - local;
      return oneMinusT ** 3 * start.x
        + 3 * oneMinusT ** 2 * local * start.nextC.x
        + 3 * oneMinusT * local ** 2 * end.prevC.x
        + local ** 3 * end.x;
    };
    const range = path.ranges[0];
    expect(position(range.w0, range.t0 ?? 0)).toBeCloseTo(3.25, 2);
    expect(position(range.w1, range.t1 ?? 0)).toBeCloseTo(7.75, 2);
  });

  it("does not keep adding topology after local spacing is dense enough", () => {
    const path = straightPath();
    const pathBrush = brush();
    const stroke = { kind: "push", previous: { x: 5, y: 4 }, center: { x: 5.1, y: 4.2 }, radius: 1, strength: 0.6 };
    const first = pathBrush.apply(path, stroke);
    const count = path.waypoints.length;
    const second = pathBrush.apply(path, { ...stroke, previous: stroke.center, center: { x: 5.2, y: 4.3 } });

    expect(first.added).toBeGreaterThan(0);
    expect(second.added).toBeLessThanOrEqual(2);
    expect(path.waypoints.length).toBeLessThanOrEqual(count + 2);
  });

  it("smooths noisy waypoints and twirls a curve around the brush center", () => {
    const path = straightPath();
    const pathBrush = brush();
    pathBrush.apply(path, { kind: "push", previous: { x: 5.5, y: 4 }, center: { x: 5.5, y: 5.2 }, radius: 2, strength: 1 });
    const peakBefore = Math.max(...path.waypoints.map((waypoint) => waypoint.y));
    pathBrush.apply(path, { kind: "smooth", previous: { x: 5.3, y: 5 }, center: { x: 5.7, y: 5 }, radius: 2.2, strength: 1 });
    const peakAfter = Math.max(...path.waypoints.map((waypoint) => waypoint.y));
    expect(peakAfter).toBeLessThan(peakBefore);

    const before = path.waypoints.map(({ x, y }) => ({ x, y }));
    pathBrush.apply(path, { kind: "twirl", previous: { x: 5.2, y: 4.7 }, center: { x: 5.8, y: 4.7 }, radius: 2, strength: 0.8 });
    expect(path.waypoints.some((waypoint, index) => Math.hypot(waypoint.x - before[index].x, waypoint.y - before[index].y) > 0.01)).toBe(true);
  });
});
