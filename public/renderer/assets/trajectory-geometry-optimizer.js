// Explicit, preview-only cubic Bezier handle refinement.
(function () {
  const MIN_GAIN_S = 0.02;
  const MIN_GAIN_FRACTION = 0.005;
  const MAX_SEGMENTS = 40;
  const MAX_EVALUATIONS = 72;
  const FIELD_W = 17.548;
  const FIELD_H = 8.052;
  const DEFAULT_CORRIDOR_M = 0.05;
  const MIN_CORRIDOR_M = 0.03;
  const MAX_CORRIDOR_M = 1.5;
  const DEFAULT_CLEARANCE_M = 0.05;
  const MIN_CLEARANCE_M = 0;
  const MAX_CLEARANCE_M = 0.5;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);

  function pointSegmentDistance(point, start, end) {
    const dx = end.x - start.x, dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 1e-12) return distance(point, start);
    const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (start.x + dx * projection), point.y - (start.y + dy * projection));
  }

  function pointsBySegment(points) {
    const result = new Map();
    points.forEach((point) => {
      if (!result.has(point.seg)) result.set(point.seg, []);
      result.get(point.seg).push(point);
    });
    return result;
  }

  function directedDeviation(points, referenceBySegment) {
    let maximum = 0;
    for (const point of points) {
      const reference = referenceBySegment.get(point.seg);
      if (!reference || reference.length < 2) return Infinity;
      let nearest = Infinity;
      for (let index = 1; index < reference.length; index += 1) {
        nearest = Math.min(nearest, pointSegmentDistance(point, reference[index - 1], reference[index]));
      }
      maximum = Math.max(maximum, nearest);
    }
    return maximum;
  }

  function routeDeviation(referencePoints, candidatePoints) {
    return Math.max(
      directedDeviation(candidatePoints, pointsBySegment(referencePoints)),
      directedDeviation(referencePoints, pointsBySegment(candidatePoints)),
    );
  }

  function movableHandles(path) {
    const handles = [];
    path.waypoints.slice(0, -1).forEach((waypoint, segment) => {
      const next = path.waypoints[segment + 1];
      if ((waypoint.segType || 'bezier') !== 'bezier') return;
      if (waypoint.nextC && distance(waypoint, waypoint.nextC) > 1e-6) {
        handles.push({ waypoint: segment, key: 'nextC', chord: distance(waypoint, next) });
      }
      if (next.prevC && distance(next, next.prevC) > 1e-6) {
        handles.push({ waypoint: segment + 1, key: 'prevC', chord: distance(waypoint, next) });
      }
    });
    return handles;
  }

  function setLength(path, handle, length) {
    const waypoint = path.waypoints[handle.waypoint];
    const point = waypoint[handle.key];
    const current = distance(waypoint, point);
    if (current <= 1e-9) return;
    waypoint[handle.key] = {
      x: waypoint.x + (point.x - waypoint.x) / current * length,
      y: waypoint.y + (point.y - waypoint.y) / current * length,
    };
  }

  function validDerived(derived) {
    return derived && derived.optimization && derived.optimization.status === 'optimal'
      && !derived.optimization.fallback
      && !(derived.checks || []).some((check) => check.level === 'error')
      && derived.sample && derived.sample.pts.length > 1
      && derived.sample.pts.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)
        && point.x >= 0 && point.x <= FIELD_W && point.y >= 0 && point.y <= FIELD_H);
  }

  function evaluate(path, robot, perSegment, referenceRoute, corridorM, requiredClearance) {
    try {
      let maxDeviationM = 0;
      if (referenceRoute) {
        const candidateRoute = window.PM.sample(path.waypoints, Math.max(48, perSegment * 2)).pts;
        maxDeviationM = routeDeviation(referenceRoute, candidateRoute);
        if (!Number.isFinite(maxDeviationM) || maxDeviationM > corridorM + 1e-6) return null;
      }
      const derived = window.PM.derivePath(path, robot, perSegment, 'optimizedTrajectory');
      if (!validDerived(derived)) return null;
      const clearance = window.TrajectoryClearance.clearanceReport(path, robot, derived);
      if (requiredClearance
        && (!clearance.heightValid
          || clearance.official < requiredClearance.official - 1e-6
          || clearance.keepOut < requiredClearance.keepOut - 1e-6)) return null;
      return { derived, maxDeviationM, clearance };
    } catch (_error) {
      return null;
    }
  }

  function refine(path, robot, perSegment, options) {
    const authored = clone(path);
    const requestedCorridor = Number(options && options.corridorM);
    const corridorM = Number.isFinite(requestedCorridor)
      ? Math.max(MIN_CORRIDOR_M, Math.min(MAX_CORRIDOR_M, requestedCorridor))
      : DEFAULT_CORRIDOR_M;
    const requestedClearance = Number(options && options.clearanceM);
    const clearanceM = Number.isFinite(requestedClearance)
      ? Math.max(MIN_CLEARANCE_M, Math.min(MAX_CLEARANCE_M, requestedClearance))
      : DEFAULT_CLEARANCE_M;
    if (authored.waypoints.length < 2) return { status: 'unchanged', reason: 'The path needs at least two waypoints.' };
    if (authored.waypoints.length - 1 > MAX_SEGMENTS) {
      return { status: 'unchanged', reason: `Geometry refinement supports at most ${MAX_SEGMENTS} segments per run.` };
    }
    if (authored.waypoints.slice(0, -1).some((waypoint) => (waypoint.segType || 'bezier') !== 'bezier')) {
      return { status: 'unchanged', reason: 'Handle refinement currently supports all-Bezier paths only.' };
    }
    const baselineResult = evaluate(authored, robot, perSegment);
    if (!baselineResult) return { status: 'unchanged', corridorM, clearanceM, reason: 'The authored path must have a valid optimized trajectory and no path-check errors before geometry refinement.' };
    const baseline = baselineResult.derived;
    const baselineClearance = window.TrajectoryClearance.clearanceReport(authored, robot, baseline);
    if (!baselineClearance.heightValid) {
      return { status: 'unchanged', corridorM, clearanceM, reason: 'The authored robot is too tall for a TRENCH crossing on this path.' };
    }
    if (baselineClearance.official < -1e-6) {
      return { status: 'unchanged', corridorM, clearanceM, reason: 'The authored robot footprint intersects an official field obstacle. Fix that collision before refining geometry.' };
    }
    const hasKeepOuts = Array.isArray(authored.keepOuts) && authored.keepOuts.length > 0;
    const requiredClearance = {
      official: clearanceM,
      keepOut: hasKeepOuts ? clearanceM : -Infinity,
    };
    const referenceRoute = window.PM.sample(authored.waypoints, Math.max(48, perSegment * 2)).pts;
    const handles = movableHandles(authored);
    if (handles.length === 0) return { status: 'unchanged', reason: 'The path has no movable Bezier handles.' };

    const baselineAllowed = baselineClearance.official >= requiredClearance.official - 1e-6
      && baselineClearance.keepOut >= requiredClearance.keepOut - 1e-6;
    let bestPath = baselineAllowed ? authored : null;
    let bestDerived = baselineAllowed ? baseline : null;
    let bestDeviationM = 0;
    let bestClearance = baselineAllowed ? baselineClearance : null;
    let evaluations = 0;
    const seedPatterns = [
      () => 1,
      () => 0.82,
      () => 1.18,
      (index) => index % 2 ? 0.82 : 1.18,
      (index) => index % 2 ? 1.18 : 0.82,
    ];
    const starts = [];
    seedPatterns.forEach((scaleAt, seedIndex) => {
      if (evaluations >= MAX_EVALUATIONS) return;
      const seed = clone(authored);
      handles.forEach((handle, index) => {
        const waypoint = authored.waypoints[handle.waypoint];
        const authoredLength = distance(waypoint, waypoint[handle.key]);
        setLength(seed, handle, Math.max(0.05, Math.min(handle.chord * 1.5, authoredLength * scaleAt(index))));
      });
      evaluations += 1;
      const evaluation = seedIndex === 0 && baselineAllowed
        ? { derived: baseline, maxDeviationM: 0, clearance: baselineClearance }
        : evaluate(seed, robot, perSegment, referenceRoute, corridorM, requiredClearance);
      if (!evaluation) return;
      starts.push({ path: seed, ...evaluation });
      if (!bestDerived || evaluation.derived.prof.totalTime < bestDerived.prof.totalTime - 1e-6) {
        bestPath = seed; bestDerived = evaluation.derived;
        bestDeviationM = evaluation.maxDeviationM; bestClearance = evaluation.clearance;
      }
    });

    const budgetPerStart = starts.length
      ? Math.max(1, Math.floor((MAX_EVALUATIONS - evaluations) / starts.length)) : 0;
    starts.forEach((start) => {
      let localPath = start.path, localDerived = start.derived;
      let localDeviation = start.maxDeviationM, localClearance = start.clearance;
      const stopAt = Math.min(MAX_EVALUATIONS, evaluations + budgetPerStart);
      for (let pass = 0; pass < 3 && evaluations < stopAt; pass += 1) {
        let improved = false;
        for (const handle of handles) {
          const waypoint = localPath.waypoints[handle.waypoint];
          const currentLength = distance(waypoint, waypoint[handle.key]);
          const relativeStep = Math.max(0.015, Math.min(0.4, corridorM / Math.max(0.05, currentLength)));
          const factors = [1 - relativeStep, 1 - relativeStep * 0.5, 1 + relativeStep * 0.5, 1 + relativeStep];
          let handlePath = localPath, handleDerived = localDerived;
          let handleDeviation = localDeviation, handleClearance = localClearance;
          for (const factor of factors) {
            if (evaluations >= stopAt) break;
            evaluations += 1;
            const candidate = clone(localPath);
            setLength(candidate, handle, Math.max(0.05, Math.min(handle.chord * 1.5, currentLength * factor)));
            const evaluation = evaluate(candidate, robot, perSegment, referenceRoute, corridorM, requiredClearance);
            if (evaluation && evaluation.derived.prof.totalTime < handleDerived.prof.totalTime - 1e-6) {
              handlePath = candidate; handleDerived = evaluation.derived;
              handleDeviation = evaluation.maxDeviationM; handleClearance = evaluation.clearance;
            }
          }
          if (handlePath !== localPath) {
            localPath = handlePath; localDerived = handleDerived;
            localDeviation = handleDeviation; localClearance = handleClearance;
            improved = true;
          }
        }
        if (!improved) break;
      }
      if (!bestDerived || localDerived.prof.totalTime < bestDerived.prof.totalTime - 1e-6) {
        bestPath = localPath; bestDerived = localDerived;
        bestDeviationM = localDeviation; bestClearance = localClearance;
      }
    });

    if (!bestPath || !bestDerived || !bestClearance) {
      return {
        status: 'unchanged', corridorM, clearanceM, baselineTimeS: baseline.prof.totalTime,
        candidateTimeS: baseline.prof.totalTime, gainS: 0,
        reason: 'No collision-free path was found inside the route corridor and keep-out regions.',
      };
    }

    const baselineTimeS = baseline.prof.totalTime;
    const candidateTimeS = bestDerived.prof.totalTime;
    const gainS = baselineTimeS - candidateTimeS;
    const requiredGainS = Math.max(MIN_GAIN_S, baselineTimeS * MIN_GAIN_FRACTION);
    if (gainS < requiredGainS) {
      return {
        status: 'unchanged', corridorM, clearanceM, baselineTimeS, candidateTimeS: baselineTimeS, gainS: 0,
        reason: `No material time improvement was found within the ${corridorM.toFixed(2)} m route corridor.`,
      };
    }
    return {
      status: 'candidate',
      path: bestPath,
      derived: bestDerived,
      corridorM,
      clearanceM,
      maxDeviationM: bestDeviationM,
      minimumClearanceM: bestClearance.minimum,
      checkedPoses: bestClearance.checkedPoses,
      baselineTimeS,
      candidateTimeS,
      gainS,
    };
  }

  window.TrajectoryGeometryOptimizer = { refine };
})();
