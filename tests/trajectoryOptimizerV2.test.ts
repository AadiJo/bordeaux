import { describe, expect, it } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { projectDrivetrainAtPoint } from "../src/shared/planners/drivetrainProjection";
import { fixedPathSamples, getPlanner } from "../src/shared/planners";
import { optimizedTrajectoryPlanner } from "../src/shared/planners/optimizedTrajectory";
import {
  buildLinearConstraintProfile,
  buildReachabilityInput,
  insertOptimizationBoundaries,
} from "../src/shared/planners/optimizationConstraints";
import { profiledSplineOptimizationSeed } from "../src/shared/planners/profiledSpline";
import { buildCanonicalPathState, interpolatePathPoint, type CanonicalPathPoint } from "../src/shared/planners/pathState";
import { accelerationBoundsForSpeedSquared, solveReachabilityProfile } from "../src/shared/planners/reachability";
import { validateOptimizedTrajectory } from "../src/shared/planners/trajectoryValidation";
import type { PlannerResult, RobotConfig, TrajectorySample } from "../src/shared/types";

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
    authoredStop: false,
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
      motorMaxTorqueNm: 2.6,
      motorCount: 4,
      gearRatio: 6,
      wheelDiameterM: 0.1,
      massKg: 52,
      moiKgM2: 6,
      wheelbaseM: 0.6,
      trackwidthM: 0.8,
      wheelFrictionCoefficient: 1.1,
    },
  };
}

function trajectorySample(i: number, s: number, t: number): TrajectorySample {
  return {
    i, s, t, f: s / 2, x: s, y: 0, headingRad: 0,
    velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0,
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

  it("uses synthetic stops only as heading phase boundaries", () => {
    const before = point({ curvatureInvM: 1, headingDerivativeRadPerM: 2 });
    const after = point({
      s: 1,
      f: 1,
      curvatureInvM: 5,
      headingDerivativeRadPerM: 8,
      stop: true,
      authoredStop: false,
    });

    const midpoint = interpolatePathPoint(before, after);

    expect(midpoint.curvatureInvM).toBe(3);
    expect(midpoint.headingDerivativeRadPerM).toBe(2);
  });
});

describe("drivetrain projection", () => {
  it("caps tank wheel speed from signed curvature and trackwidth", () => {
    const tank = robot("tank");
    delete tank.driveModel!.motorMaxTorqueNm;
    const projection = projectDrivetrainAtPoint(point({
      curvatureInvM: 1,
      headingDerivativeRadPerM: 1,
    }), tank, 1e9);

    expect(projection.velocityLimitMps).toBeCloseTo(5 / 1.4, 12);
  });

  it("caps the fastest rectangular swerve module during simultaneous translation and rotation", () => {
    const swerve = robot("swerve");
    delete swerve.driveModel!.motorMaxTorqueNm;
    const projection = projectDrivetrainAtPoint(point({
      headingDerivativeRadPerM: 1,
    }), swerve, 1e9);

    expect(projection.velocityLimitMps).toBeCloseTo(5 / Math.sqrt(2.05), 12);
    expect(projection.velocityConstraints).toHaveLength(4);
  });

  it("tightens module acceleration as module speed approaches motor free speed", () => {
    const projection = projectDrivetrainAtPoint(point({ headingDerivativeRadPerM: 1 }), robot("swerve"), 10);
    const constraint = projection.motorAccelerationConstraints[0];
    const withoutMotor = { ...constraint, velocityCoefficient: undefined, freeSpeed: undefined, motorAcceleration: undefined };
    const scalarSpeed = 0.6 * constraint.freeSpeed! / constraint.velocityCoefficient!;
    const physical = accelerationBoundsForSpeedSquared([], scalarSpeed ** 2, [constraint])!;
    const fixed = accelerationBoundsForSpeedSquared([], scalarSpeed ** 2, [withoutMotor])!;

    expect(physical.maximum).toBeLessThan(fixed.maximum);
  });

  it("accepts a stationary inner tank wheel at the instantaneous center", () => {
    const projection = projectDrivetrainAtPoint(point({
      curvatureInvM: 2.5,
      headingDerivativeRadPerM: 2.5,
    }), robot("tank"), 10);
    const stationaryWheel = projection.velocityConstraints.find((constraint) => constraint.coefficient === 0);

    expect(stationaryWheel).toBeDefined();
    const result = solveReachabilityProfile({
      positions: [0, 1, 2],
      velocityLimits: [2, 2, 2],
      accelerationLimits: [10, 10],
      decelerationLimits: [10, 10],
      freeSpeeds: [1e9, 1e9],
      accelerationConstraints: [projection.accelerationConstraints, projection.accelerationConstraints],
      startVelocity: 0,
      goalVelocity: 0,
    });

    expect(result.status).not.toBe("invalid-input");
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
  it("keeps movement after interior stationary phases in fixed-path validation", () => {
    const result = {
      samples: [
        trajectorySample(0, 0, 0),
        trajectorySample(1, 1, 1),
        trajectorySample(2, 1, 2),
        trajectorySample(3, 2, 3),
      ],
    } as PlannerResult;

    expect(fixedPathSamples(result)).toHaveLength(4);
    result.samples.push(trajectorySample(4, 2, 4));
    expect(fixedPathSamples(result)).toHaveLength(4);
  });

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

  it("rejects a tangent-discontinuous path after independent dense validation", () => {
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

    expect(result.optimization).toMatchObject({ status: "internal-error", refinementPasses: 2, fallback: true });
    expect(result.optimization?.constraintViolations).toBeGreaterThan(0);
    expect(result.optimization?.fallbackReason).toContain("Dense validation found");
  });

  it("uses a zero-speed phase boundary for a heading-rate discontinuity", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.constraints = {
      ...path.constraints,
      maxVel: 4,
      maxAccel: 3,
      maxDecel: 3,
      maxAngVel: 720,
      maxAngAccel: 1_000,
    };
    path.waypoints = buildWaypoints([
      { x: 0, y: 0, nextC: { x: 1, y: 0 } },
      { x: 2, y: 0, prevC: { x: 1, y: 0 }, nextC: { x: 3, y: 0 } },
      { x: 4, y: 1, prevC: { x: 3.5, y: 1 } },
    ]);

    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot, samplesPerSegment: 24 });
    const boundary = result.samples.find((sample) => Math.hypot(sample.x - 2, sample.y) < 1e-8);

    expect(result.optimization).toMatchObject({ status: "optimal", fallback: false, constraintViolations: 0 });
    expect(boundary?.velocityMps).toBe(0);
  });

  it("derives optimizer limits independently from Profiled timing samples", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const baseline = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    const first = buildReachabilityInput({ path, robot: project.robot }, baseline.samples);
    const retimed = baseline.samples.map((sample, index) => ({
      ...sample,
      t: index * 100,
      velocityMps: index % 2 ? 0.01 : 100,
      accelerationMps2: -999,
      angularVelocityRadps: 999,
    }));

    expect(buildReachabilityInput({ path, robot: project.robot }, retimed)).toEqual(first);
  });

  it("inserts exact range boundaries without tightening adjacent intervals", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.ranges = [{
      anchor: "param",
      f0: 0.205,
      f1: 0.795,
      maxVel: 0.25,
      maxAccel: 1,
      maxDecel: 1,
      maxAngVel: 360,
      maxAngAccel: 720,
    }];
    const input = { path, robot: project.robot, samplesPerSegment: 8 };
    const bounded = insertOptimizationBoundaries(input, profiledSplineOptimizationSeed(input).samples);
    const profile = buildLinearConstraintProfile(input, bounded);
    const start = bounded.findIndex((sample) => Math.abs(sample.f - 0.205) < 1e-9);
    const end = bounded.findIndex((sample) => Math.abs(sample.f - 0.795) < 1e-9);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(profile.intervals[start - 1].velocity).toBeGreaterThan(0.25);
    expect(profile.intervals[start].velocity).toBe(0.25);
    expect(profile.intervals[end - 1].velocity).toBe(0.25);
    expect(profile.intervals[end].velocity).toBeGreaterThan(0.25);
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
