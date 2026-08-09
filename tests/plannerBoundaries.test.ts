import { describe, expect, it } from "vitest";
import { optimizedTrajectoryPlanner } from "../src/shared/planners/optimizedTrajectory";
import { profiledSplinePlanner } from "../src/shared/planners/profiledSpline";
import { applyStationaryActions } from "../src/shared/planners/stationaryActions";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import type { ConstraintRange, RoutineNode } from "../src/shared/types";
import { validateProject } from "../src/shared/validation";
import { decodeProjectValue } from "../src/shared/project/fileFormat";

describe("planner correctness boundaries", () => {
  it("rejects oversized base geometry before path sampling", () => {
    const project = createDemoProject();
    const waypoint = project.paths[0].waypoints[0];
    project.paths[0].waypoints = Array.from({ length: 4_466 }, (_, index) => ({
      ...structuredClone(waypoint),
      x: 1 + index * 0.001,
    }));

    expect(() => profiledSplinePlanner.generate({ path: project.paths[0], robot: project.robot }))
      .toThrow("more than 250000 trajectory samples");
  });

  it("keeps an unevenly spaced stop at its authored waypoint and preserves linear limits", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.constraints = {
      ...path.constraints,
      maxVel: 4,
      maxAccel: 1,
      maxDecel: 1,
      maxAngVel: 360,
      maxAngAccel: 720,
    };
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, nextC: { x: 4 / 3, y: 1 } },
      { x: 2, y: 1, prevC: { x: 5 / 3, y: 1 }, nextC: { x: 14 / 3, y: 1 }, stop: true },
      { x: 10, y: 1, prevC: { x: 22 / 3, y: 1 } },
    ]);

    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot });
    const interiorStops = result.samples.filter((sample) => (
      sample.f > 1e-8 && sample.f < 1 - 1e-8 && Math.abs(sample.velocityMps) < 1e-8
    ));

    expect(interiorStops).toHaveLength(1);
    expect(interiorStops[0].x).toBeCloseTo(2, 4);
    for (let index = 1; index < result.samples.length; index += 1) {
      const previous = result.samples[index - 1];
      const sample = result.samples[index];
      const ds = sample.s - previous.s;
      if (ds <= 1e-9) continue;
      const acceleration = (sample.velocityMps ** 2 - previous.velocityMps ** 2) / (2 * ds);
      const accelerationLimit = path.constraints.maxAccel
        * Math.max(0, Math.min(1, 1 - previous.velocityMps / project.robot.maxSpeed));
      if (acceleration >= 0) expect(acceleration).toBeLessThanOrEqual(accelerationLimit + 0.002);
      else expect(-acceleration).toBeLessThanOrEqual(path.constraints.maxDecel + 0.002);
    }
    expect(result.optimization?.constraintViolations).toBe(0);
    expect(result.optimization?.status).toBe("feasible");
    expect(result.optimization?.iterations).toBe((result.samples.length - 1) * 2);
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
  });

  it("reports invalid boundary conditions without disguising them as a planner fallback", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.startVel = 2;
    path.goalVel = 0;
    path.constraints = {
      ...path.constraints,
      maxVel: 4,
      maxAccel: 1,
      maxDecel: 0.1,
      maxAngVel: 360,
      maxAngAccel: 720,
    };
    path.waypoints = buildWaypoints([
      { x: 1, y: 1 },
      { x: 1.1, y: 1, stop: true },
    ]);

    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot });

    expect(result.planner).toBe("optimizedTrajectory");
    expect(result.optimization).toMatchObject({
      status: "invalid-input",
      fallback: false,
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("Optimized trajectory is invalid-input"),
      }),
    ]));
  });

  it("produces deterministic samples without iterative smoothing passes", () => {
    const project = createDemoProject();
    const input = { path: project.paths[0], robot: project.robot };

    const first = optimizedTrajectoryPlanner.generate({ ...input, smoothingPasses: 0 });
    const second = optimizedTrajectoryPlanner.generate({ ...input, smoothingPasses: 8 });

    expect(first.optimization?.status).toBe("feasible");
    expect(second.optimization?.status).toBe("feasible");
    expect(second.samples).toEqual(first.samples);
    expect(second.markers).toEqual(first.markers);
  });

  it("rejects an under-resolved moving path instead of returning an enormous duration", () => {
    const project = createDemoProject();
    const result = optimizedTrajectoryPlanner.generate({
      path: project.paths[0],
      robot: project.robot,
      samplesPerSegment: 1,
    });

    expect(result.optimization?.status).toBe("invalid-input");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("moving sample between stopped boundaries") }),
    ]));
    expect(result.totalTimeS).toBeLessThan(1);
  });

  it.each([
    ["param", { anchor: "param", f0: 0, f1: 1 }],
    ["distance", { anchor: "dist", f0: 0.4, f1: 0.6, d0: 0, d1: 9 }],
    ["waypoint-local", { anchor: "wp", f0: 0.4, f1: 0.6, w0: 0, t0: 0, w1: 1, t1: 1 }],
  ] as const)("enforces %s velocity, acceleration, and deceleration ranges after optimization", (_name, anchor) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.startVel = 2;
    path.goalVel = 2;
    path.constraints = {
      ...path.constraints,
      maxVel: 4,
      maxAccel: 5,
      maxDecel: 5,
      maxAngVel: 360,
      maxAngAccel: 720,
    };
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, nextC: { x: 2, y: 1 } },
      { x: 4, y: 1, prevC: { x: 3, y: 1 }, nextC: { x: 6, y: 1 } },
      { x: 10, y: 1, prevC: { x: 8, y: 1 } },
    ]);
    path.ranges = [{
      ...anchor,
      maxVel: 0.8,
      maxAccel: 0.1,
      maxDecel: 0.1,
      maxAngVel: 360,
      maxAngAccel: 720,
    } as ConstraintRange];

    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot });
    expect(Math.max(...result.samples.map((sample) => sample.velocityMps))).toBeLessThanOrEqual(0.8001);
    for (let index = 1; index < result.samples.length; index += 1) {
      const previous = result.samples[index - 1];
      const sample = result.samples[index];
      const ds = sample.s - previous.s;
      if (ds <= 1e-9) continue;
      const acceleration = (sample.velocityMps ** 2 - previous.velocityMps ** 2) / (2 * ds);
      const accelerationLimit = 0.1
        * Math.max(0, Math.min(1, 1 - previous.velocityMps / project.robot.maxSpeed));
      if (acceleration >= 0) expect(acceleration).toBeLessThanOrEqual(accelerationLimit + 0.002);
      else expect(-acceleration).toBeLessThanOrEqual(0.102);
    }
    expect(result.optimization?.constraintViolations).toBe(0);
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
  });

  it("enforces partial constraint ranges on both endpoints of overlapping intervals", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, nextC: { x: 2, y: 1 } },
      { x: 5, y: 1, prevC: { x: 4, y: 1 }, nextC: { x: 7, y: 1 }, stop: true },
      { x: 11, y: 1, prevC: { x: 9, y: 1 } },
    ]);
    path.ranges = [{
      anchor: "param",
      f0: 0.2,
      f1: 0.8,
      maxVel: 1.5,
      maxAccel: 1,
      maxDecel: 1,
      maxAngVel: 360,
      maxAngAccel: 720,
    }];

    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot });

    expect(result.optimization).toMatchObject({ status: "feasible", constraintViolations: 0 });
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
  });

  it("rejects oversized stationary timelines before allocating their samples", () => {
    const project = createDemoProject();
    project.paths[0].waypoints.at(-1)!.wait = 20_000;

    const base = profiledSplinePlanner.generate({ path: project.paths[0], robot: project.robot });
    expect(() => applyStationaryActions(project.paths[0], base, project.robot))
      .toThrow(/Stationary actions require .*exceeding the trajectory limit of 250000/);
  });
});

describe("project validation boundaries", () => {
  it("rejects deeply nested routines without overflowing during migration", () => {
    const project = createDemoProject() as unknown as Record<string, any>;
    let nodes: unknown[] = [];
    for (let depth = 0; depth < 2_000; depth += 1) {
      nodes = [{ id: `decision_${depth}`, type: "decision", cond: "ready", thenLabel: "yes", elseLabel: "no", then: nodes, else: [] }];
    }
    project.routine.nodes = nodes;
    project.routines = [{ id: "routine_deep", name: "Deep", nodes }];
    project.activeRoutineId = "routine_deep";

    expect(() => decodeProjectValue(project)).toThrow("Routine nesting cannot exceed 64 levels");
  });

  it("rejects non-boolean persisted path and waypoint flags", () => {
    const project = createDemoProject() as unknown as Record<string, any>;
    project.paths[0].driveBackward = "false";
    project.paths[0].exportable = "false";
    project.paths[0].waypoints[0].thetaOn = "false";
    project.paths[0].waypoints[0].linked = 1;
    project.paths[0].waypoints[0].stop = null;
    project.paths[0].waypoints[0].corner = "false";

    expect(validateProject(project).issues.map((item) => item.path)).toEqual(expect.arrayContaining([
      "$.paths[0].driveBackward",
      "$.paths[0].exportable",
      "$.paths[0].waypoints[0].thetaOn",
      "$.paths[0].waypoints[0].linked",
      "$.paths[0].waypoints[0].stop",
      "$.paths[0].waypoints[0].corner",
    ]));
  });

  it("bounds project path collections and routine nesting", () => {
    const oversized = createDemoProject();
    oversized.paths = Array.from({ length: 1_025 }, () => oversized.paths[0]);
    expect(validateProject(oversized).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.paths", message: expect.stringContaining("1024") }),
    ]));

    const nested = createDemoProject();
    let nodes: RoutineNode[] = [];
    for (let depth = 0; depth < 66; depth += 1) {
      nodes = [{
        id: `decision_${depth}`,
        type: "decision",
        cond: "condition",
        thenLabel: "Then",
        elseLabel: "Else",
        then: nodes,
        else: [],
      }];
    }
    nested.routines![0].nodes = nodes;
    expect(validateProject(nested).issues.some((issue) => (
      issue.path.includes(".then") && issue.message.includes("64 levels")
    ))).toBe(true);
  });
});
