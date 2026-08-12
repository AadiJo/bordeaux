import { describe, expect, it } from "vitest";
import { buildBdxExport } from "../src/shared/export/bdx";
import { buildJavaTrajectory } from "../src/shared/export/javaTrajectory";
import { getPlanner } from "../src/shared/planners";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import type { JavaCommandCatalog, TrajectoryPlannerId, TrajectorySample } from "../src/shared/types";

const PLANNERS: TrajectoryPlannerId[] = ["profiledSpline", "optimizedTrajectory"];
const DEGREES = 180 / Math.PI;

function measuredJerk(samples: readonly TrajectorySample[]): { linear: number; angularDeg: number } {
  let linear = 0;
  let angular = 0;
  let previousAngularAcceleration: number | undefined;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    const previous = samples[index - 1];
    const dt = sample.t - previous.t;
    if (dt <= 1e-9) {
      previousAngularAcceleration = undefined;
      continue;
    }
    linear = Math.max(linear, Math.abs(sample.accelerationMps2 - previous.accelerationMps2) / dt);
    const angularAcceleration = (sample.angularVelocityRadps - previous.angularVelocityRadps) / dt;
    if (previousAngularAcceleration !== undefined) {
      angular = Math.max(angular, Math.abs(angularAcceleration - previousAngularAcceleration) / dt);
    }
    previousAngularAcceleration = angularAcceleration;
  }
  return { linear, angularDeg: angular * DEGREES };
}

function movingProject() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.constraints = {
    ...path.constraints,
    maxVel: 4,
    maxAccel: 10,
    maxDecel: 10,
    maxAngVel: 360,
    maxAngAccel: 720,
  };
  path.waypoints = buildWaypoints([
    { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
    { x: 8, y: 2, theta: 180, thetaOn: true },
  ]);
  return project;
}

function generatedCatalog(): JavaCommandCatalog {
  return {
    projectName: "CompetitionRobot",
    sourceFileCount: 1,
    scannedAt: "2026-08-12T00:00:00.000Z",
    source: "generated",
    runtimeCommandCount: 0,
    generatedSchemaVersion: "1.0",
    catalogId: "competition-robot",
    supportVersion: "0.2.0-beta.3",
    catalogHash: `sha256:${"a".repeat(64)}`,
    authoritative: true,
    warnings: [],
    commands: [],
  };
}

describe("final trajectory jerk diagnostics", () => {
  it.each(PLANNERS)("reports moving linear jerk violations in %s", (plannerId) => {
    const project = movingProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.constraints.maxJerk = 0.1;

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const measured = measuredJerk(result.samples);

    expect(measured.linear).toBeGreaterThan(path.constraints.maxJerk);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error",
      path: `paths.${path.name}.constraints.maxJerk`,
      message: expect.stringContaining("Linear jerk"),
    }));
    if (result.optimization) expect(result.optimization.constraintViolations).toBeGreaterThan(0);
  });

  it.each(PLANNERS)("reports moving angular jerk violations in %s", (plannerId) => {
    const project = movingProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxAngJerk = 1;

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const measured = measuredJerk(result.samples);

    expect(measured.angularDeg).toBeGreaterThan(path.constraints.maxAngJerk);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error",
      path: `paths.${path.name}.constraints.maxAngJerk`,
      message: expect.stringContaining("Angular jerk"),
    }));
    if (result.optimization) expect(result.optimization.constraintViolations).toBeGreaterThan(0);
  });

  it.each(PLANNERS)("preserves jerk-constrained stationary turns in %s", (plannerId) => {
    const project = movingProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.waypoints[1].theta = 0;
    path.waypoints[1].stop = true;
    path.waypoints[1].turnInPlace = { headingDeg: 90, direction: "counterclockwise" };
    path.constraints.maxAngJerk = 120;

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const measured = measuredJerk(result.samples);

    expect(measured.angularDeg).toBeLessThanOrEqual(path.constraints.maxAngJerk + 1e-6);
    expect(result.diagnostics.some((issue) => issue.message.includes("Angular jerk"))).toBe(false);
    expect(result.samples.at(-1)!.headingRad).toBeCloseTo(Math.PI / 2, 6);
  });

  it.each(PLANNERS)("blocks native and Java export when %s violates maxJerk", (plannerId) => {
    const project = movingProject();
    project.plannerId = plannerId;
    project.paths[0].headingMode = "tangent";
    project.paths[0].constraints.maxJerk = 0.1;

    expect(() => buildBdxExport(project)).toThrow(/Linear jerk/);
    expect(() => buildJavaTrajectory(project, generatedCatalog())).toThrow(/Linear jerk/);
  });

  it.each(PLANNERS)("blocks native and Java export when %s violates maxAngJerk", (plannerId) => {
    const project = movingProject();
    project.plannerId = plannerId;
    project.paths[0].headingMode = "manual";
    project.paths[0].constraints.maxAngJerk = 1;

    expect(() => buildBdxExport(project)).toThrow(/Angular jerk/);
    expect(() => buildJavaTrajectory(project, generatedCatalog())).toThrow(/Angular jerk/);
  });
});
