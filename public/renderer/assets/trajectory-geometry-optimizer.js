// Explicit, preview-only cubic Bezier handle refinement.
(function () {
  const MIN_GAIN_S = 0.02;
  const MIN_GAIN_FRACTION = 0.005;
  const MAX_SEGMENTS = 40;
  const MAX_EVALUATIONS = 240;
  const FIELD_W = 17.548;
  const FIELD_H = 8.052;
  const DEFAULT_CORRIDOR_M = 0.05;
  const MIN_CORRIDOR_M = 0.03;
  const MAX_CORRIDOR_M = 1.5;

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

  function evaluate(path, robot, perSegment, referenceRoute, corridorM) {
    try {
      let maxDeviationM = 0;
      if (referenceRoute) {
        const candidateRoute = window.PM.sample(path.waypoints, Math.max(48, perSegment * 2)).pts;
        maxDeviationM = routeDeviation(referenceRoute, candidateRoute);
        if (!Number.isFinite(maxDeviationM) || maxDeviationM > corridorM + 1e-6) return null;
      }
      const derived = window.PM.derivePath(path, robot, perSegment, 'optimizedTrajectory');
      return validDerived(derived) ? { derived, maxDeviationM } : null;
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
    if (authored.waypoints.length < 2) return { status: 'unchanged', reason: 'The path needs at least two waypoints.' };
    if (authored.waypoints.length - 1 > MAX_SEGMENTS) {
      return { status: 'unchanged', reason: `Geometry refinement supports at most ${MAX_SEGMENTS} segments per run.` };
    }
    if (authored.waypoints.slice(0, -1).some((waypoint) => (waypoint.segType || 'bezier') !== 'bezier')) {
      return { status: 'unchanged', reason: 'Handle refinement currently supports all-Bezier paths only.' };
    }
    const baselineResult = evaluate(authored, robot, perSegment);
    if (!baselineResult) return { status: 'unchanged', corridorM, reason: 'The authored path must have a valid optimized trajectory and no path-check errors before geometry refinement.' };
    const baseline = baselineResult.derived;
    const referenceRoute = window.PM.sample(authored.waypoints, Math.max(48, perSegment * 2)).pts;
    const handles = movableHandles(authored);
    if (handles.length === 0) return { status: 'unchanged', reason: 'The path has no movable Bezier handles.' };

    let bestPath = authored;
    let bestDerived = baseline;
    let bestDeviationM = 0;
    let evaluations = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      let improved = false;
      for (const handle of handles) {
        const waypoint = bestPath.waypoints[handle.waypoint];
        const currentLength = distance(waypoint, waypoint[handle.key]);
        const relativeStep = Math.max(0.015, Math.min(0.4, corridorM / Math.max(0.05, currentLength)));
        const factors = [1 - relativeStep, 1 - relativeStep * 0.5, 1 + relativeStep * 0.5, 1 + relativeStep];
        let localPath = bestPath;
        let localDerived = bestDerived;
        for (const factor of factors) {
          if (evaluations >= MAX_EVALUATIONS) break;
          evaluations += 1;
          const candidate = clone(bestPath);
          const length = Math.max(0.05, Math.min(handle.chord * 1.5, currentLength * factor));
          setLength(candidate, handle, length);
          const evaluation = evaluate(candidate, robot, perSegment, referenceRoute, corridorM);
          const derived = evaluation && evaluation.derived;
          if (derived && derived.prof.totalTime < localDerived.prof.totalTime - 1e-6) {
            localPath = candidate;
            localDerived = derived;
            bestDeviationM = evaluation.maxDeviationM;
          }
        }
        if (localPath !== bestPath) {
          bestPath = localPath;
          bestDerived = localDerived;
          improved = true;
        }
      }
      if (!improved || evaluations >= MAX_EVALUATIONS) break;
    }

    const baselineTimeS = baseline.prof.totalTime;
    const candidateTimeS = bestDerived.prof.totalTime;
    const gainS = baselineTimeS - candidateTimeS;
    const requiredGainS = Math.max(MIN_GAIN_S, baselineTimeS * MIN_GAIN_FRACTION);
    if (gainS < requiredGainS) {
      return {
        status: 'unchanged', corridorM, baselineTimeS, candidateTimeS: baselineTimeS, gainS: 0,
        reason: `No material time improvement was found within the ${corridorM.toFixed(2)} m route corridor.`,
      };
    }
    return {
      status: 'candidate',
      path: bestPath,
      derived: bestDerived,
      corridorM,
      maxDeviationM: bestDeviationM,
      baselineTimeS,
      candidateTimeS,
      gainS,
    };
  }

  window.TrajectoryGeometryOptimizer = { refine };
})();
