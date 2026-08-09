import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { getPlanner } from "../src/shared/planners";
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
      gearRatio: 6,
      wheelDiameterM: 0.1,
      wheelbaseM: 0.6,
      trackwidthM: 0.8,
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
  it("matches shared status, geometry, timing, and velocity over seeded paths", () => {
    const renderer = rendererMath();
    for (let seed = 1; seed <= 64; seed += 1) {
      const project = randomProject(seed);
      const path = project.paths[0];
      const preview = renderer.derivePath(path, project.robot, 56, "optimizedTrajectory");
      const shared = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot, samplesPerSegment: 56 });

      expect(preview.optimization?.status, `status for seed ${seed}`).toBe(shared.optimization?.status);
      expect(preview.optimization?.plannerUsed, `planner for seed ${seed}`).toBe(shared.optimization?.plannerUsed);
      expect(preview.optimization?.refinementPasses, `refinement for seed ${seed}`).toBe(shared.optimization?.refinementPasses);
      expect(preview.optimization?.constraintViolations, `violations for seed ${seed}`).toBe(shared.optimization?.constraintViolations);
      expect(preview.optimization?.activeConstraints, `active constraints for seed ${seed}`).toEqual(shared.optimization?.activeConstraints);
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
  });

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
    const stationaryPreview = renderer.derivePath(stationaryPath, stationaryProject.robot, 56, "optimizedTrajectory");
    const stationaryShared = getPlanner("optimizedTrajectory").generate({ path: stationaryPath, robot: stationaryProject.robot, samplesPerSegment: 56 });
    expect(stationaryPreview.optimization?.status).toBe("optimal");
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
      gearRatio: 6,
      wheelDiameterM: 0.1,
      wheelbaseM: 0.6,
      trackwidthM: 0.8,
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
      gearRatio: 6,
      wheelDiameterM: 0.1,
      wheelbaseM: 0.6,
      trackwidthM: 0.8,
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
