import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { getPlanner } from "../src/shared/planners";
import { minimumPathClearance } from "../src/shared/agent/pathAnalysis";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import type { BordeauxProject, PathDoc } from "../src/shared/types";

interface RendererDerived {
  sample: { pts: Array<{ x: number; y: number; s: number }>; length: number };
  prof: { t: number[]; totalTime: number };
  metrics: { v: number[]; head: number[] };
  optimization?: {
    plannerUsed?: string;
    status?: string;
    refinementPasses?: number;
    validatedPoints?: number;
    constraintViolations?: number;
    solveTimeMs?: number;
    totalTimeS?: number;
    maxVelocityMps?: number;
    maxAccelerationMps2?: number;
    translationPriorityStart?: number | null;
    activeConstraints?: string[];
  };
  rev: boolean;
}

function rendererMath() {
  const window: Record<string, unknown> = {};
  const context = { window, console, Math, Number, Set, Map, Infinity, isFinite, Error, Array, Object };
  for (const asset of ["trajectory-optimizer.js", "path-math.js"]) {
    vm.runInNewContext(
      fs.readFileSync(new URL(`../public/renderer/assets/${asset}`, import.meta.url), "utf8"),
      context,
    );
  }
  return window.PM as { derivePath(path: PathDoc, robot: BordeauxProject["robot"], perSegment: number, plannerId: string): RendererDerived };
}

function rendererGeometryOptimizer() {
  const window: Record<string, unknown> = {};
  const context = { window, console, Math, Number, Set, Map, Infinity, isFinite, Error, Array, Object, JSON };
  for (const asset of ["trajectory-optimizer.js", "path-math.js", "trajectory-clearance.js", "trajectory-geometry-optimizer.js"]) {
    vm.runInNewContext(
      fs.readFileSync(new URL(`../public/renderer/assets/${asset}`, import.meta.url), "utf8"),
      context,
    );
  }
  return window.TrajectoryGeometryOptimizer as {
    refine(path: PathDoc, robot: BordeauxProject["robot"], perSegment: number, options?: { corridorM?: number; clearanceM?: number }): {
      status: string;
      path?: PathDoc;
      baselineTimeS?: number;
      candidateTimeS?: number;
      gainS?: number;
      corridorM?: number;
      clearanceM?: number;
      maxDeviationM?: number;
      minimumClearanceM?: number;
      reason?: string;
    };
  };
}

function rendererBoundaryInserter() {
  const window: Record<string, unknown> = {};
  vm.runInNewContext(
    fs.readFileSync(new URL("../public/renderer/assets/trajectory-optimizer.js", import.meta.url), "utf8"),
    { window, console, Math, Number, Set, Map, Infinity, isFinite, Error, Array, Object },
  );
  return (window.TrajectoryOptimizer as { insertBoundaries: (...args: unknown[]) => unknown }).insertBoundaries;
}

function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProject(seed: number): BordeauxProject {
  const random = randomGenerator(seed);
  const project = createDemoProject();
  const path = project.paths[0];
  const count = 2 + Math.floor(random() * 4);
  path.headingMode = random() < 0.5 ? "tangent" : "manual";
  path.driveBackward = random() < 0.15;
  path.waypoints = buildWaypoints(Array.from({ length: count }, (_unused, index) => {
    const x = 0.8 + index * (15 / Math.max(1, count - 1));
    const y = 0.5 + random() * 7;
    return {
      x,
      y,
      theta: -170 + random() * 340,
      thetaOn: true,
      segType: (["line", "arc", "bezier", "clothoid"] as const)[Math.floor(random() * 4)],
      nextC: { x: Math.min(17, x + 0.6 + random() * 1.8), y: 0.5 + random() * 7 },
      prevC: { x: Math.max(0, x - 0.6 - random() * 1.8), y: 0.5 + random() * 7 },
      stop: index > 0 && index < count - 1 && random() < 0.2,
    };
  }));
  if (seed % 3 === 0) {
    project.robot.driveModel = {
      motorId: "differential-test",
      motorFreeRpm: 5_000,
      motorMaxTorqueNm: 2.6,
      motorCount: 4,
      gearRatio: 6,
      wheelDiameterM: 0.1,
      massKg: 52,
      moiKgM2: 6,
      wheelbaseM: 0.6,
      trackwidthM: 0.8,
      wheelFrictionCoefficient: 1.1,
    };
  }
  const rangeKind = seed % 4;
  if (rangeKind !== 0) {
    const common = {
      f0: 0.2,
      f1: 0.8,
      maxVel: 0.8 + random() * 2,
      maxAccel: 0.5 + random() * 3,
      maxDecel: 0.5 + random() * 3,
      maxAngVel: 90 + random() * 270,
      maxAngAccel: 180 + random() * 540,
    };
    path.ranges = [rangeKind === 1
      ? { ...common, anchor: "param" }
      : rangeKind === 2
        ? { ...common, anchor: "dist", d0: 0.5, d1: 4 }
        : { ...common, anchor: "wp", w0: 0, t0: 0.35, w1: Math.max(0, count - 2), t1: 0.65 }];
  }
  return project;
}

describe("static renderer optimizer mirror", () => {
  it("preflights exact boundaries against the renderer sample ceiling", () => {
    const points = {
      length: 250_000,
      249_999: { s: 1 },
      some: () => false,
    };

    expect(() => rendererBoundaryInserter()(
      {},
      points,
      [],
      [],
      [],
      [{ start: 0.25, end: 0.25 }],
    )).toThrow("Optimization boundaries require more than 250000 trajectory samples");
  });

  it("matches shared status, geometry, timing, and velocity over seeded paths", () => {
    const renderer = rendererMath();
    for (let seed = 1; seed <= 64; seed += 1) {
      const project = randomProject(seed);
      const path = project.paths[0];
      const preview = renderer.derivePath(path, project.robot, 56, "optimizedTrajectory");
      const shared = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot, samplesPerSegment: 56 });
      expect(preview.optimization?.status, `status for seed ${seed}`).toBe(shared.optimization?.status);
      expect(preview.optimization?.plannerUsed, `planner for seed ${seed}`).toBe(shared.optimization?.plannerUsed);
      if (["invalid-input", "infeasible"].includes(shared.optimization?.status || "")) {
        expect(preview.optimization?.constraintViolations, `rejected violations for seed ${seed}`).toBe(0);
        continue;
      }
      expect(preview.optimization?.refinementPasses, `refinement for seed ${seed}`).toBe(shared.optimization?.refinementPasses);
      expect(preview.optimization?.constraintViolations, `violations for seed ${seed}`).toBe(shared.optimization?.constraintViolations);
      if (shared.optimization?.fallback) {
        expect(preview.optimization?.activeConstraints, `fallback active constraints for seed ${seed}`).toEqual(
          expect.arrayContaining(shared.optimization.activeConstraints || []),
        );
      } else {
        expect(preview.optimization?.activeConstraints, `active constraints for seed ${seed}`).toEqual(shared.optimization?.activeConstraints);
      }
      if (["optimal", "feasible"].includes(shared.optimization?.status || "")) {
        expect(preview.optimization?.validatedPoints, `validated points for seed ${seed}`).toBe(shared.optimization?.validatedPoints);
        expect(preview.optimization?.validatedPoints, `dense validation for seed ${seed}`).toBeGreaterThan(preview.sample.pts.length * 2);
      }
      expect(preview.optimization?.solveTimeMs, `solve time for seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(preview.sample.pts, `sample count for seed ${seed}`).toHaveLength(shared.samples.length);
      expect(preview.prof.totalTime, `time for seed ${seed}`).toBeCloseTo(shared.totalTimeS, 3);
      expect(preview.optimization?.totalTimeS, `diagnostic time for seed ${seed}`).toBe(preview.prof.totalTime);
      expect(preview.optimization?.maxVelocityMps, `diagnostic velocity for seed ${seed}`).toBe(preview.metrics.v.reduce((max, value) => Math.max(max, value), 0));
      preview.sample.pts.forEach((point, index) => {
        expect(point.x, `x ${seed}:${index}`).toBeCloseTo(shared.samples[index].x, 3);
        expect(point.y, `y ${seed}:${index}`).toBeCloseTo(shared.samples[index].y, 3);
        expect(preview.metrics.v[index], `velocity ${seed}:${index}`).toBeCloseTo(shared.samples[index].velocityMps, 3);
        const renderedHeading = preview.metrics.head[index] + (preview.rev ? Math.PI : 0);
        expect(Math.atan2(Math.sin(renderedHeading - shared.samples[index].headingRad), Math.cos(renderedHeading - shared.samples[index].headingRad)), `heading ${seed}:${index}`).toBeCloseTo(0, 3);
      });
    }
  }, 15_000);

  it("matches translation-priority and stationary-action total timing", () => {
    const renderer = rendererMath();
    const translationProject = createDemoProject();
    const translationPath = translationProject.paths[0];
    translationPath.headingMode = "manual";
    translationPath.constraints.maxAngVel = 60;
    translationPath.constraints.maxAngAccel = 120;
    translationPath.constraints.maxAngDecel = 120;
    translationPath.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 8, y: 2, theta: 180, thetaOn: true },
    ]);
    translationPath.ranges = [{
      anchor: "param", f0: 0.05, f1: 0.95,
      maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 60, maxAngAccel: 120,
      rotationPriority: "translation",
    }];
    const translationPreview = renderer.derivePath(translationPath, translationProject.robot, 56, "optimizedTrajectory");
    const translationShared = getPlanner("optimizedTrajectory").generate({ path: translationPath, robot: translationProject.robot, samplesPerSegment: 56 });
    expect(translationPreview.optimization?.status).toBe("optimal");
    expect(translationPreview.prof.totalTime).toBeCloseTo(translationShared.totalTimeS, 4);

    const stationaryProject = createDemoProject();
    const stationaryPath = stationaryProject.paths[0];
    stationaryPath.headingMode = "tangent";
    stationaryPath.waypoints = buildWaypoints([
      { x: 2, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 4, y: 2, theta: 90, thetaOn: true, stop: true, wait: 0.12, segType: "line", segmentHeadingMode: "manual", turnInPlace: { headingDeg: 90 } },
      { x: 6, y: 2, theta: 90, thetaOn: true },
    ]);
    stationaryPath.ranges = [{
      anchor: "param", f0: 0, f1: 1,
      maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 360, maxAngAccel: 720,
      rotationPriority: "translation",
    }];
    const stationaryPreview = renderer.derivePath(stationaryPath, stationaryProject.robot, 56, "optimizedTrajectory");
    const stationaryShared = getPlanner("optimizedTrajectory").generate({ path: stationaryPath, robot: stationaryProject.robot, samplesPerSegment: 56 });
    expect(stationaryPreview.optimization?.status).toBe("optimal");
    expect(stationaryPreview.optimization?.activeConstraints).toEqual(stationaryShared.optimization?.activeConstraints);
    expect(stationaryPreview.prof.totalTime).toBeCloseTo(stationaryShared.totalTimeS, 1);
  });

  it("recognizes translation-priority heading-transition windows", () => {
    const renderer = rendererMath();
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.constraints.maxAngVel = 60;
    path.constraints.maxAngAccel = 120;
    path.constraints.maxAngDecel = 120;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      {
        x: 4, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "manual",
        headingTransition: { placement: "after", rotationPriority: "translation", distanceM: 1.5 },
      },
      { x: 8, y: 2, theta: 180, thetaOn: true },
    ]);

    const preview = renderer.derivePath(path, project.robot, 56, "optimizedTrajectory");
    const shared = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot, samplesPerSegment: 56 });

    expect(preview.optimization?.translationPriorityStart).toBeTypeOf("number");
    expect(preview.optimization?.status).toBe(shared.optimization?.status);
    expect(preview.optimization?.activeConstraints).toEqual(shared.optimization?.activeConstraints);
    expect(preview.prof.totalTime).toBeCloseTo(shared.totalTimeS, 4);
    preview.metrics.v.forEach((velocity, index) => {
      expect(velocity, `velocity ${index}`).toBeCloseTo(shared.samples[index].velocityMps, 3);
    });
  });

  it("matches active swerve-module attribution while rotating", () => {
    const renderer = rendererMath();
    const project = createDemoProject();
    project.robot.driveModel = {
      motorId: "differential-test",
      motorFreeRpm: 5_000,
      motorMaxTorqueNm: 2.6,
      motorCount: 4,
      gearRatio: 6,
      wheelDiameterM: 0.1,
      massKg: 52,
      moiKgM2: 6,
      wheelbaseM: 0.6,
      trackwidthM: 0.8,
      wheelFrictionCoefficient: 1.1,
    };
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints = {
      ...path.constraints,
      maxVel: 5,
      maxAccel: 10,
      maxDecel: 10,
      maxAngVel: 2_000,
      maxAngAccel: 4_000,
    };
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, theta: 0, thetaOn: true },
      { x: 6, y: 1, theta: 180, thetaOn: true },
    ]);

    const preview = renderer.derivePath(path, project.robot, 56, "optimizedTrajectory");
    const shared = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot, samplesPerSegment: 56 });

    expect(preview.optimization?.activeConstraints).toEqual(shared.optimization?.activeConstraints);
    expect(preview.optimization?.activeConstraints).toEqual(expect.arrayContaining([
      expect.stringContaining("swerve-"),
    ]));
  });

  it("matches a physical tank trajectory", () => {
    const renderer = rendererMath();
    const project = createDemoProject();
    project.robot.drive = "tank";
    project.robot.driveModel = {
      motorId: "differential-test",
      motorFreeRpm: 5_000,
      motorMaxTorqueNm: 2.6,
      motorCount: 4,
      gearRatio: 6,
      wheelDiameterM: 0.1,
      massKg: 52,
      moiKgM2: 6,
      wheelbaseM: 0.6,
      trackwidthM: 0.8,
      wheelFrictionCoefficient: 1.1,
    };
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, nextC: { x: 3, y: 1 }, segType: "bezier" },
      { x: 5, y: 4, prevC: { x: 3, y: 4 }, nextC: { x: 7, y: 4 }, segType: "bezier", stop: true },
      { x: 9, y: 2, prevC: { x: 7, y: 2 } },
    ]);

    const preview = renderer.derivePath(path, project.robot, 56, "optimizedTrajectory");
    const shared = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot, samplesPerSegment: 56 });

    expect(preview.optimization?.status).toBe(shared.optimization?.status);
    expect(preview.optimization?.activeConstraints).toEqual(shared.optimization?.activeConstraints);
    expect(preview.prof.totalTime).toBeCloseTo(shared.totalTimeS, 3);
    expect(preview.metrics.v).toHaveLength(shared.samples.length);
    preview.metrics.v.forEach((velocity, index) => {
      expect(velocity, `tank velocity ${index}`).toBeCloseTo(shared.samples[index].velocityMps, 3);
    });
  });

  it("matches a curved look-at path with a translation-priority tangent transition", () => {
    const renderer = rendererMath();
    const project = createDemoProject();
    project.robot = { drive: "swerve", w: 0.84, l: 0.84, maxSpeed: 5 };
    const path = project.paths[0];
    path.headingMode = "targets";
    path.constraints = {
      ...path.constraints,
      maxVel: 4.2,
      maxAccel: 6.5,
      maxDecel: 6.5,
      maxAngVel: 540,
      maxAngAccel: 720,
      maxAngDecel: 720,
    };
    path.waypoints = buildWaypoints([
      {
        x: 3.581065084352355, y: 5.339468715198096,
        prevC: { x: 2.989372773457702, y: 5.853818993926654 },
        nextC: { x: 2.5998220188110155, y: 6.197864180826471 },
        segmentHeadingMode: "lookAt", segmentLookAt: { x: 5.216716597159319, y: 3.993602884972327 },
      },
      {
        x: 3.9615519819029283, y: 7.436356983423748,
        prevC: { x: 3.071616099599939, y: 7.459918521625691 },
        nextC: { x: 5.548085121345798, y: 7.394352652643313 },
        segmentHeadingMode: "tangent",
        headingTransition: { placement: "after", rotationPriority: "translation", distanceM: 0.75 },
      },
      {
        x: 8.481210467617753, y: 5.520387163792521,
        prevC: { x: 8.472842864488978, y: 7.683499888343893 },
        nextC: { x: 8.48381450722119, y: 4.847215753205544 },
        segmentHeadingMode: "tangent",
      },
      {
        x: 7.923694504516405, y: 2.6969745555902405,
        prevC: { x: 6.162558609790157, y: 5.365733079420055 },
      },
    ]);

    const preview = renderer.derivePath(path, project.robot, 56, "optimizedTrajectory");
    const shared = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot, samplesPerSegment: 56 });

    expect(preview.optimization).toMatchObject({ status: "optimal", plannerUsed: "optimizedTrajectory", constraintViolations: 0 });
    expect(shared.optimization).toMatchObject({ status: "optimal", plannerUsed: "optimizedTrajectory", constraintViolations: 0 });
    expect(preview.prof.totalTime).toBeCloseTo(shared.totalTimeS, 4);
  });
});

describe("optimized preview worker controller", () => {
  it("terminates superseded work and ignores stale generations", () => {
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage?: (event: { data: unknown }) => void;
      onerror?: (event: { message?: string }) => void;
      terminated = false;
      posted?: Record<string, unknown>;
      constructor(_url: string) { workers.push(this); }
      postMessage(value: Record<string, unknown>) { this.posted = value; }
      terminate() { this.terminated = true; }
    }
    const window = { Worker: FakeWorker } as unknown as Record<string, unknown>;
    vm.runInNewContext(
      fs.readFileSync(new URL("../public/renderer/assets/optimized-preview.js", import.meta.url), "utf8"),
      { window, Error },
    );
    const Controller = window.OptimizedPreviewController as new () => {
      request(payload: object, result: (value: unknown) => void, error: (value: Error) => void): number;
    };
    const controller = new Controller();
    const results: unknown[] = [];
    const errors: Error[] = [];
    const firstGeneration = controller.request({ path: "first" }, (value) => results.push(value), (error) => errors.push(error));
    const secondGeneration = controller.request({ path: "second" }, (value) => results.push(value), (error) => errors.push(error));

    expect(workers[0].terminated).toBe(true);
    workers[0].onmessage?.({ data: { generation: firstGeneration, ok: true, value: "stale" } });
    workers[1].onmessage?.({ data: { generation: secondGeneration, ok: true, value: "current" } });
    expect(results).toEqual(["current"]);
    expect(errors).toEqual([]);
    expect(workers[1].terminated).toBe(true);
  });
});

describe("explicit geometry refinement", () => {
  it("returns a faster preview while preserving authored intent and handle directions", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 6, y: 1, nextC: { x: 6.5, y: 5 }, segType: "bezier" },
      { x: 8.5, y: 6, prevC: { x: 6.8, y: 5 }, nextC: { x: 10.2, y: 7 }, segType: "bezier", stop: true },
      { x: 11.5, y: 1, prevC: { x: 11, y: 5 } },
    ]);
    path.markers = [{ id: "score", f: 0.7, name: "Score" }];
    path.ranges = [{ anchor: "param", f0: 0.3, f1: 0.6, maxVel: 3, maxAccel: 4, maxDecel: 4, maxAngVel: 360, maxAngAccel: 720 }];
    const result = rendererGeometryOptimizer().refine(path, project.robot, 56, { corridorM: 0.15 });

    expect(result.status).toBe("candidate");
    expect(result.gainS).toBeGreaterThanOrEqual(Math.max(0.02, result.baselineTimeS! * 0.005));
    expect(result.candidateTimeS).toBeLessThan(result.baselineTimeS!);
    expect(result.corridorM).toBe(0.15);
    expect(result.clearanceM).toBe(0);
    expect(result.maxDeviationM).toBeLessThanOrEqual(0.150001);
    expect(result.minimumClearanceM).toBeGreaterThanOrEqual(-1e-6);
    expect(result.path?.markers).toEqual(path.markers);
    expect(result.path?.ranges).toEqual(path.ranges);
    result.path?.waypoints.forEach((waypoint, index) => {
      const authored = path.waypoints[index];
      expect({ ...waypoint, prevC: undefined, nextC: undefined }).toEqual({ ...authored, prevC: undefined, nextC: undefined });
      for (const key of ["prevC", "nextC"] as const) {
        const before = authored[key];
        const after = waypoint[key];
        if (!before || !after) continue;
        const first = { x: before.x - authored.x, y: before.y - authored.y };
        const second = { x: after.x - waypoint.x, y: after.y - waypoint.y };
        expect(first.x * second.y - first.y * second.x).toBeCloseTo(0, 8);
        expect(first.x * second.x + first.y * second.y).toBeGreaterThan(0);
      }
    });

    const repeated = rendererGeometryOptimizer().refine(result.path!, project.robot, 56, { corridorM: 0.15 });
    expect(repeated.status).toBe("unchanged");
    expect(repeated.path).toBeUndefined();
    expect(result.path?.geometryRefinement?.anchor).toHaveLength(path.waypoints.length);
    expect(result.path?.geometryRefinement?.applied).toHaveLength(path.waypoints.length);
  }, 12_000);

  it("matches shared robot-footprint clearance for field obstacles and path keep-outs", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([{ x: 6, y: 1 }, { x: 8.5, y: 2 }, { x: 11, y: 1 }]);
    path.keepOuts = [{ id: "keepout_test", name: "Partner lane", min: { x: 8, y: 2.6 }, max: { x: 9, y: 3.2 } }];
    const shared = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot, samplesPerSegment: 56 });
    const window: Record<string, any> = {};
    vm.runInNewContext(
      fs.readFileSync(new URL("../public/renderer/assets/trajectory-clearance.js", import.meta.url), "utf8"),
      { window, Math, Number, Infinity, Array, Object },
    );
    const renderer = window.TrajectoryClearance.clearanceReport(path, project.robot, {
      sample: { pts: shared.samples.map((sample) => ({ x: sample.x, y: sample.y })) },
      metrics: { head: shared.samples.map((sample) => sample.headingRad) },
    });
    const canonical = minimumPathClearance(project, shared.samples, path.keepOuts);

    expect(renderer.minimum).toBeCloseTo(canonical, 3);
  });

  it("never accepts a faster candidate whose footprint enters a keep-out region", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 6, y: 1, nextC: { x: 6.5, y: 5 }, segType: "bezier" },
      { x: 8.5, y: 6, prevC: { x: 6.8, y: 5 }, nextC: { x: 10.2, y: 7 }, segType: "bezier", stop: true },
      { x: 11.5, y: 1, prevC: { x: 11, y: 5 } },
    ]);
    path.keepOuts = [{ id: "keepout_curve", name: "No shortcut", min: { x: 7.6, y: 2.5 }, max: { x: 9.4, y: 4.5 } }];
    const result = rendererGeometryOptimizer().refine(path, project.robot, 56, { corridorM: 0.15, clearanceM: 0.05 });

    if (result.status === "candidate") expect(result.minimumClearanceM).toBeGreaterThanOrEqual(-1e-6);
    else expect(result).toMatchObject({ status: "unchanged", path: undefined });
  });

  it("enforces the requested footprint clearance instead of weakening it to the baseline", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([{ x: 6, y: 1 }, { x: 8.5, y: 2 }, { x: 11, y: 1 }]);

    const result = rendererGeometryOptimizer().refine(path, project.robot, 56, { corridorM: 0.15, clearanceM: 0.4 });

    if (result.status === "candidate") expect(result.minimumClearanceM).toBeGreaterThanOrEqual(0.4 - 1e-6);
    else expect(result.status).toBe("unchanged");
  });

  it("rejects TRENCH candidates when the configured robot is too tall", () => {
    const project = createDemoProject();
    project.robot.heightM = 1;
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 14.2, y: 0.6, nextC: { x: 13.5, y: 0.6 }, segType: "bezier" },
      { x: 12, y: 0.6, prevC: { x: 12.7, y: 0.6 }, nextC: { x: 11.3, y: 0.6 }, segType: "bezier" },
      { x: 9.8, y: 0.6, prevC: { x: 10.5, y: 0.6 } },
    ]);

    expect(rendererGeometryOptimizer().refine(path, project.robot, 56, { corridorM: 0.15, clearanceM: 0 })).toMatchObject({
      status: "unchanged",
      reason: expect.stringContaining("too tall"),
    });
  });

  it("requires a configured robot height before refining a TRENCH-crossing path", () => {
    const project = createDemoProject();
    project.robot.heightM = undefined;
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 14.2, y: 0.6, nextC: { x: 13.5, y: 0.6 }, segType: "bezier" },
      { x: 12, y: 0.6, prevC: { x: 12.7, y: 0.6 }, nextC: { x: 11.3, y: 0.6 }, segType: "bezier" },
      { x: 9.8, y: 0.6, prevC: { x: 10.5, y: 0.6 } },
    ]);

    const result = rendererGeometryOptimizer().refine(path, project.robot, 56, { corridorM: 0.15, clearanceM: 0 });

    expect(result).toMatchObject({
      status: "unchanged",
      reason: expect.stringContaining("height is required"),
    });
    expect(result.path).toBeUndefined();
  });

  it("accepts a known-safe robot height for TRENCH refinement", () => {
    const project = createDemoProject();
    project.robot.heightM = 0.5;
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 14.2, y: 0.6, nextC: { x: 13.5, y: 0.6 }, segType: "bezier" },
      { x: 12, y: 0.6, prevC: { x: 12.7, y: 0.6 }, nextC: { x: 11.3, y: 0.6 }, segType: "bezier" },
      { x: 9.8, y: 0.6, prevC: { x: 10.5, y: 0.6 } },
    ]);

    const result = rendererGeometryOptimizer().refine(path, project.robot, 56, { corridorM: 0.15, clearanceM: 0 });

    expect(result.reason || "").not.toContain("height");
  });

  it("allows geometry refinement without robot height away from TRENCH crossings", () => {
    const project = createDemoProject();
    project.robot.heightM = undefined;
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 6, y: 1, nextC: { x: 6.5, y: 5 }, segType: "bezier" },
      { x: 8.5, y: 6, prevC: { x: 6.8, y: 5 }, nextC: { x: 10.2, y: 7 }, segType: "bezier", stop: true },
      { x: 11.5, y: 1, prevC: { x: 11, y: 5 } },
    ]);

    expect(rendererGeometryOptimizer().refine(path, project.robot, 56, { corridorM: 0.15 }).status).toBe("candidate");
  });

  it("keeps the authored baseline when segment geometry is unsupported", () => {
    const project = createDemoProject();
    project.paths[0].waypoints[0].segType = "clothoid";

    const result = rendererGeometryOptimizer().refine(project.paths[0], project.robot, 56);

    expect(result).toMatchObject({ status: "unchanged", reason: expect.stringContaining("all-Bezier") });
    expect(result.path).toBeUndefined();
  });

  it("refuses to refine a path with blocking path-check errors", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.waypoints = buildWaypoints([
      {
        x: 1, y: 2, segType: "bezier", nextC: { x: 3, y: 2 },
        segmentHeadingMode: "lookAt", segmentLookAt: { x: 4, y: 2 },
      },
      { x: 7, y: 2, prevC: { x: 5, y: 2 } },
    ]);

    const result = rendererGeometryOptimizer().refine(path, project.robot, 56);

    expect(result).toMatchObject({ status: "unchanged", reason: expect.stringContaining("no path-check errors") });
    expect(result.path).toBeUndefined();
  });

  it("preflights geometry search size before evaluating candidates", () => {
    const project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints(Array.from({ length: 42 }, (_unused, index) => ({
      x: 1 + index * 0.2,
      y: 2,
      segType: "bezier" as const,
    })));

    const result = rendererGeometryOptimizer().refine(project.paths[0], project.robot, 56);

    expect(result).toMatchObject({ status: "unchanged", reason: expect.stringContaining("at most 40 segments") });
  });
});
