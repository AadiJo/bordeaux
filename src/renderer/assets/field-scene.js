  function lowerBoundByDistance(points, distance) {
    let low = 0, high = points.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((points[middle].s || 0) < distance) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function pointAtDistance(points, distance) {
    const afterIndex = Math.min(points.length - 1, lowerBoundByDistance(points, distance));
    const after = points[afterIndex];
    const before = points[Math.max(0, afterIndex - 1)];
    const span = (after.s || 0) - (before.s || 0);
    if (span <= 1e-9) return { ...after, s: distance };
    const t = Math.max(0, Math.min(1, (distance - (before.s || 0)) / span));
    return { ...after, x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t, s: distance };
  }

  /** Finds the sampled point span for a path-fraction interval in logarithmic time. */
  function fractionRange(points, totalDistance, first, last) {
    if (!points.length) return { start: 0, end: -1 };
    const lowFraction = Math.max(0, Math.min(1, Math.min(first, last)));
    const highFraction = Math.max(0, Math.min(1, Math.max(first, last)));
    const total = totalDistance || points[points.length - 1].s || 0;
    const start = Math.max(0, lowerBoundByDistance(points, lowFraction * total) - 1);
    const end = Math.min(points.length - 1, lowerBoundByDistance(points, highFraction * total));
    return {
      start,
      end: Math.max(start, end),
      first: pointAtDistance(points, lowFraction * total),
      last: pointAtDistance(points, highFraction * total),
    };
  }

  function segmentRange(derived, segment) {
    const points = derived.sample.pts;
    if (derived.wpIdx && Number.isInteger(derived.wpIdx[segment]) && Number.isInteger(derived.wpIdx[segment + 1])) {
      return {
        start: Math.max(0, derived.wpIdx[segment]),
        end: Math.min(points.length - 1, derived.wpIdx[segment + 1]),
      };
    }
    const fractions = derived.wpFrac || [];
    return fractionRange(points, derived.sample.length, fractions[segment] || 0, fractions[segment + 1] || 0);
  }

  /** Builds one SVG path without rescanning points outside the requested span. */
  function pathData(points, range, project, precision) {
    const start = Math.max(0, range ? range.start : 0);
    const end = Math.min(points.length - 1, range ? range.end : points.length - 1);
    if (end < start) return '';
    const parts = [];
    const append = (point) => {
      if (!point) return;
      const projected = project(point);
      const x = Number.isInteger(precision) ? projected.x.toFixed(precision) : projected.x;
      const y = Number.isInteger(precision) ? projected.y.toFixed(precision) : projected.y;
      const value = x + ' ' + y;
      if (parts.length && parts[parts.length - 1].value === value) return;
      parts.push({ value, command: parts.length ? 'L ' : 'M ' });
    };
    append(range && range.first);
    for (let index = start; index <= end; index++) {
      const point = points[index];
      if (range && range.first && (point.s || 0) <= range.first.s + 1e-9) continue;
      if (range && range.last && (point.s || 0) >= range.last.s - 1e-9) continue;
      append(point);
    }
    append(range && range.last);
    return parts.map((part) => part.command + part.value).join(' ');
  }

export const FieldScene = Object.freeze({ fractionRange, segmentRange, pathData });
