// Explicit, preview-only cubic Bezier handle refinement.
(function () {
  const MIN_GAIN_S = 0.02;
  const MIN_GAIN_FRACTION = 0.005;
  const MAX_SEGMENTS = 40;
  const MAX_EVALUATIONS = 240;
  const FIELD_W = 17.548;
  const FIELD_H = 8.052;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);

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

  function evaluate(path, robot, perSegment) {
    try {
      const derived = window.PM.derivePath(path, robot, perSegment, 'optimizedTrajectory');
      return validDerived(derived) ? derived : null;
    } catch (_error) {
      return null;
    }
  }

  function refine(path, robot, perSegment) {
    const authored = clone(path);
    if (authored.waypoints.length < 2) return { status: 'unchanged', reason: 'The path needs at least two waypoints.' };
    if (authored.waypoints.length - 1 > MAX_SEGMENTS) {
      return { status: 'unchanged', reason: `Geometry refinement supports at most ${MAX_SEGMENTS} segments per run.` };
    }
    if (authored.waypoints.slice(0, -1).some((waypoint) => (waypoint.segType || 'bezier') !== 'bezier')) {
      return { status: 'unchanged', reason: 'Handle refinement currently supports all-Bezier paths only.' };
    }
    const baseline = evaluate(authored, robot, perSegment);
    if (!baseline) return { status: 'unchanged', reason: 'The authored path must have a valid optimized trajectory and no path-check errors before geometry refinement.' };
    const handles = movableHandles(authored);
    if (handles.length === 0) return { status: 'unchanged', reason: 'The path has no movable Bezier handles.' };

    let bestPath = authored;
    let bestDerived = baseline;
    let evaluations = 0;
    const factors = [0.6, 0.8, 1.2, 1.5];
    for (let pass = 0; pass < 3; pass += 1) {
      let improved = false;
      for (const handle of handles) {
        const waypoint = bestPath.waypoints[handle.waypoint];
        const currentLength = distance(waypoint, waypoint[handle.key]);
        let localPath = bestPath;
        let localDerived = bestDerived;
        for (const factor of factors) {
          if (evaluations >= MAX_EVALUATIONS) break;
          evaluations += 1;
          const candidate = clone(bestPath);
          const length = Math.max(0.05, Math.min(handle.chord * 1.5, currentLength * factor));
          setLength(candidate, handle, length);
          const derived = evaluate(candidate, robot, perSegment);
          if (derived && derived.prof.totalTime < localDerived.prof.totalTime - 1e-6) {
            localPath = candidate;
            localDerived = derived;
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
      return { status: 'unchanged', baselineTimeS, candidateTimeS: baselineTimeS, gainS: 0, reason: 'No material time improvement was found.' };
    }
    return {
      status: 'candidate',
      path: bestPath,
      derived: bestDerived,
      baselineTimeS,
      candidateTimeS,
      gainS,
    };
  }

  window.TrajectoryGeometryOptimizer = { refine };
})();
