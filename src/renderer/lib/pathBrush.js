// Local path sculpting with adaptive Bézier subdivision. Brush edits leave
// distant segments untouched and create control points only inside the brush.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Arc and clothoid segments are generated from their endpoints rather than from
// control handles, so subdividing or retangenting one would silently reinterpret it
// as a Bézier and reshape the whole segment. The brush leaves those spans alone.
const RESHAPEABLE = new Set(['bezier', 'line', undefined, null, '']);
const isReshapeable = (waypoint) => !!waypoint && RESHAPEABLE.has(waypoint.segType);
const mix = (a, b, t) => a + (b - a) * t;
const pointMix = (a, b, t) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const point = (value) => ({ x: value.x, y: value.y });

function cubicPoints(start, end) {
  const p0 = point(start), p1 = point(end);
  if (start.segType === 'line') {
    return [p0, pointMix(p0, p1, 1 / 3), pointMix(p0, p1, 2 / 3), p1];
  }
  return [p0, point(start.nextC || pointMix(p0, p1, 1 / 3)), point(end.prevC || pointMix(p0, p1, 2 / 3)), p1];
}

function cubicPoint(curve, t) {
  const a = pointMix(curve[0], curve[1], t);
  const b = pointMix(curve[1], curve[2], t);
  const c = pointMix(curve[2], curve[3], t);
  return pointMix(pointMix(a, b, t), pointMix(b, c, t), t);
}

function splitCubic(curve, t) {
  const q0 = pointMix(curve[0], curve[1], t);
  const q1 = pointMix(curve[1], curve[2], t);
  const q2 = pointMix(curve[2], curve[3], t);
  const r0 = pointMix(q0, q1, t);
  const r1 = pointMix(q1, q2, t);
  const center = pointMix(r0, r1, t);
  return { left: [curve[0], q0, r0, center], right: [center, r1, q2, curve[3]] };
}

function approximateLength(curve, steps = 32) {
  let length = 0;
  let previous = curve[0];
  for (let index = 1; index <= steps; index++) {
    const next = cubicPoint(curve, index / steps);
    length += distance(previous, next);
    previous = next;
  }
  return length;
}

function segmentMetadata(source) {
  const result = { segType: 'bezier' };
  for (const key of ['segmentHeadingMode', 'segmentFollowMode', 'segmentLookAt']) {
    if (source[key] !== undefined) result[key] = typeof source[key] === 'object' ? { ...source[key] } : source[key];
  }
  return result;
}

// Cumulative arc-length fraction at each waypoint. This mirrors PM.waypointFracs, which
// is what actually resolves a `wp`-anchored range, so anchors captured and restored
// through these helpers land back on the same point of the path.
function waypointArcFractions(path) {
  const cumulative = [0];
  let total = 0;
  for (let index = 0; index + 1 < path.waypoints.length; index++) {
    total += approximateLength(cubicPoints(path.waypoints[index], path.waypoints[index + 1]), 24);
    cumulative.push(total);
  }
  if (total <= 1e-9) return cumulative.map((_, index) => (cumulative.length < 2 ? 0 : index / (cumulative.length - 1)));
  return cumulative.map((value) => value / total);
}

// PM interpolates linearly between waypoint fractions, so this is its exact inverse.
function fractionOfAnchor(fractions, waypointIndex, local) {
  if (local == null) return fractions[clamp(Math.round(waypointIndex || 0), 0, fractions.length - 1)];
  const segment = clamp(Math.round(waypointIndex || 0), 0, fractions.length - 2);
  return fractions[segment] + (fractions[segment + 1] - fractions[segment]) * clamp(Number(local), 0, 1);
}

function anchorOfFraction(fractions, fraction) {
  const target = clamp(fraction, 0, 1);
  const last = fractions.length - 2;
  for (let segment = 0; segment <= last; segment++) {
    const start = fractions[segment];
    const end = fractions[segment + 1];
    if (target > end && segment < last) continue;
    const span = end - start;
    return { w: segment, t: span > 1e-12 ? clamp((target - start) / span, 0, 1) : 0 };
  }
  return { w: 0, t: 0 };
}

// Records where each `wp`-anchored range currently sits so a topology change can put it
// back. Endpoints naming a whole waypoint (legacy ranges with no t) are tracked by object
// identity, so they keep that form as long as the waypoint survives the edit.
function captureRangeAnchors(path) {
  const ranges = path.ranges || [];
  if (!ranges.some((range) => range.anchor === 'wp')) return null;
  const fractions = waypointArcFractions(path);
  return ranges.map((range) => {
    if (range.anchor !== 'wp') return null;
    return [['w0', 't0'], ['w1', 't1']].map(([waypointKey, localKey]) => {
      const waypointIndex = Number.isInteger(range[waypointKey]) ? range[waypointKey] : 0;
      const local = range[localKey];
      const fraction = fractionOfAnchor(fractions, waypointIndex, local);
      const waypoint = local == null ? path.waypoints[clamp(waypointIndex, 0, path.waypoints.length - 1)] : null;
      return { fraction, waypoint };
    });
  });
}

function restoreRangeAnchors(path, captured) {
  if (!captured) return;
  const ranges = path.ranges || [];
  const fractions = waypointArcFractions(path);
  ranges.forEach((range, index) => {
    const endpoints = captured[index];
    if (!endpoints || range.anchor !== 'wp') return;
    endpoints.forEach((endpoint, side) => {
      const waypointKey = side === 0 ? 'w0' : 'w1';
      const localKey = side === 0 ? 't0' : 't1';
      const survivor = endpoint.waypoint ? path.waypoints.indexOf(endpoint.waypoint) : -1;
      if (survivor >= 0) {
        range[waypointKey] = survivor;
        delete range[localKey];
        return;
      }
      const anchor = anchorOfFraction(fractions, endpoint.fraction);
      range[waypointKey] = anchor.w;
      range[localKey] = anchor.t;
    });
    if (fractionOfAnchor(fractions, range.w0, range.t0) > fractionOfAnchor(fractions, range.w1, range.t1)) {
      [range.w0, range.w1] = [range.w1, range.w0];
      [range.t0, range.t1] = [range.t1, range.t0];
      if (range.t0 === undefined) delete range.t0;
      if (range.t1 === undefined) delete range.t1;
    }
  });
}

// Splitting a cubic is exact, so inserting a waypoint never changes the curve. Points are
// added across the brush and slightly past its rim. Those outermost waypoints are what pin
// the deformation: a segment can only bend if one of its endpoints moves, and an endpoint
// past the rim has zero falloff weight. Subdividing only up to the radius leaves the
// segment leaving the brush anchored on a waypoint that does move, which is what let a 1 cm
// drag shift geometry metres away.
const RIM_MARGIN = 1.12;

function subdivisionParameters(curve, center, radius, spacing) {
  const length = approximateLength(curve);
  if (length < spacing * 1.35) return [];
  const steps = clamp(Math.ceil(length / Math.max(0.04, spacing / 2)), 12, 96);
  const candidates = [];
  let lastDistance = -Infinity;
  const beyondRim = (t) => distance(cubicPoint(curve, t), center) > radius * RIM_MARGIN;
  let previousBeyond = beyondRim(0);
  for (let index = 1; index < steps; index++) {
    const t = index / steps;
    const nowBeyond = beyondRim(t);
    // The first sample past the rim on each side is the anchor, so it ignores the spacing
    // rule. Letting spacing drop it is what reopens the leak.
    const anchor = nowBeyond !== previousBeyond;
    previousBeyond = nowBeyond;
    const along = length * t;
    if (along < spacing * 0.35 || length - along < spacing * 0.35) continue;
    if (!anchor && (nowBeyond || along - lastDistance < spacing * 0.78)) continue;
    candidates.push(t);
    lastDistance = along;
  }
  return candidates;
}

function splitSegment(path, segmentIndex, parameters) {
  if (!parameters.length) return 0;
  const waypoints = path.waypoints;
  const source = waypoints[segmentIndex];
  const end = waypoints[segmentIndex + 1];
  const metadata = segmentMetadata(source);
  let remaining = cubicPoints(source, end);
  let previousT = 0;
  let currentStart = source;
  source.segType = 'bezier';

  parameters.forEach((parameter, offset) => {
    const localT = (parameter - previousT) / Math.max(1e-9, 1 - previousT);
    const halves = splitCubic(remaining, localT);
    currentStart.nextC = point(halves.left[1]);
    const insertedIndex = segmentIndex + offset + 1;
    const waypoint = {
      x: halves.left[3].x,
      y: halves.left[3].y,
      prevC: point(halves.left[2]),
      nextC: point(halves.right[1]),
      linked: true,
      corner: false,
      stop: false,
      thetaOn: false,
      theta: mix(Number(source.theta) || 0, Number(end.theta) || 0, parameter),
      ...metadata,
    };
    waypoints.splice(insertedIndex, 0, waypoint);
    currentStart = waypoint;
    remaining = halves.right;
    previousT = parameter;
  });
  currentStart.nextC = point(remaining[1]);
  end.prevC = point(remaining[2]);
  return parameters.length;
}

function densify(path, center, radius) {
  const spacing = clamp(radius * 0.3, 0.12, 0.48);
  let added = 0;
  let segmentIndex = 0;
  while (segmentIndex < path.waypoints.length - 1 && path.waypoints.length < 320) {
    const start = path.waypoints[segmentIndex];
    const end = path.waypoints[segmentIndex + 1];
    if (!isReshapeable(start)) { segmentIndex += 1; continue; }
    const curve = cubicPoints(start, end);
    const parameters = subdivisionParameters(curve, center, radius, spacing)
      .slice(0, Math.max(0, 320 - path.waypoints.length));
    const inserted = splitSegment(path, segmentIndex, parameters);
    added += inserted;
    segmentIndex += inserted + 1;
  }
  return added;
}

function falloff(value, radius) {
  const u = clamp(1 - value / Math.max(radius, 1e-6), 0, 1);
  return u * u * (3 - 2 * u);
}

// How far the pointer swept around the stroke's anchor, in radians. Using real angular
// motion rather than a linear mix of dx and dy means no drag direction silently cancels:
// orbiting the anchor either way twirls that way, and only a straight radial drag (which
// is not a twirl gesture at all) produces nothing.
function twirlAngle(stroke) {
  const anchor = stroke.origin;
  const ax = stroke.previous.x - anchor.x;
  const ay = stroke.previous.y - anchor.y;
  const bx = stroke.center.x - anchor.x;
  const by = stroke.center.y - anchor.y;
  const swept = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  if (Number.isFinite(swept) && Math.abs(swept) > 1e-9) return swept;
  // Pointer is still at the anchor, so there is no arc yet. Fall back to the drag's
  // component across the anchor direction so the very first move still reads as a twirl.
  const dx = stroke.center.x - stroke.previous.x;
  const dy = stroke.center.y - stroke.previous.y;
  return (dx - dy) / Math.max(stroke.radius, 1e-6);
}

function transformPoint(value, stroke) {
  const weight = falloff(distance(value, stroke.center), stroke.radius);
  if (weight <= 0) return point(value);
  const dx = stroke.center.x - stroke.previous.x;
  const dy = stroke.center.y - stroke.previous.y;
  if (stroke.kind === 'twirl') {
    const angle = twirlAngle(stroke) * stroke.strength * 1.8 * weight;
    const x = value.x - stroke.center.x;
    const y = value.y - stroke.center.y;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    return { x: stroke.center.x + x * cosine - y * sine, y: stroke.center.y + x * sine + y * cosine };
  }
  return { x: value.x + dx * stroke.strength * weight, y: value.y + dy * stroke.strength * weight };
}

// A waypoint bounding an arc or clothoid cannot move: those segments are generated from
// their endpoints, so shifting one silently reshapes the entire span, most of which lies
// outside the brush.
function boundsGeneratedSegment(path, index) {
  return !isReshapeable(path.waypoints[index])
    || (index > 0 && !isReshapeable(path.waypoints[index - 1]));
}

// Displaces every waypoint the stroke reaches, along with its handles, and reports each
// one's falloff weight so the refit can scale with how hard the stroke actually hit it.
function displaceWaypoints(path, stroke) {
  const touched = new Map();
  path.waypoints.forEach((waypoint, index) => {
    const weight = falloff(distance(waypoint, stroke.center), stroke.radius);
    if (weight <= 0 || boundsGeneratedSegment(path, index)) return;
    touched.set(index, weight);
    const transformed = transformPoint(waypoint, stroke);
    const previousControl = transformPoint(waypoint.prevC || waypoint, stroke);
    const nextControl = transformPoint(waypoint.nextC || waypoint, stroke);
    waypoint.x = clamp(transformed.x, 0, 17.548);
    waypoint.y = clamp(transformed.y, 0, 8.052);
    waypoint.prevC = previousControl;
    waypoint.nextC = nextControl;
  });
  return touched;
}

// Blends each touched waypoint's tangent toward the one implied by its neighbours,
// scaled by that waypoint's falloff weight. Blending rather than replacing matters: a
// waypoint grazed at the rim of the brush keeps essentially the handles it was authored
// with, so a small drag cannot swing far-away geometry. Handles stay collinear, which
// the project schema requires of interior moving waypoints.
function refitHandles(path, touched) {
  const waypoints = path.waypoints;
  for (const [index, weight] of touched) {
    const waypoint = waypoints[index];
    if (!waypoint || waypoint.stop || waypoint.corner || boundsGeneratedSegment(path, index)) continue;
    const previous = waypoints[Math.max(0, index - 1)];
    const next = waypoints[Math.min(waypoints.length - 1, index + 1)];
    let tx = next.x - previous.x;
    let ty = next.y - previous.y;
    const magnitude = Math.hypot(tx, ty);
    if (magnitude < 1e-8) continue;
    tx /= magnitude;
    ty /= magnitude;

    // Existing tangent, so a partially-weighted refit can rotate toward the fitted one
    // instead of snapping to it.
    const priorPrev = waypoint.prevC || waypoint;
    const priorNext = waypoint.nextC || waypoint;
    let ax = priorNext.x - priorPrev.x;
    let ay = priorNext.y - priorPrev.y;
    const priorMagnitude = Math.hypot(ax, ay);
    if (priorMagnitude > 1e-8) {
      ax /= priorMagnitude;
      ay /= priorMagnitude;
      // Keep the blend on the near side so a reversed handle pair cannot flip the tangent.
      if (ax * tx + ay * ty < 0) { ax = -ax; ay = -ay; }
      let bx = mix(ax, tx, weight);
      let by = mix(ay, ty, weight);
      const blended = Math.hypot(bx, by);
      if (blended > 1e-8) { tx = bx / blended; ty = by / blended; }
    }

    const priorIncoming = distance(waypoint, priorPrev);
    const priorOutgoing = distance(waypoint, priorNext);
    const incoming = index > 0 ? mix(priorIncoming, distance(waypoint, previous) * 0.34, weight) : 0;
    const outgoing = index + 1 < waypoints.length ? mix(priorOutgoing, distance(waypoint, next) * 0.34, weight) : 0;
    waypoint.prevC = { x: waypoint.x - tx * incoming, y: waypoint.y - ty * incoming };
    waypoint.nextC = { x: waypoint.x + tx * outgoing, y: waypoint.y + ty * outgoing };
    waypoint.linked = true;
    waypoint.corner = false;
  }
}

// Relaxes interior waypoints toward the midpoint of their neighbours and reports each
// one's falloff weight so the refit can scale with it.
function smoothWaypoints(path, stroke) {
  const original = path.waypoints.map(point);
  const travel = distance(stroke.center, stroke.previous);
  const scale = clamp(travel / Math.max(stroke.radius, 1e-6) * 3.2, 0.025, 0.22) * stroke.strength;
  const touched = new Map();
  for (let index = 1; index < path.waypoints.length - 1; index++) {
    const waypoint = path.waypoints[index];
    const weight = falloff(distance(waypoint, stroke.center), stroke.radius);
    if (weight <= 0 || waypoint.stop || waypoint.corner || boundsGeneratedSegment(path, index)) continue;
    const average = pointMix(original[index - 1], original[index + 1], 0.5);
    waypoint.x = mix(waypoint.x, average.x, scale * weight);
    waypoint.y = mix(waypoint.y, average.y, scale * weight);
    touched.set(index, weight);
  }
  return touched;
}

const SEGMENT_KEYS = ['segType', 'segmentHeadingMode', 'segmentFollowMode', 'segmentLookAt'];

function sameSegmentMetadata(first, second) {
  return SEGMENT_KEYS.every((key) => JSON.stringify(first[key]) === JSON.stringify(second[key]));
}

function isSemanticWaypoint(waypoint) {
  return waypoint.stop || waypoint.corner || waypoint.thetaOn || waypoint.wait != null
    || waypoint.turnInPlace != null || waypoint.jiggle != null || waypoint.headingTransition != null;
}

function distanceToSegment(value, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-18) return distance(value, start);
  const t = clamp(((value.x - start.x) * dx + (value.y - start.y) * dy) / lengthSquared, 0, 1);
  return distance(value, { x: start.x + dx * t, y: start.y + dy * t });
}

// Shortest distance from a point to a curve, approximated by its chord polyline. Unlike
// comparing points at equal t, this ignores the reparameterization a merge necessarily
// introduces and only reports genuine changes in shape.
function distanceToCurve(value, curve, steps = 64) {
  let closest = Infinity;
  let previous = curve[0];
  for (let index = 1; index <= steps; index++) {
    const current = cubicPoint(curve, index / steps);
    closest = Math.min(closest, distanceToSegment(value, previous, current));
    previous = current;
  }
  return closest;
}

// Fits one cubic through the span previous..waypoint..next and reports how far it
// strays from the original. `error` covers the whole span; `outsideError` covers only
// the portion beyond the stroke, which must stay put even when the merge is accepted.
function mergedCurveCandidate(previous, waypoint, next, stroke) {
  const left = cubicPoints(previous, waypoint);
  const right = cubicPoints(waypoint, next);
  const incoming = distance(left[2], left[3]);
  const outgoing = distance(right[0], right[1]);
  const handleTotal = incoming + outgoing;
  const lengthTotal = approximateLength(left, 16) + approximateLength(right, 16);
  const splitT = clamp(handleTotal > 1e-8 ? incoming / handleTotal : approximateLength(left, 16) / Math.max(lengthTotal, 1e-8), 0.08, 0.92);
  const curve = [
    left[0],
    { x: left[0].x + (left[1].x - left[0].x) / splitT, y: left[0].y + (left[1].y - left[0].y) / splitT },
    { x: right[3].x + (right[2].x - right[3].x) / (1 - splitT), y: right[3].y + (right[2].y - right[3].y) / (1 - splitT) },
    right[3],
  ];
  if (distance(curve[0], curve[1]) > lengthTotal * 1.5 || distance(curve[2], curve[3]) > lengthTotal * 1.5) return null;
  let error = 0;
  let outsideError = 0;
  for (let index = 0; index <= 24; index++) {
    const t = index / 24;
    const original = t <= splitT
      ? cubicPoint(left, t / splitT)
      : cubicPoint(right, (t - splitT) / (1 - splitT));
    error = Math.max(error, distance(original, cubicPoint(curve, t)));
    if (falloff(distance(original, stroke.center), stroke.radius) <= 0) {
      outsideError = Math.max(outsideError, distanceToCurve(original, curve));
    }
  }
  return { curve, error, outsideError, splitT };
}

// Merges redundant waypoints back into a single curve. A merge rewrites the handles of
// both neighbours, which can reach past the stroke, so the merged curve must also leave
// the part of the span outside the radius where it was.
const OUTSIDE_TOLERANCE = 1e-6;

function consolidateWaypoints(path, stroke) {
  let removed = 0;
  for (let index = 1; index < path.waypoints.length - 1;) {
    const previous = path.waypoints[index - 1];
    const waypoint = path.waypoints[index];
    const next = path.waypoints[index + 1];
    const weight = falloff(distance(waypoint, stroke.center), stroke.radius);
    const spanReshapeable = isReshapeable(previous) && isReshapeable(waypoint);
    if (weight <= 0 || !spanReshapeable || isSemanticWaypoint(waypoint) || !sameSegmentMetadata(previous, waypoint)) {
      index += 1;
      continue;
    }
    const candidate = mergedCurveCandidate(previous, waypoint, next, stroke);
    const tolerance = stroke.radius * (0.008 + stroke.strength * 0.026) * weight;
    if (!candidate || candidate.error > tolerance || candidate.outsideError > OUTSIDE_TOLERANCE) {
      index += 1;
      continue;
    }
    previous.nextC = point(candidate.curve[1]);
    next.prevC = point(candidate.curve[2]);
    path.waypoints.splice(index, 1);
    removed += 1;
    index = Math.max(1, index - 1);
  }
  return removed;
}

const geometryOf = (path) => path.waypoints.map((waypoint) => [
  waypoint.x, waypoint.y,
  waypoint.prevC ? waypoint.prevC.x : null, waypoint.prevC ? waypoint.prevC.y : null,
  waypoint.nextC ? waypoint.nextC.x : null, waypoint.nextC ? waypoint.nextC.y : null,
].join(',')).join(';');

// Applies one stroke in place. Returns how much topology changed and whether the stroke
// moved anything at all, so a caller can skip the undo entry for a no-op.
function apply(path, input) {
  if (!path || !Array.isArray(path.waypoints) || path.waypoints.length < 2) {
    return { path, added: 0, removed: 0, changed: false };
  }
  const stroke = {
    kind: ['push', 'smooth', 'twirl'].includes(input.kind) ? input.kind : 'push',
    center: point(input.center),
    previous: point(input.previous || input.center),
    // Where the drag started. Twirl measures the angle swept about this point; without it
    // there is no centre to orbit, so fall back to the segment's own start.
    origin: point(input.origin || input.previous || input.center),
    radius: clamp(Number(input.radius) || 0.9, 0.2, 3),
    strength: clamp(Number(input.strength) || 0.65, 0.05, 1),
  };
  const before = geometryOf(path);
  // Anchors are captured against the pre-edit path and restored against the post-edit one,
  // so subdivision and consolidation cannot slide a constraint range along the path.
  const anchors = captureRangeAnchors(path);
  const added = stroke.kind === 'smooth' ? 0 : densify(path, stroke.center, stroke.radius);
  const touched = stroke.kind === 'smooth' ? smoothWaypoints(path, stroke) : displaceWaypoints(path, stroke);
  refitHandles(path, touched);
  const removed = stroke.kind === 'smooth' ? consolidateWaypoints(path, stroke) : 0;
  restoreRangeAnchors(path, anchors);
  return { path, added, removed, changed: added > 0 || removed > 0 || geometryOf(path) !== before };
}

export const PathBrush = { apply };
