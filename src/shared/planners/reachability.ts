const EPSILON = 1e-9;

export type ReachabilityStatus = "optimal" | "invalid-input" | "infeasible";

export interface ReachabilityInput {
  positions: readonly number[];
  velocityLimits: readonly number[];
  accelerationLimits: readonly number[];
  decelerationLimits: readonly number[];
  freeSpeeds: readonly number[];
  startVelocity: number;
  goalVelocity: number;
}

export interface ReachabilityResult {
  status: ReachabilityStatus;
  velocities: number[];
  iterations: number;
  reason?: string;
}

function invalid(reason: string): ReachabilityResult {
  return { status: "invalid-input", velocities: [], iterations: 0, reason };
}

function isFiniteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Computes the fastest controllable scalar speed profile over a fixed path.
 * The backward pass finds the maximum speed that can still reach the authored
 * goal; the forward pass takes the greatest acceleration-safe speed inside
 * that controllable envelope.
 */
export function solveReachabilityProfile(input: ReachabilityInput): ReachabilityResult {
  const count = input.positions.length;
  if (count < 2) return invalid("Reachability optimization requires at least two path samples.");
  if (input.velocityLimits.length !== count) return invalid("Velocity limit count must match path sample count.");
  if (input.accelerationLimits.length !== count - 1
    || input.decelerationLimits.length !== count - 1
    || input.freeSpeeds.length !== count - 1) {
    return invalid("Interval limit counts must be one less than the path sample count.");
  }
  if (!isFiniteNonnegative(input.startVelocity) || !isFiniteNonnegative(input.goalVelocity)) {
    return invalid("Boundary velocities must be finite and nonnegative.");
  }

  for (let index = 0; index < count; index += 1) {
    if (!Number.isFinite(input.positions[index])) return invalid(`Path position ${index} must be finite.`);
    if (index > 0 && input.positions[index] < input.positions[index - 1] - EPSILON) {
      return invalid("Path positions must be monotonic.");
    }
    if (!isFiniteNonnegative(input.velocityLimits[index])) return invalid(`Velocity limit ${index} must be finite and nonnegative.`);
  }
  for (let index = 0; index < count - 1; index += 1) {
    if (!(input.accelerationLimits[index] > 0) || !Number.isFinite(input.accelerationLimits[index])) {
      return invalid(`Acceleration limit ${index} must be finite and positive.`);
    }
    if (!(input.decelerationLimits[index] > 0) || !Number.isFinite(input.decelerationLimits[index])) {
      return invalid(`Deceleration limit ${index} must be finite and positive.`);
    }
    if (!(input.freeSpeeds[index] > 0) || !Number.isFinite(input.freeSpeeds[index])) {
      return invalid(`Free speed ${index} must be finite and positive.`);
    }
  }

  const velocitySquaredLimits = input.velocityLimits.map((velocity) => velocity ** 2);
  const startSquared = input.startVelocity ** 2;
  const goalSquared = input.goalVelocity ** 2;
  const boundaryTolerance = 1e-8;
  if (startSquared > velocitySquaredLimits[0] + boundaryTolerance) {
    return { status: "infeasible", velocities: [], iterations: 0, reason: "Start velocity exceeds the local velocity limit." };
  }
  if (goalSquared > velocitySquaredLimits[count - 1] + boundaryTolerance) {
    return { status: "infeasible", velocities: [], iterations: 0, reason: "Goal velocity exceeds the local velocity limit." };
  }

  const controllable = new Array<number>(count);
  controllable[count - 1] = goalSquared;
  for (let index = count - 2; index >= 0; index -= 1) {
    const distance = Math.max(0, input.positions[index + 1] - input.positions[index]);
    controllable[index] = Math.min(
      velocitySquaredLimits[index],
      controllable[index + 1] + 2 * input.decelerationLimits[index] * distance,
    );
  }
  if (startSquared > controllable[0] + boundaryTolerance) {
    return { status: "infeasible", velocities: [], iterations: count - 1, reason: "Start velocity cannot decelerate to the authored goal and stops." };
  }

  const speedSquared = new Array<number>(count).fill(0);
  speedSquared[0] = startSquared;
  for (let index = 0; index < count - 1; index += 1) {
    const distance = Math.max(0, input.positions[index + 1] - input.positions[index]);
    const velocity = Math.sqrt(Math.max(0, speedSquared[index]));
    const motorScale = Math.max(0, Math.min(1, 1 - velocity / input.freeSpeeds[index]));
    const acceleration = input.accelerationLimits[index] * motorScale;
    speedSquared[index + 1] = Math.min(
      velocitySquaredLimits[index + 1],
      controllable[index + 1],
      speedSquared[index] + 2 * acceleration * distance,
    );
  }
  if (speedSquared[count - 1] < goalSquared - boundaryTolerance) {
    return { status: "infeasible", velocities: [], iterations: (count - 1) * 2, reason: "Goal velocity is unreachable from the authored start velocity and stops." };
  }
  speedSquared[count - 1] = goalSquared;

  return {
    status: "optimal",
    velocities: speedSquared.map((value) => Math.sqrt(Math.max(0, value))),
    iterations: (count - 1) * 2,
  };
}
