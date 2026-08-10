  function lowerBoundByDistance(points, distance) {
    let low = 0, high = points.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((points[middle].s || 0) < distance) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** Finds the sampled point span for a path-fraction interval in logarithmic time. */
  function fractionRange(points, totalDistance, first, last) {
    if (!points.length) return { start: 0, end: -1 };
    const lowFraction = Math.max(0, Math.min(1, Math.min(first, last)));
    const highFraction = Math.max(0, Math.min(1, Math.max(first, last)));
    const total = totalDistance || points[points.length - 1].s || 0;
    const start = Math.max(0, lowerBoundByDistance(points, lowFraction * total) - 1);
    const end = Math.min(points.length - 1, lowerBoundByDistance(points, highFraction * total));
    return { start, end: Math.max(start, end) };
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
    for (let index = start; index <= end; index++) {
      const point = project(points[index]);
      const x = Number.isInteger(precision) ? point.x.toFixed(precision) : point.x;
      const y = Number.isInteger(precision) ? point.y.toFixed(precision) : point.y;
      parts.push(index === start ? 'M ' + x + ' ' + y : 'L ' + x + ' ' + y);
    }
    return parts.join(' ');
  }

export const FieldScene = Object.freeze({ fractionRange, segmentRange, pathData });
