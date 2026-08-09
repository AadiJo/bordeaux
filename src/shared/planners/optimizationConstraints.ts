import type { PlannerInput, TrajectorySample } from "../types";
import { activeRanges, effectiveRanges, type EffectiveRange } from "./rotationPriority";
import type { ReachabilityInput } from "./reachability";

const EPSILON = 1e-9;
const NUMERICAL_SAFETY = 0.995;

export interface LinearLimits {
  freeSpeed: number;
  velocity: number;
  acceleration: number;
  deceleration: number;
}

export interface LinearConstraintProfile {
  points: LinearLimits[];
  intervals: LinearLimits[];
}

function baseLinearLimits(input: PlannerInput): LinearLimits {
  const freeSpeed = Math.max(0.01, input.robot.maxSpeed || input.path.constraints.maxVel || 0.01);
  return {
    freeSpeed,
    velocity: Math.max(0.01, Math.min(freeSpeed, input.path.constraints.maxVel || freeSpeed)),
    acceleration: Math.max(0.01, input.path.constraints.maxAccel || 0.01),
    deceleration: Math.max(0.01, input.path.constraints.maxDecel ?? input.path.constraints.maxAccel ?? 0.01),
  };
}

function tightenLinearLimits(limits: LinearLimits, ranges: readonly EffectiveRange[]): LinearLimits {
  let velocity = limits.velocity;
  let acceleration = limits.acceleration;
  let deceleration = limits.deceleration;
  ranges.forEach((range) => {
    if (range.maxVel > 0) velocity = Math.min(velocity, range.maxVel);
    if (range.maxAccel > 0) acceleration = Math.min(acceleration, range.maxAccel);
    const rangeDeceleration = range.maxDecel ?? range.maxAccel;
    if (rangeDeceleration > 0) deceleration = Math.min(deceleration, rangeDeceleration);
  });
  return { ...limits, velocity, acceleration, deceleration };
}

function intervalRanges(ranges: readonly EffectiveRange[], before: number, after: number): EffectiveRange[] {
  const start = Math.min(before, after);
  const end = Math.max(before, after);
  return ranges.filter((range) => Math.min(end, range.end) - Math.max(start, range.start) >= -EPSILON);
}

export function buildLinearConstraintProfile(input: PlannerInput, samples: readonly TrajectorySample[]): LinearConstraintProfile {
  const base = baseLinearLimits(input);
  const ranges = effectiveRanges(input.path, samples, samples.at(-1)?.s ?? 0);
  return {
    points: samples.map((sample) => tightenLinearLimits(base, activeRanges(ranges, sample.f))),
    intervals: samples.slice(1).map((sample, index) => tightenLinearLimits(
      base,
      intervalRanges(ranges, samples[index].f, sample.f),
    )),
  };
}

/**
 * Adapts Bordeaux's authored limits and geometry-derived velocity envelope to
 * the isolated scalar reachability solver. The existing profiled trajectory is
 * used only as a conservative pointwise geometry/rotation cap.
 */
export function buildReachabilityInput(
  input: PlannerInput,
  samples: readonly TrajectorySample[],
): ReachabilityInput {
  const profile = buildLinearConstraintProfile(input, samples);
  const startVelocity = input.path.waypoints[0]?.stop
    ? 0
    : Math.min(profile.points[0].velocity, Math.max(0, input.path.startVel || 0));
  const goalVelocity = input.path.waypoints.at(-1)?.stop
    ? 0
    : Math.min(profile.points.at(-1)!.velocity, Math.max(0, input.path.goalVel || 0));
  return {
    positions: samples.map((sample) => sample.s),
    velocityLimits: samples.map((sample, index) => Math.min(
      profile.points[index].velocity,
      Math.max(0, sample.velocityMps),
    )),
    // Keep the rounded trajectory inside the independently checked authored
    // envelope without weakening the limits used by final validation.
    accelerationLimits: profile.intervals.map((limits) => limits.acceleration * NUMERICAL_SAFETY),
    decelerationLimits: profile.intervals.map((limits) => limits.deceleration * NUMERICAL_SAFETY),
    freeSpeeds: profile.intervals.map((limits) => limits.freeSpeed),
    startVelocity,
    goalVelocity,
  };
}

export function countLinearConstraintViolations(input: PlannerInput, samples: readonly TrajectorySample[]): number {
  const profile = buildLinearConstraintProfile(input, samples);
  let violations = 0;
  samples.forEach((sample, index) => {
    const pointVelocityTolerance = Math.max(1e-4, profile.points[index].velocity * 1e-4);
    if (sample.velocityMps > profile.points[index].velocity + pointVelocityTolerance) violations += 1;
    if (index === 0) return;

    const previous = samples[index - 1];
    const interval = profile.intervals[index - 1];
    const intervalVelocityTolerance = Math.max(1e-4, interval.velocity * 1e-4);
    if (Math.max(previous.velocityMps, sample.velocityMps) > interval.velocity + intervalVelocityTolerance) violations += 1;
    const distance = sample.s - previous.s;
    if (distance <= EPSILON) return;
    const acceleration = (sample.velocityMps ** 2 - previous.velocityMps ** 2) / (2 * distance);
    const limit = acceleration >= 0
      ? interval.acceleration * Math.max(0, Math.min(1, 1 - previous.velocityMps / interval.freeSpeed))
      : interval.deceleration;
    if (Math.abs(acceleration) > limit + Math.max(1e-3, limit * 1e-3)) violations += 1;
  });
  return violations;
}
