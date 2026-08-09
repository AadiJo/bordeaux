// Local-only developer shadow metrics. No path or project data is retained.
(function () {
  const ENABLED_KEY = 'bordeaux.dev.optimizerShadow.enabled';
  const METRICS_KEY = 'bordeaux.dev.optimizerShadow.metrics.v2';
  const LEGACY_METRICS_KEY = 'bordeaux.dev.optimizerShadow.metrics.v1';
  const MAX_RECORDS = 1000000;
  const STATUSES = ['optimal', 'feasible', 'invalid-input', 'infeasible', 'cancelled', 'internal-error', 'worker-error', 'missing'];
  const MODES = ['profiled-shadow', 'optimized-opt-in'];
  const SOLVE_BUCKETS_MS = [1, 2, 5, 10, 20, 30, 50, 100, 250, 1000];
  const SOLVE_BUCKET_KEYS = SOLVE_BUCKETS_MS.map(String).concat('overflow');

  function empty() {
    return {
      schemaVersion: 2,
      records: 0,
      timedRecords: 0,
      modes: { 'profiled-shadow': 0, 'optimized-opt-in': 0 },
      statuses: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      plannerUsed: { profiledSpline: 0, optimizedTrajectory: 0, missing: 0 },
      comparisons: { faster: 0, equal: 0, slower: 0 },
      solveTimeMs: { sum: 0, max: 0, histogram: Object.fromEntries(SOLVE_BUCKET_KEYS.map((key) => [key, 0])) },
      profiledTimeS: { sum: 0 },
      optimizedTimeS: { sum: 0 },
      deltaTimeS: { sum: 0, min: 0, max: 0 },
      constraintViolations: 0,
      fallbacks: 0,
      workerErrors: 0,
    };
  }

  function storage() {
    try { return window.localStorage || null; }
    catch (_) { return null; }
  }

  function enabled() {
    const target = storage();
    if (!target) return false;
    try { return target.getItem(ENABLED_KEY) === '1'; }
    catch (_) { return false; }
  }

  function setEnabled(value) {
    const target = storage();
    if (!target) return false;
    try {
      if (value) target.setItem(ENABLED_KEY, '1'); else target.removeItem(ENABLED_KEY);
      return enabled();
    } catch (_) { return false; }
  }

  function read() {
    const target = storage();
    if (!target) return empty();
    try {
      const parsed = JSON.parse(target.getItem(METRICS_KEY) || 'null');
      if (!parsed || parsed.schemaVersion !== 2 || !Number.isInteger(parsed.records) || parsed.records < 0 || parsed.records > MAX_RECORDS) return empty();
      const base = empty();
      const count = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_RECORDS ? value : 0;
      const number = (value) => Number.isFinite(value) ? value : 0;
      return {
        ...base,
        records: parsed.records,
        timedRecords: Math.min(parsed.records, count(parsed.timedRecords)),
        modes: Object.fromEntries(MODES.map((mode) => [mode, count(parsed.modes && parsed.modes[mode])])),
        statuses: Object.fromEntries(STATUSES.map((status) => [status, count(parsed.statuses && parsed.statuses[status])])),
        plannerUsed: Object.fromEntries(Object.keys(base.plannerUsed).map((planner) => [planner, count(parsed.plannerUsed && parsed.plannerUsed[planner])])),
        comparisons: Object.fromEntries(Object.keys(base.comparisons).map((key) => [key, count(parsed.comparisons && parsed.comparisons[key])])),
        solveTimeMs: {
          sum: number(parsed.solveTimeMs && parsed.solveTimeMs.sum),
          max: number(parsed.solveTimeMs && parsed.solveTimeMs.max),
          histogram: Object.fromEntries(SOLVE_BUCKET_KEYS.map((key) => [key, count(parsed.solveTimeMs && parsed.solveTimeMs.histogram && parsed.solveTimeMs.histogram[key])])),
        },
        profiledTimeS: { sum: number(parsed.profiledTimeS && parsed.profiledTimeS.sum) },
        optimizedTimeS: { sum: number(parsed.optimizedTimeS && parsed.optimizedTimeS.sum) },
        deltaTimeS: {
          sum: number(parsed.deltaTimeS && parsed.deltaTimeS.sum),
          min: number(parsed.deltaTimeS && parsed.deltaTimeS.min),
          max: number(parsed.deltaTimeS && parsed.deltaTimeS.max),
        },
        constraintViolations: count(parsed.constraintViolations),
        fallbacks: count(parsed.fallbacks),
        workerErrors: count(parsed.workerErrors),
      };
    } catch (_) { return empty(); }
  }

  function write(metrics) {
    const target = storage();
    if (!target) return false;
    try { target.setItem(METRICS_KEY, JSON.stringify(metrics)); return true; }
    catch (_) { return false; }
  }

  function finite(value, maximum) {
    return Number.isFinite(value) ? Math.max(-maximum, Math.min(maximum, value)) : 0;
  }

  function record(input) {
    if (!enabled()) return false;
    const metrics = read();
    if (metrics.records >= MAX_RECORDS) return false;
    const mode = MODES.includes(input && input.mode) ? input.mode : 'profiled-shadow';
    const optimized = input && input.optimized;
    const profiled = input && input.profiled;
    const diagnostics = optimized && optimized.optimization;
    const status = STATUSES.includes(diagnostics && diagnostics.status) ? diagnostics.status : 'missing';
    const plannerUsed = diagnostics && ['profiledSpline', 'optimizedTrajectory'].includes(diagnostics.plannerUsed)
      ? diagnostics.plannerUsed
      : 'missing';
    const profiledTime = finite(profiled && profiled.prof && profiled.prof.totalTime, 1000000);
    const optimizedTime = finite(optimized && optimized.prof && optimized.prof.totalTime, 1000000);
    const delta = optimizedTime - profiledTime;

    metrics.records += 1;
    metrics.timedRecords += 1;
    metrics.modes[mode] += 1;
    metrics.statuses[status] += 1;
    metrics.plannerUsed[plannerUsed] += 1;
    if (delta < -0.00005) metrics.comparisons.faster += 1;
    else if (delta > 0.00005) metrics.comparisons.slower += 1;
    else metrics.comparisons.equal += 1;
    const solveTime = finite(diagnostics && diagnostics.solveTimeMs, 1000000);
    metrics.solveTimeMs.sum += solveTime;
    metrics.solveTimeMs.max = Math.max(metrics.solveTimeMs.max, solveTime);
    const solveBucket = SOLVE_BUCKETS_MS.find((upperBound) => solveTime <= upperBound) || 'overflow';
    metrics.solveTimeMs.histogram[String(solveBucket)] += 1;
    metrics.profiledTimeS.sum += profiledTime;
    metrics.optimizedTimeS.sum += optimizedTime;
    metrics.deltaTimeS.sum += delta;
    metrics.deltaTimeS.min = metrics.timedRecords === 1 ? delta : Math.min(metrics.deltaTimeS.min, delta);
    metrics.deltaTimeS.max = metrics.timedRecords === 1 ? delta : Math.max(metrics.deltaTimeS.max, delta);
    metrics.constraintViolations += Math.max(0, Math.floor(finite(diagnostics && diagnostics.constraintViolations, 1000000)));
    if (diagnostics && diagnostics.fallback) metrics.fallbacks += 1;
    return write(metrics);
  }

  function recordWorkerError(mode) {
    if (!enabled()) return false;
    const metrics = read();
    if (metrics.records >= MAX_RECORDS) return false;
    const safeMode = MODES.includes(mode) ? mode : 'profiled-shadow';
    metrics.records += 1;
    metrics.modes[safeMode] += 1;
    metrics.statuses['worker-error'] += 1;
    metrics.plannerUsed.missing += 1;
    metrics.workerErrors += 1;
    return write(metrics);
  }

  function snapshot() {
    const metrics = read();
    const divisor = Math.max(1, metrics.timedRecords);
    const percentileUpperBound = (fraction) => {
      const target = Math.max(1, Math.ceil(divisor * fraction));
      let count = 0;
      for (const key of SOLVE_BUCKET_KEYS) {
        count += metrics.solveTimeMs.histogram[key];
        if (count >= target) return key === 'overflow' ? null : Number(key);
      }
      return null;
    };
    return {
      ...metrics,
      averages: {
        solveTimeMs: metrics.solveTimeMs.sum / divisor,
        profiledTimeS: metrics.profiledTimeS.sum / divisor,
        optimizedTimeS: metrics.optimizedTimeS.sum / divisor,
        deltaTimeS: metrics.deltaTimeS.sum / divisor,
      },
      percentiles: {
        solveTimeP50UpperBoundMs: percentileUpperBound(0.5),
        solveTimeP95UpperBoundMs: percentileUpperBound(0.95),
      },
    };
  }

  function clear() {
    const target = storage();
    if (!target) return false;
    try { target.removeItem(METRICS_KEY); target.removeItem(LEGACY_METRICS_KEY); return true; }
    catch (_) { return false; }
  }

  function policy(plannerId) {
    const publish = plannerId === 'optimizedTrajectory';
    const recordEnabled = enabled();
    return Object.freeze({
      run: publish || recordEnabled,
      publish,
      record: recordEnabled,
      mode: publish ? 'optimized-opt-in' : 'profiled-shadow',
    });
  }

  window.BordeauxOptimizerShadow = Object.freeze({ enabled, setEnabled, policy, record, recordWorkerError, snapshot, clear });
})();
