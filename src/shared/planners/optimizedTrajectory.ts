import type {
  PlannerInput,
  PlannerOptimizationDiagnostics,
  PlannerResult,
  TrajectoryPlanner,
  TrajectorySample,
  ValidationIssue,
} from "../types";
import { buildReachabilityInput, countLinearConstraintViolations } from "./optimizationConstraints";
import { DEFAULT_SAMPLES_PER_SEGMENT, MAX_TRAJECTORY_SAMPLES } from "./limits";
import { profiledSplinePlanner } from "./profiledSpline";
import { solveReachabilityProfile, type ReachabilityStatus } from "./reachability";
import { translationPriorityStartIndex } from "./rotationPriority";
import { validateOptimizedTrajectory, type TrajectoryValidationResult } from "./trajectoryValidation";

const R = (value: number, places = 4) => Number(value.toFixed(places));
const MAX_REFINEMENT_PASSES = 2;

function remapTiming(samples: TrajectorySample[], velocities: number[]): TrajectorySample[] {
  if (samples.length < 2) return samples;

  const times = new Array(samples.length).fill(0);
  for (let i = 1; i < samples.length; i += 1) {
    const ds = Math.max(0, samples[i].s - samples[i - 1].s);
    const avgV = Math.max(1e-6, (velocities[i] + velocities[i - 1]) * 0.5);
    times[i] = times[i - 1] + ds / avgV;
  }

  return samples.map((sample, i) => {
    const dtPrev = i > 0 ? Math.max(1e-6, times[i] - times[i - 1]) : 0;
    const dtNext = i < samples.length - 1 ? Math.max(1e-6, times[i + 1] - times[i]) : dtPrev;
    const accel =
      i === 0
        ? 0
        : i === samples.length - 1
          ? 0
          : (velocities[i + 1] - velocities[i - 1]) / Math.max(1e-6, dtPrev + dtNext);
    const headingDelta =
      i === 0
        ? 0
        : Math.atan2(Math.sin(sample.headingRad - samples[i - 1].headingRad), Math.cos(sample.headingRad - samples[i - 1].headingRad));
    return {
      ...sample,
      t: R(times[i], 4),
      velocityMps: R(velocities[i], 4),
      accelerationMps2: R(accel, 4),
      angularVelocityRadps: R(i === 0 ? 0 : headingDelta / dtPrev, 5),
    };
  });
}

function timeAtFraction(samples: TrajectorySample[], fraction: number): number {
  if (samples.length === 0) return 0;
  const target = Math.max(0, Math.min(1, fraction));
  if (target <= samples[0].f) return samples[0].t;
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    if (current.f >= target) {
      const previous = samples[index - 1];
      const span = Math.max(1e-9, current.f - previous.f);
      return previous.t + (current.t - previous.t) * ((target - previous.f) / span);
    }
  }
  return samples[samples.length - 1].t;
}

function diagnostics(
  input: PlannerInput,
  samples: TrajectorySample[],
  solveTimeMs: number,
  status: ReachabilityStatus | "feasible" | "internal-error",
  iterations: number,
  fallbackReason?: string,
  validation?: TrajectoryValidationResult,
  refinementPasses = 0,
): PlannerOptimizationDiagnostics {
  const maxVelocityMps = samples.reduce((max, sample) => Math.max(max, Math.abs(sample.velocityMps)), 0);
  const maxAccelerationMps2 = samples.reduce((max, sample) => Math.max(max, Math.abs(sample.accelerationMps2)), 0);
  return {
    plannerUsed: "optimizedTrajectory",
    status,
    iterations,
    refinementPasses,
    validatedPoints: validation?.checkedPoints,
    activeConstraints: validation?.activeConstraints,
    solveTimeMs: R(solveTimeMs, 3),
    totalTimeS: R(samples[samples.length - 1]?.t ?? 0, 4),
    maxVelocityMps: R(maxVelocityMps, 4),
    maxAccelerationMps2: R(maxAccelerationMps2, 4),
    constraintViolations: validation?.violations.length ?? countLinearConstraintViolations(input, samples),
    fallback: Boolean(fallbackReason),
    fallbackReason,
  };
}

export const optimizedTrajectoryPlanner: TrajectoryPlanner = {
  id: "optimizedTrajectory",
  generate(input: PlannerInput): PlannerResult {
    const started = performance.now();
    const base = profiledSplinePlanner.generate(input);
    const solveTimeMs = performance.now() - started;

    if (base.samples.length < 2) {
      const fallbackReason = "Profiled spline did not produce enough samples for optimization.";
      const issue: ValidationIssue = {
        severity: "warning",
        path: `paths.${input.path.name}.planner`,
        message: fallbackReason,
      };
      return {
        ...base,
        planner: "profiledSpline",
        diagnostics: [...base.diagnostics, issue],
        optimization: {
          ...diagnostics(input, base.samples, solveTimeMs, "invalid-input", 0, fallbackReason),
          plannerUsed: "profiledSpline",
        },
      };
    }

    if ((input.path.constraints.maxJerk ?? 0) > 0) {
      const reason = "Optimized trajectory does not yet support nonzero translational jerk.";
      return {
        ...base,
        planner: "optimizedTrajectory",
        diagnostics: [...base.diagnostics, {
          severity: "error",
          path: `paths.${input.path.name}.constraints.maxJerk`,
          message: reason,
        }],
        optimization: diagnostics(input, base.samples, performance.now() - started, "invalid-input", 0),
      };
    }

    try {
      let candidateBase = base;
      let samplesPerSegment = input.samplesPerSegment ?? DEFAULT_SAMPLES_PER_SEGMENT;
      let totalIterations = 0;
      for (let refinementPasses = 0; refinementPasses <= MAX_REFINEMENT_PASSES; refinementPasses += 1) {
        const reachability = solveReachabilityProfile(buildReachabilityInput(input, candidateBase.samples));
        totalIterations += reachability.iterations;
        if (reachability.status !== "optimal") {
          const reason = reachability.reason ?? "The fixed-path optimizer could not produce a trajectory.";
          const issue: ValidationIssue = {
            severity: "error",
            path: `paths.${input.path.name}.planner`,
            message: `Optimized trajectory is ${reachability.status}: ${reason}`,
          };
          return {
            ...candidateBase,
            planner: "optimizedTrajectory",
            diagnostics: [...candidateBase.diagnostics, issue],
            optimization: diagnostics(
              input,
              candidateBase.samples,
              performance.now() - started,
              reachability.status,
              totalIterations,
              undefined,
              undefined,
              refinementPasses,
            ),
          };
        }

        const samples = remapTiming(candidateBase.samples, reachability.velocities);
        const translationPriorityStart = translationPriorityStartIndex(
          input.path,
          samples,
          candidateBase.totalDistanceM,
        );
        const validation = validateOptimizedTrajectory(input, samples, {
          skipAngularFromIndex: translationPriorityStart ?? undefined,
        });
        if (validation.violations.length === 0) {
          const totalTimeS = R(samples[samples.length - 1]?.t ?? candidateBase.totalTimeS, 4);
          return {
            planner: "optimizedTrajectory",
            totalTimeS,
            totalDistanceM: candidateBase.totalDistanceM,
            samples,
            markers: candidateBase.markers.map((marker) => ({ ...marker, timeS: R(timeAtFraction(samples, marker.fraction), 4) })),
            diagnostics: candidateBase.diagnostics,
            optimization: diagnostics(
              input,
              samples,
              performance.now() - started,
              translationPriorityStart !== null ? "feasible" : "optimal",
              totalIterations,
              undefined,
              validation,
              refinementPasses,
            ),
          };
        }

        const allRefinable = validation.violations.every((violation) => violation.refinable);
        const segmentCount = Math.max(0, input.path.waypoints.length - 1);
        const nextSamplesPerSegment = samplesPerSegment * 2;
        const withinSampleLimit = segmentCount <= Math.floor((MAX_TRAJECTORY_SAMPLES - 1) / nextSamplesPerSegment);
        if (allRefinable && refinementPasses < MAX_REFINEMENT_PASSES && withinSampleLimit) {
          samplesPerSegment = nextSamplesPerSegment;
          candidateBase = profiledSplinePlanner.generate({ ...input, samplesPerSegment });
          continue;
        }

        const firstViolation = validation.violations[0];
        const fallbackReason = `Dense validation found ${validation.violations.length} constraint violation${validation.violations.length === 1 ? "" : "s"}: ${firstViolation.message}`;
        const issue: ValidationIssue = {
          severity: "warning",
          path: `paths.${input.path.name}.planner`,
          message: `Optimized trajectory fell back to profiled spline: ${fallbackReason}`,
        };
        return {
          ...candidateBase,
          planner: "profiledSpline",
          diagnostics: [...candidateBase.diagnostics, issue],
          optimization: {
            ...diagnostics(
              input,
              candidateBase.samples,
              performance.now() - started,
              "internal-error",
              totalIterations,
              fallbackReason,
              validation,
              refinementPasses,
            ),
            plannerUsed: "profiledSpline",
          },
        };
      }
      throw new Error("Optimizer refinement loop ended without a result.");
    } catch (error) {
      const fallbackReason = error instanceof Error ? error.message : "Optimizer failed.";
      const issue: ValidationIssue = {
        severity: "warning",
        path: `paths.${input.path.name}.planner`,
        message: `Optimized trajectory fell back to profiled spline: ${fallbackReason}`,
      };
      return {
        ...base,
        planner: "profiledSpline",
        diagnostics: [...base.diagnostics, issue],
        optimization: {
          ...diagnostics(input, base.samples, performance.now() - started, "internal-error", 0, fallbackReason),
          plannerUsed: "profiledSpline",
        },
      };
    }
  },
};
