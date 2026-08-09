import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { optimizerCorpus } from './optimizer-corpus.mjs';

const require = createRequire(import.meta.url);
const { fixedPathSamples, getPlanner, normalizePhysicalPlannerInput } = require('../dist-electron/shared/planners/index.js');
const { validateOptimizedTrajectory } = require('../dist-electron/shared/planners/trajectoryValidation.js');
const { buildDenseValidationSamples } = require('../dist-electron/shared/planners/optimizedTrajectory.js');
const { translationPriorityStartIndex } = require('../dist-electron/shared/planners/rotationPriority.js');
const requestedRuns = Number.parseInt(process.env.BORDEAUX_SHADOW_RUNS ?? '20', 10);
if (!Number.isInteger(requestedRuns) || requestedRuns < 5 || requestedRuns > 200) {
  throw new Error('BORDEAUX_SHADOW_RUNS must be an integer from 5 through 200.');
}

function percentile(values, fraction) {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function deterministicValue(result) {
  return JSON.stringify(result, (key, value) => key === 'solveTimeMs' ? 0 : value);
}

const aggregate = {
  schemaVersion: 2,
  cases: 0,
  statuses: {},
  plannerUsed: {},
  comparisons: { bothValidFaster: 0, bothValidEqual: 0, bothValidSlower: 0, baselineInvalid: 0 },
  profiledTimeS: 0,
  optimizedTimeS: 0,
  deltaTimeS: 0,
  solveTimeMs: { sum: 0, max: 0 },
  constraintViolations: 0,
  baselineConstraintViolations: 0,
  rejectedInputViolations: 0,
  fallbacks: 0,
  unexpectedStatuses: 0,
  unexpectedPlannerUsed: 0,
  deterministicMismatches: 0,
  latencyMs: {
    runsPerCase: requestedRuns,
    commonP50Max: 0,
    commonP95Max: 0,
    stressP50Max: 0,
    stressP95Max: 0,
    max: 0,
  },
  latencyFailures: 0,
};

for (const corpusCase of optimizerCorpus()) {
  const profiled = getPlanner('profiledSpline').generate(corpusCase.input);
  const optimized = getPlanner('optimizedTrajectory').generate(corpusCase.input);
  const repeated = getPlanner('optimizedTrajectory').generate(corpusCase.input);
  const diagnostics = optimized.optimization || {};
  const status = diagnostics.status || 'missing';
  const plannerUsed = diagnostics.plannerUsed || 'missing';
  const delta = optimized.totalTimeS - profiled.totalTimeS;
  const comparisonTolerance = Math.max(0.005, profiled.totalTimeS * 0.005);
  const accepted = status === 'optimal' || status === 'feasible';
  const validationInput = normalizePhysicalPlannerInput(corpusCase.input);
  const baselineSamples = accepted
    ? buildDenseValidationSamples(validationInput, fixedPathSamples(profiled), undefined, 8)
    : [];
  const baselineTranslationStart = accepted
    ? translationPriorityStartIndex(validationInput.path, baselineSamples, baselineSamples.at(-1)?.s ?? 0)
    : null;
  const baselineValidation = accepted
    ? validateOptimizedTrajectory(validationInput, baselineSamples, { skipAngularFromIndex: baselineTranslationStart ?? undefined })
    : { violations: [] };
  for (let run = 0; run < 3; run += 1) getPlanner('optimizedTrajectory').generate(corpusCase.input);
  const durations = [];
  for (let run = 0; run < requestedRuns; run += 1) {
    const started = performance.now();
    getPlanner('optimizedTrajectory').generate(corpusCase.input);
    durations.push(performance.now() - started);
  }
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const latencyKind = corpusCase.stress ? 'stress' : 'common';
  aggregate.latencyMs[`${latencyKind}P50Max`] = Math.max(aggregate.latencyMs[`${latencyKind}P50Max`], p50);
  aggregate.latencyMs[`${latencyKind}P95Max`] = Math.max(aggregate.latencyMs[`${latencyKind}P95Max`], p95);
  aggregate.latencyMs.max = Math.max(aggregate.latencyMs.max, ...durations);
  if (p95 > (corpusCase.stress ? 100 : 30)) aggregate.latencyFailures += 1;

  aggregate.cases += 1;
  aggregate.statuses[status] = (aggregate.statuses[status] || 0) + 1;
  aggregate.plannerUsed[plannerUsed] = (aggregate.plannerUsed[plannerUsed] || 0) + 1;
  if (baselineValidation.violations.length > 0) aggregate.comparisons.baselineInvalid += 1;
  else if (delta < -comparisonTolerance) aggregate.comparisons.bothValidFaster += 1;
  else if (delta > comparisonTolerance) aggregate.comparisons.bothValidSlower += 1;
  else aggregate.comparisons.bothValidEqual += 1;
  aggregate.profiledTimeS += profiled.totalTimeS;
  aggregate.optimizedTimeS += optimized.totalTimeS;
  aggregate.deltaTimeS += delta;
  aggregate.solveTimeMs.sum += diagnostics.solveTimeMs || 0;
  aggregate.solveTimeMs.max = Math.max(aggregate.solveTimeMs.max, diagnostics.solveTimeMs || 0);
  if (accepted) aggregate.constraintViolations += diagnostics.constraintViolations || 0;
  else aggregate.rejectedInputViolations += diagnostics.constraintViolations || 0;
  aggregate.baselineConstraintViolations += baselineValidation.violations.length;
  if (diagnostics.fallback) aggregate.fallbacks += 1;
  if (accepted && plannerUsed !== 'optimizedTrajectory') aggregate.unexpectedPlannerUsed += 1;
  if (!corpusCase.expectedStatuses.includes(status)) aggregate.unexpectedStatuses += 1;
  if (deterministicValue(optimized) !== deterministicValue(repeated)) aggregate.deterministicMismatches += 1;
}

aggregate.profiledTimeS = Number(aggregate.profiledTimeS.toFixed(4));
aggregate.optimizedTimeS = Number(aggregate.optimizedTimeS.toFixed(4));
aggregate.deltaTimeS = Number(aggregate.deltaTimeS.toFixed(4));
aggregate.solveTimeMs.sum = Number(aggregate.solveTimeMs.sum.toFixed(3));
aggregate.solveTimeMs.max = Number(aggregate.solveTimeMs.max.toFixed(3));
for (const key of ['commonP50Max', 'commonP95Max', 'stressP50Max', 'stressP95Max', 'max']) {
  aggregate.latencyMs[key] = Number(aggregate.latencyMs[key].toFixed(3));
}

console.log(JSON.stringify(aggregate));
if (aggregate.unexpectedStatuses > 0 || aggregate.deterministicMismatches > 0
  || aggregate.constraintViolations > 0 || aggregate.comparisons.bothValidSlower > 0
  || aggregate.latencyFailures > 0 || aggregate.fallbacks > 0 || aggregate.unexpectedPlannerUsed > 0) process.exitCode = 1;
