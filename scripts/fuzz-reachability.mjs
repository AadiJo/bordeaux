import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { solveReachabilityProfile } = require("../dist-electron/shared/planners/reachability.js");

const requestedCases = Number.parseInt(process.env.BORDEAUX_FUZZ_CASES ?? "100000", 10);
const caseOffset = Number.parseInt(process.env.BORDEAUX_FUZZ_OFFSET ?? "0", 10);
if (!Number.isInteger(requestedCases) || requestedCases < 1 || requestedCases > 1_000_000) {
  throw new Error("BORDEAUX_FUZZ_CASES must be an integer from 1 through 1000000.");
}
if (!Number.isInteger(caseOffset) || caseOffset < 0 || caseOffset > 1_000_000) {
  throw new Error("BORDEAUX_FUZZ_OFFSET must be an integer from 0 through 1000000.");
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function between(random, minimum, maximum) {
  return minimum + (maximum - minimum) * random();
}

function requestFor(index) {
  const random = randomGenerator(0x2468b0de ^ index);
  const count = 3 + Math.floor(random() * 18);
  const positions = [0];
  for (let point = 1; point < count; point += 1) {
    positions.push(positions.at(-1) + between(random, 0.01, 0.8));
  }
  const velocityLimits = Array.from({ length: count }, (_unused, point) => (
    point === 0 || point === count - 1 || (point > 1 && point < count - 2 && random() < 0.03)
      ? 0
      : between(random, 0.2, 6)
  ));
  const accelerationLimits = [];
  const decelerationLimits = [];
  const freeSpeeds = [];
  const accelerationConstraints = [];
  const scalarAccelerationConstraints = [];
  for (let interval = 0; interval < count - 1; interval += 1) {
    accelerationLimits.push(between(random, 0.2, 8));
    decelerationLimits.push(between(random, 0.2, 8));
    freeSpeeds.push(between(random, 3, 9));
    const angle = between(random, -Math.PI, Math.PI);
    const curvatureAngle = between(random, -Math.PI, Math.PI);
    accelerationConstraints.push([{
      uX: Math.cos(angle),
      uY: Math.sin(angle),
      xX: between(random, 0, 1.5) * Math.cos(curvatureAngle),
      xY: between(random, 0, 1.5) * Math.sin(curvatureAngle),
      limit: between(random, 0.5, 10),
    }]);
    if (index % 4 === 0) {
      const velocityCoefficient = between(random, 0.1, 2);
      const motorAcceleration = between(random, 0.5, 12);
      scalarAccelerationConstraints.push([{
        u: velocityCoefficient,
        x: between(random, -1.5, 1.5),
        minimum: -motorAcceleration,
        maximum: motorAcceleration,
        velocityCoefficient,
        freeSpeed: between(random, 1, 8),
        motorAcceleration,
      }]);
    } else scalarAccelerationConstraints.push([]);
  }
  return {
    positions,
    velocityLimits,
    accelerationLimits,
    decelerationLimits,
    freeSpeeds,
    accelerationConstraints,
    scalarAccelerationConstraints,
    startVelocity: 0,
    goalVelocity: 0,
  };
}

function verifyOptimal(request, result, caseIndex) {
  const tolerance = 1e-7;
  for (let point = 0; point < result.velocities.length; point += 1) {
    const velocity = result.velocities[point];
    if (!Number.isFinite(velocity) || velocity < -tolerance || velocity > request.velocityLimits[point] + tolerance) {
      throw new Error(`Case ${caseIndex} violates velocity cap at point ${point}.`);
    }
    if (point === 0) continue;
    const interval = point - 1;
    const distance = request.positions[point] - request.positions[point - 1];
    const beforeSquared = result.velocities[point - 1] ** 2;
    const afterSquared = velocity ** 2;
    const acceleration = (afterSquared - beforeSquared) / (2 * distance);
    const motorLimit = request.accelerationLimits[interval]
      * Math.max(0, 1 - Math.max(result.velocities[point - 1], velocity) / request.freeSpeeds[interval]);
    if (acceleration > motorLimit + tolerance || -acceleration > request.decelerationLimits[interval] + tolerance) {
      throw new Error(`Case ${caseIndex} violates scalar acceleration at interval ${interval}.`);
    }
    const midpointSpeedSquared = (beforeSquared + afterSquared) * 0.5;
    for (const constraint of request.accelerationConstraints[interval]) {
      const measured = Math.hypot(
        constraint.uX * acceleration + constraint.xX * midpointSpeedSquared,
        constraint.uY * acceleration + constraint.xY * midpointSpeedSquared,
      );
      if (measured > constraint.limit + tolerance) {
        throw new Error(`Case ${caseIndex} violates affine acceleration at interval ${interval}.`);
      }
    }
    for (const constraint of request.scalarAccelerationConstraints[interval]) {
      const moduleSpeed = constraint.velocityCoefficient * Math.max(result.velocities[point - 1], velocity);
      const limit = constraint.motorAcceleration * Math.max(0, 1 - moduleSpeed / constraint.freeSpeed);
      const measured = Math.abs(constraint.u * acceleration + constraint.x * midpointSpeedSquared);
      if (measured > limit + tolerance) {
        throw new Error(`Case ${caseIndex} violates module motor acceleration at interval ${interval}.`);
      }
    }
  }
}

const counts = { optimal: 0, "invalid-input": 0, infeasible: 0 };
const started = performance.now();
for (let caseIndex = 0; caseIndex < requestedCases; caseIndex += 1) {
  const absoluteCaseIndex = caseOffset + caseIndex;
  const request = requestFor(absoluteCaseIndex);
  const result = solveReachabilityProfile(request);
  if (!(result.status in counts)) throw new Error(`Case ${absoluteCaseIndex} returned unknown status ${result.status}.`);
  counts[result.status] += 1;
  if (result.status === "optimal") verifyOptimal(request, result, absoluteCaseIndex);
  if (caseIndex < 1_000) {
    const repeated = solveReachabilityProfile(request);
    if (JSON.stringify(repeated) !== JSON.stringify(result)) {
      throw new Error(`Case ${absoluteCaseIndex} is nondeterministic.`);
    }
  }
}

console.log(JSON.stringify({
  cases: requestedCases,
  offset: caseOffset,
  elapsedMs: Number((performance.now() - started).toFixed(1)),
  statuses: counts,
  unexplainedFailures: 0,
}));
