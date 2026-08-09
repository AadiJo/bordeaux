import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { optimizerCorpus } from "./optimizer-corpus.mjs";

const require = createRequire(import.meta.url);
const { optimizedTrajectoryPlanner } = require("../dist-electron/shared/planners/optimizedTrajectory.js");
const { profiledSplinePlanner } = require("../dist-electron/shared/planners/profiledSpline.js");

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
  const profiled = benchmark(profiledSplinePlanner, input);
  const optimized = benchmark(optimizedTrajectoryPlanner, input);
  const profiledTime = profiled.result.totalTimeS;
  const optimizedTime = optimized.result.totalTimeS;
  return {
    case: name,
    samples: optimized.result.samples.length,
    status: optimized.result.optimization?.status ?? "missing",
    violations: optimized.result.optimization?.constraintViolations ?? -1,
    refinementPasses: optimized.result.optimization?.refinementPasses ?? -1,
    validatedPoints: optimized.result.optimization?.validatedPoints ?? -1,
    profiledTimeS: profiledTime.toFixed(4),
    optimizedTimeS: optimizedTime.toFixed(4),
    timeDeltaPct: `${(((optimizedTime / profiledTime) - 1) * 100).toFixed(1)}%`,
    optimizedP50Ms: optimized.p50Ms.toFixed(3),
    optimizedP95Ms: optimized.p95Ms.toFixed(3),
  };
});

console.table(rows);
if (rows.some((row) => !["optimal", "feasible"].includes(row.status) || row.violations !== 0)) process.exitCode = 1;
