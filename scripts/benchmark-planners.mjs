import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { optimizerCorpus } from "./optimizer-corpus.mjs";

const require = createRequire(import.meta.url);
const { fixedPathSamples, getPlanner, normalizePhysicalPlannerInput } = require("../dist-electron/shared/planners/index.js");
const { validateOptimizedTrajectory } = require("../dist-electron/shared/planners/trajectoryValidation.js");
const { buildDenseValidationSamples } = require("../dist-electron/shared/planners/optimizedTrajectory.js");
const { translationPriorityStartIndex } = require("../dist-electron/shared/planners/rotationPriority.js");

const requestedRuns = Number.parseInt(process.env.BORDEAUX_BENCH_RUNS ?? "50", 10);
if (!Number.isInteger(requestedRuns) || requestedRuns < 5 || requestedRuns > 1_000) {
  throw new Error("BORDEAUX_BENCH_RUNS must be an integer from 5 through 1000.");
}

function percentile(values, fraction) {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function benchmark(planner, input) {
  for (let run = 0; run < 5; run += 1) planner.generate(input);
  const durations = [];
  let result;
  for (let run = 0; run < requestedRuns; run += 1) {
    const started = performance.now();
    result = planner.generate(input);
    durations.push(performance.now() - started);
  }
  return {
    result,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
  };
}

const rows = optimizerCorpus().filter((entry) => entry.benchmark !== false).map(({ name, input }) => {
  const profiled = benchmark(getPlanner("profiledSpline"), input);
  const optimized = benchmark(getPlanner("optimizedTrajectory"), input);
  const profiledTime = profiled.result.totalTimeS;
  const optimizedTime = optimized.result.totalTimeS;
  const materialSlowdown = optimizedTime - profiledTime > Math.max(0.005, profiledTime * 0.005);
  const validationInput = normalizePhysicalPlannerInput(input);
  const baselineSamples = buildDenseValidationSamples(validationInput, fixedPathSamples(profiled.result), undefined, 8);
  const baselineTranslationStart = translationPriorityStartIndex(
    validationInput.path,
    baselineSamples,
    baselineSamples.at(-1)?.s ?? 0,
  );
  const baselineValidation = validateOptimizedTrajectory(validationInput, baselineSamples, {
    skipAngularFromIndex: baselineTranslationStart ?? undefined,
  });
  return {
    case: name,
    samples: optimized.result.samples.length,
    status: optimized.result.optimization?.status ?? "missing",
    violations: optimized.result.optimization?.constraintViolations ?? -1,
    refinementPasses: optimized.result.optimization?.refinementPasses ?? -1,
    validatedPoints: optimized.result.optimization?.validatedPoints ?? -1,
    baselineValid: baselineValidation.violations.length === 0,
    materialSlowdown,
    profiledTimeS: profiledTime.toFixed(4),
    optimizedTimeS: optimizedTime.toFixed(4),
    timeDeltaPct: `${(((optimizedTime / profiledTime) - 1) * 100).toFixed(1)}%`,
    optimizedP50Ms: optimized.p50Ms.toFixed(3),
    optimizedP95Ms: optimized.p95Ms.toFixed(3),
  };
});

console.table(rows);
if (rows.some((row) => !["optimal", "feasible"].includes(row.status)
  || row.violations !== 0
  || (row.baselineValid && row.materialSlowdown))) process.exitCode = 1;
