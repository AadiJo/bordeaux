import { describe, expect, it } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { projectDrivetrainAtPoint } from "../src/shared/planners/drivetrainProjection";
import { getPlanner } from "../src/shared/planners";
import { optimizedTrajectoryPlanner } from "../src/shared/planners/optimizedTrajectory";
import { buildCanonicalPathState, type CanonicalPathPoint } from "../src/shared/planners/pathState";
import { accelerationBoundsForSpeedSquared, solveReachabilityProfile } from "../src/shared/planners/reachability";
import { validateOptimizedTrajectory } from "../src/shared/planners/trajectoryValidation";
import type { RobotConfig } from "../src/shared/types";

function point(overrides: Partial<CanonicalPathPoint> = {}): CanonicalPathPoint {
  return {
    sourceIndex: 0,
    s: 0,
    f: 0,
    x: 0,
    y: 0,
    tangentRad: 0,
    tangentX: 1,
    tangentY: 0,
    normalX: 0,
    normalY: 1,
    curvatureInvM: 0,
    headingRad: 0,
    headingDerivativeRadPerM: 0,
    headingSecondDerivativeRadPerM2: 0,
    segmentIndex: 0,
    segmentFraction: 0,
    stop: false,
    ...overrides,
  };
}

function robot(drive: RobotConfig["drive"]): RobotConfig {
  return {
    drive,
    w: 0.8,
    l: 0.6,
    maxSpeed: 5,
    driveModel: {
      motorId: "test",
      motorFreeRpm: 5_000,
      gearRatio: 6,
      wheelDiameterM: 0.1,
      wheelbaseM: 0.6,
      trackwidthM: 0.8,
    },
  };
}

describe("canonical optimizer path state", () => {
  it("unwraps heading and preserves ordered waypoint ownership", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 0, y: 0 },
      { x: 1, y: 0, stop: true },
      { x: 2, y: 0 },
    ]);
    const samples = [
      { i: 0, t: 0, s: 0, f: 0, x: 0, y: 0, headingRad: 3.1, velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 },
      { i: 1, t: 1, s: 1, f: 0.5, x: 1, y: 0, headingRad: -3.1, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 },
      { i: 2, t: 2, s: 2, f: 1, x: 2, y: 0, headingRad: -3, velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 },
    ];

    const state = buildCanonicalPathState(path, samples);

    expect(state.waypointSampleIndices).toEqual([0, 1, 2]);
    expect(state.points[1]).toMatchObject({ waypointIndex: 1, stop: true });
    expect(state.points[1].headingRad).toBeGreaterThan(state.points[0].headingRad);
    expect(state.points.every((sample) => sample.tangentX > 0.999)).toBe(true);
  });
});

describe("drivetrain projection", () => {
  it("caps tank wheel speed from signed curvature and trackwidth", () => {
    const projection = projectDrivetrainAtPoint(point({
      curvatureInvM: 1,
      headingDerivativeRadPerM: 1,
    }), robot("tank"), 1e9);

    expect(projection.velocityLimitMps).toBeCloseTo(5 / 1.4, 12);
  });

  it("caps the fastest rectangular swerve module during simultaneous translation and rotation", () => {
    const projection = projectDrivetrainAtPoint(point({
      headingDerivativeRadPerM: 1,
    }), robot("swerve"), 1e9);

    expect(projection.velocityLimitMps).toBeCloseTo(5 / Math.sqrt(2.05), 12);
    expect(projection.velocityConstraints).toHaveLength(4);
  });

  it("solves affine module acceleration bounds in squared-speed space", () => {
    const constraints = [{ uX: 1, uY: 0, xX: 0, xY: 1, limit: 2 }];

    expect(accelerationBoundsForSpeedSquared(constraints, 1)).toEqual({
      minimum: -Math.sqrt(3),
      maximum: Math.sqrt(3),
    });
  });

  it("uses affine acceleration limits in both reachability passes", () => {
    const result = solveReachabilityProfile({
      positions: [0, 1, 2],
      velocityLimits: [10, 10, 10],
      accelerationLimits: [2, 2],
      decelerationLimits: [2, 2],
      freeSpeeds: [1e9, 1e9],
      accelerationConstraints: [
        [{ uX: 1, uY: 0, xX: 0, xY: 0, limit: 0.5 }],
        [{ uX: 1, uY: 0, xX: 0, xY: 0, limit: 0.5 }],
      ],
      startVelocity: 0,
      goalVelocity: 0,
    });

    expect(result.status).toBe("optimal");
    expect(result.velocities[1]).toBeCloseTo(1, 8);
  });
});

describe("dense optimized trajectory validation", () => {
  it("checks angular limits for short ranges that only overlap an interval", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.startVel = 1;
    path.goalVel = 1;
    path.constraints.maxAngVel = 720;
    path.constraints.maxAngAccel = 1_000;
    path.waypoints = buildWaypoints([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    path.ranges = [{
      anchor: "param",
      f0: 0.4,
      f1: 0.6,
      maxVel: 4,
      maxAccel: 5,
      maxDecel: 5,
      maxAngVel: 60,
      maxAngAccel: 1_000,
    }];
    const samples = [
      { i: 0, t: 0, s: 0, f: 0, x: 0, y: 0, headingRad: 0, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 },
      { i: 1, t: 1, s: 1, f: 1, x: 1, y: 0, headingRad: 2, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 2, curvatureInvM: 0 },
    ];

    const validation = validateOptimizedTrajectory({ path, robot: project.robot }, samples);

    expect(validation.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "angular-velocity", sampleIndex: 1 }),
    ]));
  });

  it("refines an under-resolved path until dense validation passes", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.constraints = {
      ...path.constraints,
      maxVel: 5,
      maxAccel: 4,
      maxDecel: 4,
      maxCentripetalAccel: 1.9481691280379891,
    };
    path.waypoints = buildWaypoints([
      { x: 1, y: 1.9703536124434322, nextC: { x: 2.6698099905624986, y: 1.2057649325579405 } },
      { x: 5, y: 2.2883898813743144, prevC: { x: 3.3903216323815286, y: 0.3884025572333485 }, nextC: { x: 6.12796035874635, y: 0.4964096660260111 } },
      { x: 9, y: 0.6596848035696894, prevC: { x: 7.031999722588807, y: 2.8730427105911076 }, nextC: { x: 10.288325769361109, y: 0.383738569682464 } },
      { x: 13, y: 7.296420271042734, prevC: { x: 11.95249164197594, y: 6.25517353694886 } },
    ]);

    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot, samplesPerSegment: 4 });

    expect(result.optimization).toMatchObject({ status: "optimal", refinementPasses: 1, constraintViolations: 0 });
    expect(result.samples).toHaveLength(25);
  });

  it("keeps every swerve module inside free speed while rotating on a straight path", () => {
    const project = createDemoProject();
    project.robot.driveModel = robot("swerve").driveModel;
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

    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot });
    const validation = validateOptimizedTrajectory({ path, robot: project.robot }, result.samples);

    expect(result.optimization).toMatchObject({ status: "optimal", constraintViolations: 0 });
    expect(validation.violations).toEqual([]);
    expect(result.optimization?.activeConstraints).toEqual(expect.arrayContaining([
      expect.stringContaining("swerve-"),
    ]));
  });

  it("rejects translational jerk until the third-order solver phase exists", () => {
    const project = createDemoProject();
    project.paths[0].constraints.maxJerk = 4;

    const result = optimizedTrajectoryPlanner.generate({ path: project.paths[0], robot: project.robot });

    expect(result.optimization?.status).toBe("invalid-input");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("nonzero translational jerk") }),
    ]));
  });

  it("revalidates translation-priority heading following before stationary postprocessing", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxAngVel = 60;
    path.constraints.maxAngAccel = 120;
    path.constraints.maxAngDecel = 120;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 8, y: 2, theta: 180, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param",
      f0: 0.05,
      f1: 0.95,
      maxVel: 4,
      maxAccel: 5,
      maxDecel: 5,
      maxAngVel: 60,
      maxAngAccel: 120,
      rotationPriority: "translation",
    }];

    const result = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot });

    expect(result.planner).toBe("optimizedTrajectory");
    expect(result.optimization).toMatchObject({ status: "optimal", fallback: false, constraintViolations: 0 });
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
  });

  it("keeps stationary turn boundaries out of moving-path derivatives", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 2, y: 2, theta: 0, thetaOn: true, segType: "line" },
      {
        x: 4,
        y: 2,
        theta: 90,
        thetaOn: true,
        stop: true,
        segType: "line",
        segmentHeadingMode: "manual",
        turnInPlace: { headingDeg: 90 },
      },
      { x: 6, y: 2, theta: 90, thetaOn: true },
    ]);

    const result = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot });

    expect(result.planner).toBe("optimizedTrajectory");
    expect(result.optimization).toMatchObject({ status: "optimal", fallback: false, constraintViolations: 0 });
  });
});
