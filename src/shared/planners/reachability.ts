const EPSILON = 1e-9;

export type ReachabilityStatus = "optimal" | "invalid-input" | "infeasible";

export interface AffineAccelerationConstraint {
  uX: number;
  uY: number;
  xX: number;
  xY: number;
  limit: number;
  label?: string;
}

export interface ReachabilityInput {
  positions: readonly number[];
  velocityLimits: readonly number[];
  accelerationLimits: readonly number[];
  decelerationLimits: readonly number[];
  freeSpeeds: readonly number[];
  accelerationConstraints?: readonly (readonly AffineAccelerationConstraint[])[];
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

export function accelerationBoundsForSpeedSquared(
  constraints: readonly AffineAccelerationConstraint[],
  speedSquared: number,
): { minimum: number; maximum: number } | null {
  let minimum = Number.NEGATIVE_INFINITY;
  let maximum = Number.POSITIVE_INFINITY;
  for (const constraint of constraints) {
    const a = constraint.uX ** 2 + constraint.uY ** 2;
    const b = 2 * speedSquared * (constraint.uX * constraint.xX + constraint.uY * constraint.xY);
    const c = speedSquared ** 2 * (constraint.xX ** 2 + constraint.xY ** 2) - constraint.limit ** 2;
    if (a <= EPSILON) {
      if (c > EPSILON) return null;
      continue;
    }
    const discriminant = b ** 2 - 4 * a * c;
    if (discriminant < -EPSILON) return null;
    const root = Math.sqrt(Math.max(0, discriminant));
    minimum = Math.max(minimum, (-b - root) / (2 * a));
    maximum = Math.min(maximum, (-b + root) / (2 * a));
    if (minimum > maximum + EPSILON) return null;
  }
  return { minimum, maximum };
}

function accelerationBoundsForInterval(
  constraints: readonly AffineAccelerationConstraint[],
  startSpeedSquared: number,
  distance: number,
): { minimum: number; maximum: number } | null {
  if (distance <= EPSILON) return accelerationBoundsForSpeedSquared(constraints, startSpeedSquared);
  return accelerationBoundsForSpeedSquared(constraints.map((constraint) => ({
    ...constraint,
    // x_mid = x_start + u * ds for constant interval acceleration.
    // Substitution keeps the module equation affine in u.
    uX: constraint.uX + constraint.xX * distance,
    uY: constraint.uY + constraint.xY * distance,
  })), startSpeedSquared);
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
  if (input.accelerationConstraints && input.accelerationConstraints.length !== count - 1) {
    return invalid("Acceleration constraint count must be one less than the path sample count.");
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
    for (const constraint of input.accelerationConstraints?.[index] ?? []) {
      if (![constraint.uX, constraint.uY, constraint.xX, constraint.xY].every(Number.isFinite)
        || !(constraint.limit > 0) || !Number.isFinite(constraint.limit)) {
        return invalid(`Affine acceleration constraint ${index} must contain finite coefficients and a positive limit.`);
      }
    }
  }

  const velocitySquaredLimits = input.velocityLimits.map((velocity) => velocity ** 2);
  const startSquared = input.startVelocity ** 2;
  const goalSquared = input.goalVelocity ** 2;
  const boundaryTolerance = 1e-8;
  if (startSquared > velocitySquaredLimits[0] + boundaryTolerance) {
    return invalid("Start velocity exceeds the local velocity limit.");
  }
  if (goalSquared > velocitySquaredLimits[count - 1] + boundaryTolerance) {
    return invalid("Goal velocity exceeds the local velocity limit.");
  }

  const controllable = new Array<number>(count);
  controllable[count - 1] = goalSquared;
  for (let index = count - 2; index >= 0; index -= 1) {
    const distance = Math.max(0, input.positions[index + 1] - input.positions[index]);
    const scalarMaximum = Math.min(
      velocitySquaredLimits[index],
      controllable[index + 1] + 2 * input.decelerationLimits[index] * distance,
    );
    const constraints = input.accelerationConstraints?.[index] ?? [];
    if (constraints.length === 0 || distance <= EPSILON || scalarMaximum <= controllable[index + 1]) {
      controllable[index] = scalarMaximum;
      continue;
    }
    const canReachNext = (candidate: number) => {
      const acceleration = (controllable[index + 1] - candidate) / (2 * distance);
      const bounds = accelerationBoundsForInterval(constraints, candidate, distance);
      return bounds !== null
        && acceleration >= Math.max(-input.decelerationLimits[index], bounds.minimum) - EPSILON
        && acceleration <= bounds.maximum + EPSILON;
    };
    if (canReachNext(scalarMaximum)) {
      controllable[index] = scalarMaximum;
      continue;
    }
    let lower = Math.min(controllable[index + 1], scalarMaximum);
    let upper = scalarMaximum;
    if (!canReachNext(lower)) {
      return { status: "infeasible", velocities: [], iterations: count - 1, reason: `Drivetrain acceleration bounds are empty at interval ${index}.` };
    }
    for (let iteration = 0; iteration < 36; iteration += 1) {
      const candidate = (lower + upper) * 0.5;
      if (canReachNext(candidate)) lower = candidate;
      else upper = candidate;
    }
    controllable[index] = lower;
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
    const drivetrainBounds = accelerationBoundsForInterval(
      input.accelerationConstraints?.[index] ?? [],
      speedSquared[index],
      distance,
    );
    if (!drivetrainBounds) {
      return { status: "infeasible", velocities: [], iterations: count - 1 + index, reason: `Drivetrain acceleration bounds are empty at interval ${index}.` };
    }
    const acceleration = Math.min(input.accelerationLimits[index] * motorScale, drivetrainBounds.maximum);
    if (acceleration < Math.max(-input.decelerationLimits[index], drivetrainBounds.minimum) - EPSILON) {
      return { status: "infeasible", velocities: [], iterations: count - 1 + index, reason: `Drivetrain acceleration bounds are contradictory at interval ${index}.` };
    }
    speedSquared[index + 1] = Math.min(
      velocitySquaredLimits[index + 1],
      controllable[index + 1],
      speedSquared[index] + 2 * acceleration * distance,
    );
    if (distance > EPSILON) {
      const actualAcceleration = (speedSquared[index + 1] - speedSquared[index]) / (2 * distance);
      if (actualAcceleration < Math.max(-input.decelerationLimits[index], drivetrainBounds.minimum) - EPSILON
        || actualAcceleration > drivetrainBounds.maximum + EPSILON) {
        return { status: "infeasible", velocities: [], iterations: count - 1 + index, reason: `Velocity caps require impossible acceleration at interval ${index}.` };
      }
    }
  }
  if (speedSquared[count - 1] < goalSquared - boundaryTolerance) {
    return { status: "infeasible", velocities: [], iterations: (count - 1) * 2, reason: "Goal velocity is unreachable from the authored start velocity and stops." };
  }
  speedSquared[count - 1] = goalSquared;

  for (let index = 0; index < count - 1; index += 1) {
    const distance = input.positions[index + 1] - input.positions[index];
    if (distance > EPSILON && speedSquared[index] + speedSquared[index + 1] <= EPSILON) {
      return {
        status: "invalid-input",
        velocities: [],
        iterations: (count - 1) * 2,
        reason: `Path interval ${index} must include a moving sample between stopped boundaries.`,
      };
    }
  }

  return {
    status: "optimal",
    velocities: speedSquared.map((value) => Math.sqrt(Math.max(0, value))),
    iterations: (count - 1) * 2,
  };
}
