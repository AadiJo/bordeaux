import { createRequire } from 'node:module';
import { optimizerCorpus } from './optimizer-corpus.mjs';

const require = createRequire(import.meta.url);
const { getPlanner } = require('../dist-electron/shared/planners/index.js');
const { validateOptimizedTrajectory } = require('../dist-electron/shared/planners/trajectoryValidation.js');

function deterministicValue(result) {
  return JSON.stringify(result, (key, value) => key === 'solveTimeMs' ? 0 : value);
}

const aggregate = {
  schemaVersion: 1,
  cases: 0,
  statuses: {},
  plannerUsed: {},
  comparisons: { faster: 0, equal: 0, slowerEnforcingSafety: 0, unexplainedSlower: 0 },
  profiledTimeS: 0,
  optimizedTimeS: 0,
  deltaTimeS: 0,
  solveTimeMs: { sum: 0, max: 0 },
  constraintViolations: 0,
  baselineConstraintViolations: 0,
  rejectedInputViolations: 0,
  fallbacks: 0,
  unexpectedStatuses: 0,
  deterministicMismatches: 0,
};

for (const corpusCase of optimizerCorpus()) {
  const profiled = getPlanner('profiledSpline').generate(corpusCase.input);
  const optimized = getPlanner('optimizedTrajectory').generate(corpusCase.input);
  const repeated = getPlanner('optimizedTrajectory').generate(corpusCase.input);
  const diagnostics = optimized.optimization || {};
  const status = diagnostics.status || 'missing';
  const plannerUsed = diagnostics.plannerUsed || 'missing';
  const delta = optimized.totalTimeS - profiled.totalTimeS;
  const accepted = status === 'optimal' || status === 'feasible';
  const baselineValidation = accepted
    ? validateOptimizedTrajectory(corpusCase.input, profiled.samples, { angularKinematics: 'sample' })
    : { violations: [] };

  aggregate.cases += 1;
  aggregate.statuses[status] = (aggregate.statuses[status] || 0) + 1;
  aggregate.plannerUsed[plannerUsed] = (aggregate.plannerUsed[plannerUsed] || 0) + 1;
  if (delta < -0.00005) aggregate.comparisons.faster += 1;
  else if (delta > 0.00005 && baselineValidation.violations.length > 0) aggregate.comparisons.slowerEnforcingSafety += 1;
  else if (delta > 0.00005) aggregate.comparisons.unexplainedSlower += 1;
  else aggregate.comparisons.equal += 1;
  aggregate.profiledTimeS += profiled.totalTimeS;
  aggregate.optimizedTimeS += optimized.totalTimeS;
  aggregate.deltaTimeS += delta;
  aggregate.solveTimeMs.sum += diagnostics.solveTimeMs || 0;
  aggregate.solveTimeMs.max = Math.max(aggregate.solveTimeMs.max, diagnostics.solveTimeMs || 0);
  if (accepted) aggregate.constraintViolations += diagnostics.constraintViolations || 0;
  else aggregate.rejectedInputViolations += diagnostics.constraintViolations || 0;
  aggregate.baselineConstraintViolations += baselineValidation.violations.length;
  if (diagnostics.fallback) aggregate.fallbacks += 1;
  if (!corpusCase.expectedStatuses.includes(status)) aggregate.unexpectedStatuses += 1;
  if (deterministicValue(optimized) !== deterministicValue(repeated)) aggregate.deterministicMismatches += 1;
}

aggregate.profiledTimeS = Number(aggregate.profiledTimeS.toFixed(4));
aggregate.optimizedTimeS = Number(aggregate.optimizedTimeS.toFixed(4));
aggregate.deltaTimeS = Number(aggregate.deltaTimeS.toFixed(4));
aggregate.solveTimeMs.sum = Number(aggregate.solveTimeMs.sum.toFixed(3));
aggregate.solveTimeMs.max = Number(aggregate.solveTimeMs.max.toFixed(3));

console.log(JSON.stringify(aggregate));
if (aggregate.unexpectedStatuses > 0 || aggregate.deterministicMismatches > 0
  || aggregate.constraintViolations > 0 || aggregate.comparisons.unexplainedSlower > 0) process.exitCode = 1;
