import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { buildWaypoints, createDemoProject } = require("../dist-electron/shared/project/defaults.js");
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

function demoCase() {
  const project = createDemoProject();
  return { name: "demo", input: { path: project.paths[0], robot: project.robot } };
}

function curvedCase() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.headingMode = "tangent";
  path.waypoints = buildWaypoints([
    { x: 0.8, y: 1.0, nextC: { x: 2.2, y: 0.8 } },
    { x: 4.0, y: 4.9, prevC: { x: 2.8, y: 4.8 }, nextC: { x: 5.2, y: 5.0 } },
    { x: 8.0, y: 2.0, prevC: { x: 6.8, y: 2.1 }, nextC: { x: 10.0, y: 1.8 } },
    { x: 14.5, y: 6.8, prevC: { x: 12.5, y: 6.7 } },
  ]);
  return { name: "curved", input: { path, robot: project.robot } };
}

function constrainedStopCase() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.headingMode = "tangent";
  path.waypoints = buildWaypoints([
    { x: 1, y: 1, nextC: { x: 2, y: 1 } },
    { x: 5, y: 1, prevC: { x: 4, y: 1 }, nextC: { x: 7, y: 1 }, stop: true },
    { x: 11, y: 1, prevC: { x: 9, y: 1 } },
  ]);
  path.ranges = [{
    anchor: "param",
    f0: 0.2,
    f1: 0.8,
    maxVel: 1.5,
    maxAccel: 1,
    maxDecel: 1,
    maxAngVel: 360,
    maxAngAccel: 720,
  }];
  return { name: "range-stop", input: { path, robot: project.robot } };
}

const rows = [demoCase(), curvedCase(), constrainedStopCase()].map(({ name, input }) => {
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
