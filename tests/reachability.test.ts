import { describe, expect, it } from "vitest";
import { solveReachabilityProfile, type ReachabilityInput } from "../src/shared/planners/reachability";

function input(overrides: Partial<ReachabilityInput> = {}): ReachabilityInput {
  return {
    positions: [0, 1, 2],
    velocityLimits: [10, 10, 10],
    accelerationLimits: [1, 1],
    decelerationLimits: [1, 1],
    freeSpeeds: [1e9, 1e9],
    startVelocity: 0,
    goalVelocity: 0,
    ...overrides,
  };
}

describe("fixed-path reachability", () => {
  it("builds the fastest profile inside the backward controllable envelope", () => {
    const result = solveReachabilityProfile(input());

    expect(result.status).toBe("optimal");
    expect(result.velocities).toHaveLength(3);
    expect(result.velocities[0]).toBe(0);
    expect(result.velocities[1]).toBeCloseTo(Math.sqrt(2), 12);
    expect(result.velocities[2]).toBe(0);
    expect(result.iterations).toBe(4);
  });

  it("treats authored interior stops as exact phase boundaries", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1, 2, 3, 4],
      velocityLimits: [10, 10, 0, 10, 10],
      accelerationLimits: [1, 1, 1, 1],
      decelerationLimits: [1, 1, 1, 1],
      freeSpeeds: [1e9, 1e9, 1e9, 1e9],
    }));

    expect(result.status).toBe("optimal");
    expect(result.velocities).toEqual([0, Math.sqrt(2), 0, Math.sqrt(2), 0]);
  });

  it("applies the motor torque-speed envelope during forward reachability", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1, 2],
      accelerationLimits: [2, 2],
      decelerationLimits: [10, 10],
      freeSpeeds: [2, 2],
      startVelocity: 1,
    }));

    expect(result.status).toBe("optimal");
    expect(result.velocities[1]).toBeCloseTo(Math.sqrt(3), 12);
  });

  it("classifies a boundary that cannot brake to the goal as infeasible", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1],
      velocityLimits: [10, 10],
      accelerationLimits: [1],
      decelerationLimits: [1],
      freeSpeeds: [10],
      startVelocity: 2,
    }));

    expect(result).toMatchObject({
      status: "infeasible",
      reason: "Start velocity cannot decelerate to the authored goal and stops.",
    });
  });

  it("classifies a boundary above its local cap as invalid input", () => {
    const result = solveReachabilityProfile(input({
      velocityLimits: [1, 10, 10],
      startVelocity: 2,
    }));

    expect(result).toMatchObject({
      status: "invalid-input",
      iterations: 0,
      reason: "Start velocity exceeds the local velocity limit.",
    });
  });

  it("classifies an unreachable goal velocity as infeasible", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1],
      velocityLimits: [10, 10],
      accelerationLimits: [1],
      decelerationLimits: [10],
      freeSpeeds: [1e9],
      goalVelocity: 2,
    }));

    expect(result).toMatchObject({
      status: "infeasible",
      reason: "Goal velocity is unreachable from the authored start velocity and stops.",
    });
  });

  it("rejects malformed path grids without entering the numeric passes", () => {
    const result = solveReachabilityProfile(input({ positions: [0, 2, 1] }));

    expect(result).toMatchObject({
      status: "invalid-input",
      iterations: 0,
      reason: "Path positions must be monotonic.",
    });
  });

  it("rejects an under-resolved moving interval between stopped boundaries", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1],
      velocityLimits: [10, 10],
      accelerationLimits: [1],
      decelerationLimits: [1],
      freeSpeeds: [10],
    }));

    expect(result).toMatchObject({
      status: "invalid-input",
      reason: "Path interval 0 must include a moving sample between stopped boundaries.",
    });
  });

  it("is deterministic for identical normalized input", () => {
    const request = input({
      positions: [0, 0.25, 1.5, 3],
      velocityLimits: [0, 1.2, 2.5, 0],
      accelerationLimits: [3, 2, 1],
      decelerationLimits: [1, 2, 3],
      freeSpeeds: [4, 4, 4],
    });

    expect(solveReachabilityProfile(request)).toEqual(solveReachabilityProfile(request));
  });
});
