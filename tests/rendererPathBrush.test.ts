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
  corner?: boolean;
  segType?: string;
  segmentFollowMode?: string;
}
interface Path {
  waypoints: Waypoint[];
  ranges: Array<{ anchor: string; w0: number; w1: number; t0?: number; t1?: number }>;
}

function brush() {
  return loadRendererExport<{
    apply(path: Path, stroke: { kind: string; center: Point; previous: Point; radius: number; strength: number }): { path: Path; added: number; removed: number };
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

// Densely samples every segment so tests can compare curve shape rather than control-point
// bookkeeping: splitting or merging a segment moves handles while leaving the curve intact.
function samplePath(path: Path, perSegment = 30): Point[] {
  const samples: Point[] = [];
  for (let index = 0; index + 1 < path.waypoints.length; index++) {
    const start = path.waypoints[index];
    const end = path.waypoints[index + 1];
    for (let step = 0; step <= perSegment; step++) {
      const t = step / perSegment;
      const u = 1 - t;
      samples.push({
        x: u ** 3 * start.x + 3 * u ** 2 * t * start.nextC.x + 3 * u * t ** 2 * end.prevC.x + t ** 3 * end.x,
        y: u ** 3 * start.y + 3 * u ** 2 * t * start.nextC.y + 3 * u * t ** 2 * end.prevC.y + t ** 3 * end.y,
      });
    }
  }
  return samples;
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

  it("does not retangent an unmoved waypoint just outside the brush radius", () => {
    const path = straightPath();
    // A hand-shaped, deliberately unlinked waypoint sitting outside the brush.
    path.waypoints.splice(1, 0, {
      x: 5.5,
      y: 4,
      prevC: { x: 4.9, y: 3.4 },
      nextC: { x: 6.1, y: 4.6 },
      linked: false,
      theta: 0,
      thetaOn: false,
      stop: false,
      segType: "bezier",
    });
    const authored = { x: 5.5, y: 4, nextC: { x: 6.1, y: 4.6 } };
    const center = { x: 4.2, y: 4.4 };
    const radius = 1.2;
    expect(Math.hypot(authored.x - center.x, authored.y - center.y)).toBeGreaterThan(radius);

    brush().apply(path, { kind: "push", previous: { x: 4.2, y: 4 }, center, radius, strength: 1 });

    const survivor = path.waypoints.find((waypoint) => waypoint.x === authored.x && waypoint.y === authored.y);
    expect(survivor).toBeDefined();
    expect(survivor).toMatchObject({ nextC: authored.nextC, linked: false });
  });

  it("preserves local constraint-range anchors when a segment is split", () => {
    const path = straightPath();
    path.ranges = [{ anchor: "wp", w0: 0, t0: 0.25, w1: 0, t1: 0.75 }];
    brush().apply(path, {
      kind: "push",
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

  it("refuses a smooth merge that would reshape the curve outside the brush", () => {
    // Merging rewrites both neighbours' handles, which reach past a small brush. Sculpt a
    // curve first so the span around the merge candidate carries real curvature.
    const path = straightPath();
    const pathBrush = brush();
    pathBrush.apply(path, { kind: "push", previous: { x: 5.5, y: 4 }, center: { x: 5.5, y: 5 }, radius: 2.4, strength: 1 });
    pathBrush.apply(path, { kind: "push", previous: { x: 5.5, y: 5 }, center: { x: 6.2, y: 5.3 }, radius: 2.4, strength: 1 });

    const center = { x: 4.5, y: 4.7 };
    const radius = 0.8;
    const before = samplePath(path);

    pathBrush.apply(path, { kind: "smooth", previous: { x: 4.35, y: 4.65 }, center, radius, strength: 0.4 });

    // Samples the brush could not reach must still lie on the curve. Accepting the merge
    // here would drag them roughly 2cm.
    const after = samplePath(path);
    const outside = before.filter((sample) => Math.hypot(sample.x - center.x, sample.y - center.y) > radius);
    expect(outside.length).toBeGreaterThan(0);
    const drift = Math.max(...outside.map((sample) => Math.min(...after.map((other) => Math.hypot(sample.x - other.x, sample.y - other.y)))));
    expect(drift).toBeLessThan(0.002);
  });

  it("removes redundant waypoints while preserving local range positions", () => {
    const path = straightPath();
    path.waypoints.splice(1, 0, {
      x: 5.5,
      y: 4,
      prevC: { x: 4, y: 4 },
      nextC: { x: 7, y: 4 },
      linked: true,
      theta: 0,
      thetaOn: false,
      stop: false,
      segType: "bezier",
    });
    path.waypoints[0].nextC = { x: 2.5, y: 4 };
    path.waypoints[2].prevC = { x: 8.5, y: 4 };
    path.ranges = [{ anchor: "wp", w0: 0, t0: 0.5, w1: 1, t1: 0.5 }];

    const result = brush().apply(path, {
      kind: "smooth",
      previous: { x: 5.3, y: 4 },
      center: { x: 5.5, y: 4 },
      radius: 3,
      strength: 1,
    });

    expect(result).toMatchObject({ added: 0, removed: 1 });
    expect(path.waypoints).toHaveLength(2);
    expect(path.ranges[0]).toMatchObject({ w0: 0, w1: 0 });
    expect(path.ranges[0].t0).toBeCloseTo(0.25, 1);
    expect(path.ranges[0].t1).toBeCloseTo(0.75, 1);
  });

  it("keeps semantic and shape-defining waypoints", () => {
    const path = straightPath();
    path.waypoints.splice(1, 0, {
      x: 5.5,
      y: 6,
      prevC: { x: 4, y: 5.5 },
      nextC: { x: 7, y: 5.5 },
      linked: false,
      corner: true,
      theta: 90,
      thetaOn: true,
      stop: false,
      segType: "bezier",
    });

    const result = brush().apply(path, {
      kind: "smooth",
      previous: { x: 5.3, y: 6 },
      center: { x: 5.5, y: 6 },
      radius: 3,
      strength: 1,
    });

    expect(result.removed).toBe(0);
    expect(path.waypoints).toHaveLength(3);
    expect(path.waypoints[1]).toMatchObject({ x: 5.5, y: 6, corner: true, thetaOn: true });
  });

  it("keeps a non-semantic waypoint when merging would change the curve", () => {
    const path = straightPath();
    path.waypoints.splice(1, 0, {
      x: 5.5,
      y: 6,
      prevC: { x: 4.5, y: 6 },
      nextC: { x: 6.5, y: 6 },
      linked: true,
      theta: 0,
      thetaOn: false,
      stop: false,
      segType: "bezier",
    });

    const result = brush().apply(path, {
      kind: "smooth",
      previous: { x: 5.45, y: 6 },
      center: { x: 5.5, y: 6 },
      radius: 1,
      strength: 0.2,
    });

    expect(result.removed).toBe(0);
    expect(path.waypoints).toHaveLength(3);
  });

  it("keeps waypoint boundaries that change segment policy", () => {
    const path = straightPath();
    path.waypoints.splice(1, 0, {
      x: 5.5,
      y: 4,
      prevC: { x: 4, y: 4 },
      nextC: { x: 7, y: 4 },
      linked: true,
      theta: 0,
      thetaOn: false,
      stop: false,
      segType: "bezier",
      segmentFollowMode: "reverse",
    });

    const result = brush().apply(path, {
      kind: "smooth",
      previous: { x: 5.3, y: 4 },
      center: { x: 5.5, y: 4 },
      radius: 3,
      strength: 1,
    });

    expect(result.removed).toBe(0);
    expect(path.waypoints).toHaveLength(3);
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
