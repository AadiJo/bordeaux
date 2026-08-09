// Bordeaux fixed-path reachability mirror for the static renderer.
(function () {
  const EPSILON = 1e-9;
  const SAFETY = 0.995;
  const D2R = Math.PI / 180;
  const R = (value, places) => Number(value.toFixed(places));

  function unwrap(values) {
    if (!values.length) return [];
    const result = [values[0]];
    for (let index = 1; index < values.length; index++) {
      let delta = values[index] - result[index - 1];
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      result.push(result[index - 1] + delta);
    }
    return result;
  }

  function derivative(values, positions, breaks) {
    return values.map((_value, index) => {
      let before = index === 0 ? 0 : index - 1;
      let after = index === values.length - 1 ? values.length - 1 : index + 1;
      if (breaks.has(index)) {
        if (after > index) before = index; else after = index;
      } else {
        if (breaks.has(before)) before = index;
        if (breaks.has(after)) after = index;
      }
      const distance = positions[after] - positions[before];
      return distance > EPSILON ? (values[after] - values[before]) / distance : 0;
    });
  }

  function canonicalState(doc, pts, head, waypointIndices) {
    const positions = pts.map((point) => point.s);
    const stopped = new Set();
    waypointIndices.forEach((sampleIndex, waypointIndex) => {
      if (doc.waypoints[waypointIndex] && doc.waypoints[waypointIndex].stop) stopped.add(sampleIndex);
    });
    const tangentXRaw = derivative(pts.map((point) => point.x), positions, stopped);
    const tangentYRaw = derivative(pts.map((point) => point.y), positions, stopped);
    const tangentAngles = unwrap(tangentXRaw.map((x, index) => Math.atan2(tangentYRaw[index], x)));
    const curvatures = derivative(tangentAngles, positions, stopped);
    const headings = unwrap(head);
    const headingDerivatives = derivative(headings, positions, stopped);
    const headingSecondDerivatives = derivative(headingDerivatives, positions, stopped);
    const waypointBySample = new Map();
    waypointIndices.forEach((sampleIndex, waypointIndex) => {
      if (!waypointBySample.has(sampleIndex)) waypointBySample.set(sampleIndex, waypointIndex);
    });
    return pts.map((point, index) => {
      const length = Math.hypot(tangentXRaw[index], tangentYRaw[index]);
      const tangentX = length > EPSILON ? tangentXRaw[index] / length : Math.cos(tangentAngles[index]);
      const tangentY = length > EPSILON ? tangentYRaw[index] / length : Math.sin(tangentAngles[index]);
      return {
        s: point.s,
        f: point.f != null ? point.f : positions[positions.length - 1] > EPSILON ? point.s / positions[positions.length - 1] : 0,
        x: point.x,
        y: point.y,
        tangentRad: tangentAngles[index],
        tangentX,
        tangentY,
        normalX: -tangentY,
        normalY: tangentX,
        curvature: curvatures[index],
        heading: headings[index],
        headingDerivative: headingDerivatives[index],
        headingSecondDerivative: headingSecondDerivatives[index],
        waypointIndex: waypointBySample.get(index),
        stop: stopped.has(index),
      };
    });
  }

  function interpolate(before, after) {
    const phase = after.stop ? before : before.stop ? after : null;
    const mix = (first, second) => (first + second) * 0.5;
    const tangent = phase ? phase.tangentRad : mix(before.tangentRad, after.tangentRad);
    return {
      s: mix(before.s, after.s),
      f: mix(before.f, after.f),
      x: mix(before.x, after.x),
      y: mix(before.y, after.y),
      tangentRad: tangent,
      tangentX: Math.cos(tangent),
      tangentY: Math.sin(tangent),
      normalX: -Math.sin(tangent),
      normalY: Math.cos(tangent),
      curvature: phase ? phase.curvature : mix(before.curvature, after.curvature),
      heading: phase ? phase.heading : mix(before.heading, after.heading),
      headingDerivative: phase ? phase.headingDerivative : mix(before.headingDerivative, after.headingDerivative),
      headingSecondDerivative: phase ? phase.headingSecondDerivative : mix(before.headingSecondDerivative, after.headingSecondDerivative),
      stop: false,
    };
  }

  function overlaps(range, before, after) {
    const start = Math.min(before, after), end = Math.max(before, after);
    const low = Math.min(range.f0, range.f1), high = Math.max(range.f0, range.f1);
    return Math.min(end, high) - Math.max(start, low) >= -EPSILON;
  }

  function activeRanges(ranges, fraction) {
    return ranges.filter((range) => fraction >= Math.min(range.f0, range.f1) - EPSILON
      && fraction <= Math.max(range.f0, range.f1) + EPSILON);
  }

  function limitsForRanges(doc, robot, ranges) {
    const freeSpeed = Math.max(0.01, robot.maxSpeed || doc.constraints.maxVel || 0.01);
    let velocity = Math.max(0.01, Math.min(freeSpeed, doc.constraints.maxVel || freeSpeed));
    let acceleration = Math.max(0.01, doc.constraints.maxAccel || 0.01);
    let deceleration = Math.max(0.01, doc.constraints.maxDecel || doc.constraints.maxAccel || 0.01);
    ranges.forEach((range) => {
      if (range.maxVel > 0) velocity = Math.min(velocity, range.maxVel);
      if (range.maxAccel > 0) acceleration = Math.min(acceleration, range.maxAccel);
      const rangeDeceleration = range.maxDecel || range.maxAccel;
      if (rangeDeceleration > 0) deceleration = Math.min(deceleration, rangeDeceleration);
    });
    return { freeSpeed, velocity, acceleration, deceleration };
  }

  function angularLimits(doc, ranges) {
    let velocity = doc.constraints.maxAngVel * D2R;
    let acceleration = doc.constraints.maxAngAccel * D2R;
    let deceleration = (doc.constraints.maxAngDecel || doc.constraints.maxAngAccel) * D2R;
    ranges.forEach((range) => {
      velocity = Math.min(velocity, range.maxAngVel * D2R);
      acceleration = Math.min(acceleration, range.maxAngAccel * D2R);
      deceleration = Math.min(deceleration, range.maxAngAccel * D2R);
    });
    return { velocity, acceleration, deceleration };
  }

  function translationPriorityStart(ranges, transitions, points) {
    for (let index = 1; index < points.length; index++) {
      const active = ranges.filter((range) => overlaps(range, points[index - 1].f, points[index].f));
      const activeTransitions = transitions.filter((range) => overlaps(range, points[index - 1].f, points[index].f));
      if (active.length + activeTransitions.length > 0
        && active.every((range) => range.rotationPriority === 'translation')
        && activeTransitions.every((range) => range.rotationPriority === 'translation')) return index;
    }
    return null;
  }

  function moduleOffsets(robot) {
    const model = robot.driveModel || {};
    if (!(model.trackwidthM > 0)) return [];
    const halfTrack = model.trackwidthM * 0.5;
    if (robot.drive === 'tank') return [{ x: 0, y: halfTrack, label: 'tank-left-wheel' }, { x: 0, y: -halfTrack, label: 'tank-right-wheel' }];
    if (!(model.wheelbaseM > 0)) return [];
    const halfWheelbase = model.wheelbaseM * 0.5;
    return [
      { x: halfWheelbase, y: halfTrack, label: 'swerve-front-left-module' },
      { x: halfWheelbase, y: -halfTrack, label: 'swerve-front-right-module' },
      { x: -halfWheelbase, y: halfTrack, label: 'swerve-rear-left-module' },
      { x: -halfWheelbase, y: -halfTrack, label: 'swerve-rear-right-module' },
    ];
  }

  function project(point, robot, accelerationLimit) {
    const velocityConstraints = [], accelerationConstraints = [];
    let velocityLimit = Math.max(0.01, robot.maxSpeed);
    const cos = Math.cos(point.heading), sin = Math.sin(point.heading);
    moduleOffsets(robot).forEach((module) => {
      const offsetX = cos * module.x - sin * module.y;
      const offsetY = sin * module.x + cos * module.y;
      const perpendicularX = -offsetY, perpendicularY = offsetX;
      const uX = point.tangentX + point.headingDerivative * perpendicularX;
      const uY = point.tangentY + point.headingDerivative * perpendicularY;
      const xX = point.curvature * point.normalX + point.headingSecondDerivative * perpendicularX - point.headingDerivative ** 2 * offsetX;
      const xY = point.curvature * point.normalY + point.headingSecondDerivative * perpendicularY - point.headingDerivative ** 2 * offsetY;
      const coefficient = Math.hypot(uX, uY);
      if (coefficient > EPSILON) velocityLimit = Math.min(velocityLimit, robot.maxSpeed / coefficient);
      velocityConstraints.push({ coefficient, limit: robot.maxSpeed, label: module.label });
      accelerationConstraints.push({ uX, uY, xX, xY, limit: Math.max(0.01, accelerationLimit), label: module.label });
      const constantSpeed = Math.hypot(xX, xY);
      if (constantSpeed > EPSILON) velocityLimit = Math.min(velocityLimit, Math.sqrt(Math.max(0, accelerationLimit) / constantSpeed));
    });
    return { velocityLimit, velocityConstraints, accelerationConstraints };
  }

  function accelerationBounds(constraints, speedSquared) {
    let minimum = -Infinity, maximum = Infinity;
    for (const constraint of constraints) {
      const a = constraint.uX ** 2 + constraint.uY ** 2;
      const b = 2 * speedSquared * (constraint.uX * constraint.xX + constraint.uY * constraint.xY);
      const c = speedSquared ** 2 * (constraint.xX ** 2 + constraint.xY ** 2) - constraint.limit ** 2;
      if (a <= EPSILON) { if (c > EPSILON) return null; continue; }
      const discriminant = b ** 2 - 4 * a * c;
      if (discriminant < -EPSILON) return null;
      const root = Math.sqrt(Math.max(0, discriminant));
      minimum = Math.max(minimum, (-b - root) / (2 * a));
      maximum = Math.min(maximum, (-b + root) / (2 * a));
      if (minimum > maximum + EPSILON) return null;
    }
    return { minimum, maximum };
  }

  function intervalBounds(constraints, startSquared, distance) {
    return accelerationBounds(constraints.map((constraint) => ({
      ...constraint,
      uX: constraint.uX + constraint.xX * distance,
      uY: constraint.uY + constraint.xY * distance,
    })), startSquared);
  }

  function solve(input) {
    const count = input.positions.length;
    const squaredLimits = input.velocityLimits.map((velocity) => velocity ** 2);
    const controllable = new Array(count);
    controllable[count - 1] = input.goalVelocity ** 2;
    for (let index = count - 2; index >= 0; index--) {
      const distance = Math.max(0, input.positions[index + 1] - input.positions[index]);
      const scalarMaximum = Math.min(squaredLimits[index], controllable[index + 1] + 2 * input.decelerationLimits[index] * distance);
      const constraints = input.accelerationConstraints[index];
      if (!constraints.length || distance <= EPSILON || scalarMaximum <= controllable[index + 1]) { controllable[index] = scalarMaximum; continue; }
      const canReach = (candidate) => {
        const acceleration = (controllable[index + 1] - candidate) / (2 * distance);
        const bounds = intervalBounds(constraints, candidate, distance);
        return bounds && acceleration >= Math.max(-input.decelerationLimits[index], bounds.minimum) - EPSILON && acceleration <= bounds.maximum + EPSILON;
      };
      if (canReach(scalarMaximum)) { controllable[index] = scalarMaximum; continue; }
      let lower = Math.min(controllable[index + 1], scalarMaximum), upper = scalarMaximum;
      if (!canReach(lower)) return { status: 'infeasible', reason: 'Drivetrain acceleration bounds are empty.', velocities: [] };
      for (let iteration = 0; iteration < 36; iteration++) { const candidate = (lower + upper) * 0.5; if (canReach(candidate)) lower = candidate; else upper = candidate; }
      controllable[index] = lower;
    }
    const startSquared = input.startVelocity ** 2;
    if (startSquared > controllable[0] + 1e-8) return { status: 'infeasible', reason: 'Start velocity cannot reach the authored stops and goal.', velocities: [] };
    const speedSquared = new Array(count).fill(0); speedSquared[0] = startSquared;
    for (let index = 0; index < count - 1; index++) {
      const distance = Math.max(0, input.positions[index + 1] - input.positions[index]);
      const velocity = Math.sqrt(Math.max(0, speedSquared[index]));
      const motorScale = Math.max(0, Math.min(1, 1 - velocity / input.freeSpeeds[index]));
      const bounds = intervalBounds(input.accelerationConstraints[index], speedSquared[index], distance);
      if (!bounds) return { status: 'infeasible', reason: 'Drivetrain acceleration bounds are empty.', velocities: [] };
      const acceleration = Math.min(input.accelerationLimits[index] * motorScale, bounds.maximum);
      if (acceleration < Math.max(-input.decelerationLimits[index], bounds.minimum) - EPSILON) return { status: 'infeasible', reason: 'Drivetrain acceleration bounds are contradictory.', velocities: [] };
      speedSquared[index + 1] = Math.min(squaredLimits[index + 1], controllable[index + 1], speedSquared[index] + 2 * acceleration * distance);
    }
    if (speedSquared[count - 1] < input.goalVelocity ** 2 - 1e-8) return { status: 'infeasible', reason: 'Goal velocity is unreachable.', velocities: [] };
    speedSquared[count - 1] = input.goalVelocity ** 2;
    for (let index = 0; index < count - 1; index++) {
      if (input.positions[index + 1] - input.positions[index] > EPSILON
        && speedSquared[index] + speedSquared[index + 1] <= EPSILON) {
        return { status: 'invalid-input', reason: 'A moving interval is pinned between stopped samples.', velocities: [] };
      }
    }
    return { status: 'optimal', velocities: speedSquared.map((value) => Math.sqrt(Math.max(0, value))) };
  }

  function timing(points, velocities) {
    const pts = points;
    const times = new Array(pts.length).fill(0);
    for (let index = 1; index < pts.length; index++) {
      const distance = Math.max(0, pts[index].s - pts[index - 1].s);
      times[index] = times[index - 1] + distance / Math.max(1e-6, (velocities[index] + velocities[index - 1]) * 0.5);
    }
    const omegas = points.map((point, index) => index === 0
      ? 0
      : R((point.heading - points[index - 1].heading) / Math.max(EPSILON, times[index] - times[index - 1]), 5));
    return { velocities: velocities.map((value) => R(value, 4)), times: times.map((value) => R(value, 4)), omegas };
  }

  function tolerance(limit, absolute, relative) {
    return Math.max(absolute == null ? 1e-3 : absolute, Math.abs(limit) * (relative == null ? 2e-3 : relative));
  }

  function validate(doc, robot, points, linear, intervalProjections, velocities, times, omegas, ranges, skipAngularFrom) {
    const violations = [], active = new Set();
    const add = (kind, index, measured, limit, refinable) => violations.push({ kind, index, measured, limit, refinable });
    const expectedStart = doc.waypoints[0].stop ? 0 : Math.min(linear.points[0].velocity, Math.max(0, doc.startVel || 0));
    const expectedGoal = doc.waypoints[doc.waypoints.length - 1].stop ? 0 : Math.min(linear.points[linear.points.length - 1].velocity, Math.max(0, doc.goalVel || 0));
    if (Math.abs(velocities[0] - expectedStart) > tolerance(expectedStart, 2e-4, 2e-4)) add('boundary-velocity', 0, velocities[0], expectedStart, false);
    if (Math.abs(velocities[velocities.length - 1] - expectedGoal) > tolerance(expectedGoal, 2e-4, 2e-4)) add('boundary-velocity', velocities.length - 1, velocities[velocities.length - 1], expectedGoal, false);
    for (let index = 0; index < points.length; index++) {
      const limit = Math.min(linear.points[index].velocity, linear.intervals[index - 1] ? linear.intervals[index - 1].velocity : Infinity, linear.intervals[index] ? linear.intervals[index].velocity : Infinity);
      if (velocities[index] > limit + tolerance(limit, 1e-4, 1e-4)) add('linear-velocity', index, velocities[index], limit, false);
      if (velocities[index] >= limit * SAFETY) active.add('linear-velocity');
    }
    for (let index = 0; index < points.length - 1; index++) {
      const distance = points[index + 1].s - points[index].s;
      if (distance <= EPSILON) continue;
      const beforeSquared = velocities[index] ** 2, afterSquared = velocities[index + 1] ** 2;
      const speedSquared = (beforeSquared + afterSquared) * 0.5;
      const acceleration = (afterSquared - beforeSquared) / (2 * distance);
      const interval = linear.intervals[index];
      const motor = interval.acceleration * Math.max(0, Math.min(1, 1 - velocities[index] / interval.freeSpeed));
      if (acceleration >= 0 && acceleration > motor + tolerance(motor, 2e-3, 0.01)) add('linear-acceleration', index + 1, acceleration, motor, true);
      if (acceleration < 0 && -acceleration > interval.deceleration + tolerance(interval.deceleration, 2e-3, 0.01)) add('linear-deceleration', index + 1, -acceleration, interval.deceleration, true);
      const bounds = accelerationBounds(intervalProjections[index].accelerationConstraints, speedSquared);
      if (!bounds || acceleration < bounds.minimum - tolerance(Math.abs(bounds ? bounds.minimum : 0)) || acceleration > bounds.maximum + tolerance(Math.abs(bounds ? bounds.maximum : 0))) add('drivetrain-acceleration', index + 1, Math.abs(acceleration), bounds ? Math.max(Math.abs(bounds.minimum), Math.abs(bounds.maximum)) : 0, true);
      const speed = Math.sqrt(Math.max(0, speedSquared));
      if (speed > intervalProjections[index].velocityLimit + tolerance(intervalProjections[index].velocityLimit)) add('drivetrain-velocity', index + 1, speed, intervalProjections[index].velocityLimit, true);
      const stationaryTurn = (point) => point.stop && point.waypointIndex != null && doc.waypoints[point.waypointIndex] && doc.waypoints[point.waypointIndex].turnInPlace;
      if ((skipAngularFrom == null || index + 1 < skipAngularFrom) && !stationaryTurn(points[index]) && !stationaryTurn(points[index + 1])) {
        const angular = angularLimits(doc, ranges.filter((range) => overlaps(range, points[index].f, points[index + 1].f)));
        const omegaAfter = omegas[index + 1];
        const omegaBefore = omegas[index];
        if (Math.abs(omegaAfter) > angular.velocity + tolerance(angular.velocity, 2e-3, 0.02)) add('angular-velocity', index + 1, Math.abs(omegaAfter), angular.velocity, false);
        const alpha = Math.abs(omegaAfter - omegaBefore) / Math.max(EPSILON, times[index + 1] - times[index]);
        const reversing = Math.sign(omegaAfter) && Math.sign(omegaBefore) && Math.sign(omegaAfter) !== Math.sign(omegaBefore);
        const alphaLimit = reversing ? Math.min(angular.acceleration, angular.deceleration) : Math.abs(omegaAfter) >= Math.abs(omegaBefore) ? angular.acceleration : angular.deceleration;
        if (alpha > alphaLimit + tolerance(alphaLimit, 2e-3, 0.02)) add('angular-acceleration', index + 1, alpha, alphaLimit, true);
      }
    }
    return { violations, activeConstraints: Array.from(active).sort() };
  }

  function optimize(doc, robot, pts, head, baseProfile, ranges, waypointIndices, transitions) {
    if ((doc.constraints.maxJerk || 0) > 0) return { status: 'invalid-input', reason: 'Optimized preview does not support nonzero translational jerk.' };
    const totalDistance = pts.length ? pts[pts.length - 1].s : 0;
    const boundaryPoints = pts.map((point) => ({
      ...point,
      s: R(point.s, 4),
      f: R(totalDistance > EPSILON ? point.s / totalDistance : 0, 5),
      x: R(point.x, 4),
      y: R(point.y, 4),
    }));
    const boundaryHead = head.map((heading) => R(heading, 5));
    const points = canonicalState(doc, boundaryPoints, boundaryHead, waypointIndices);
    const linear = {
      points: points.map((point) => limitsForRanges(doc, robot, activeRanges(ranges, point.f))),
      intervals: points.slice(1).map((point, index) => limitsForRanges(doc, robot, ranges.filter((range) => overlaps(range, points[index].f, point.f)))),
    };
    const translationStart = translationPriorityStart(ranges, transitions, points);
    const pointProjections = points.map((point, index) => project(point, robot, (doc.constraints.maxCentripetalAccel || Math.min(linear.intervals[index - 1] ? linear.intervals[index - 1].acceleration : Infinity, linear.intervals[index] ? linear.intervals[index].acceleration : Infinity)) * SAFETY));
    const intervalProjections = points.slice(1).map((point, index) => project(interpolate(points[index], point), robot, (doc.constraints.maxCentripetalAccel || linear.intervals[index].acceleration) * SAFETY));
    const validationProjections = points.slice(1).map((point, index) => project(interpolate(points[index], point), robot, doc.constraints.maxCentripetalAccel || linear.intervals[index].acceleration));
    const angularIntervalLimits = points.slice(1).map((point, index) => {
      const before = points[index], distance = point.s - before.s;
      const stationaryTurn = point.stop && point.waypointIndex != null && doc.waypoints[point.waypointIndex] && doc.waypoints[point.waypointIndex].turnInPlace;
      if (stationaryTurn || (translationStart != null && index + 1 >= translationStart) || distance <= EPSILON) return Infinity;
      const rate = Math.abs((point.heading - before.heading) / distance);
      return angularLimits(doc, ranges.filter((range) => overlaps(range, before.f, point.f))).velocity / Math.max(rate, EPSILON) * SAFETY;
    });
    const velocityLimits = points.map((_point, index) => Math.min(
      linear.points[index].velocity,
      linear.intervals[index - 1] ? linear.intervals[index - 1].velocity : Infinity,
      linear.intervals[index] ? linear.intervals[index].velocity : Infinity,
      pointProjections[index].velocityLimit * SAFETY,
      angularIntervalLimits[index - 1] == null ? Infinity : angularIntervalLimits[index - 1],
      angularIntervalLimits[index] == null ? Infinity : angularIntervalLimits[index],
      Math.max(0, R(baseProfile.v[index], 4)),
    ));
    const startVelocity = doc.waypoints[0].stop ? 0 : Math.min(linear.points[0].velocity, Math.max(0, doc.startVel || 0));
    const goalVelocity = doc.waypoints[doc.waypoints.length - 1].stop ? 0 : Math.min(linear.points[linear.points.length - 1].velocity, Math.max(0, doc.goalVel || 0));
    const solved = solve({
      positions: points.map((point) => point.s), velocityLimits,
      accelerationLimits: linear.intervals.map((limits) => limits.acceleration * SAFETY),
      decelerationLimits: linear.intervals.map((limits) => limits.deceleration * SAFETY),
      freeSpeeds: linear.intervals.map((limits) => limits.freeSpeed),
      accelerationConstraints: intervalProjections.map((projection) => projection.accelerationConstraints),
      startVelocity, goalVelocity,
    });
    if (solved.status !== 'optimal') return solved;
    const remapped = timing(points, solved.velocities);
    const validation = validate(doc, robot, points, linear, validationProjections, remapped.velocities, remapped.times, remapped.omegas, ranges, translationStart);
    return {
      status: validation.violations.length ? 'internal-error' : translationStart == null ? 'optimal' : 'feasible',
      velocities: remapped.velocities,
      times: remapped.times,
      violations: validation.violations,
      refinable: validation.violations.length > 0 && validation.violations.every((violation) => violation.refinable),
      activeConstraints: validation.activeConstraints,
      translationPriorityStart: translationStart,
      iterations: (pts.length - 1) * 2,
    };
  }

  function evaluateModule(point, robot, velocity, acceleration, omega, alpha) {
    const cos = Math.cos(point.heading), sin = Math.sin(point.heading);
    return moduleOffsets(robot).map((module) => {
      const offsetX = cos * module.x - sin * module.y;
      const offsetY = sin * module.x + cos * module.y;
      const perpendicularX = -offsetY, perpendicularY = offsetX;
      return {
        speed: Math.hypot(point.tangentX * velocity + omega * perpendicularX, point.tangentY * velocity + omega * perpendicularY),
        acceleration: Math.hypot(
          point.tangentX * acceleration + point.curvature * point.normalX * velocity ** 2 + alpha * perpendicularX - omega ** 2 * offsetX,
          point.tangentY * acceleration + point.curvature * point.normalY * velocity ** 2 + alpha * perpendicularY - omega ** 2 * offsetY,
        ),
      };
    });
  }

  function validateFollowed(doc, robot, pts, trackedHead, profile, ranges, waypointIndices) {
    const totalDistance = pts.length ? pts[pts.length - 1].s : 0;
    const boundaryPoints = pts.map((point) => ({
      ...point,
      s: R(point.s, 4),
      f: R(totalDistance > EPSILON ? point.s / totalDistance : 0, 5),
      x: R(point.x, 4),
      y: R(point.y, 4),
    }));
    const points = canonicalState(doc, boundaryPoints, trackedHead, waypointIndices);
    const velocities = profile.v.map((velocity) => R(velocity, 4));
    const times = profile.t.map((time) => R(time, 4));
    const omegas = points.map((point, index) => index === 0
      ? 0
      : (point.heading - points[index - 1].heading) / Math.max(EPSILON, times[index] - times[index - 1]));
    const violations = [];
    const stationaryTurn = (point) => point.stop && point.waypointIndex != null
      && doc.waypoints[point.waypointIndex] && doc.waypoints[point.waypointIndex].turnInPlace;
    for (let index = 0; index < points.length; index++) {
      const angular = angularLimits(doc, activeRanges(ranges, points[index].f));
      if (!stationaryTurn(points[index]) && Math.abs(omegas[index]) > angular.velocity + tolerance(angular.velocity, 2e-3, 0.02)) {
        violations.push({ kind: 'angular-velocity', index, measured: Math.abs(omegas[index]), limit: angular.velocity });
      }
      evaluateModule(points[index], robot, velocities[index], 0, omegas[index], 0).forEach((module) => {
        if (module.speed > robot.maxSpeed + tolerance(robot.maxSpeed)) violations.push({ kind: 'drivetrain-velocity', index, measured: module.speed, limit: robot.maxSpeed });
      });
    }
    for (let index = 0; index < points.length - 1; index++) {
      const distance = points[index + 1].s - points[index].s;
      if (distance <= EPSILON || stationaryTurn(points[index]) || stationaryTurn(points[index + 1])) continue;
      const dt = times[index + 1] - times[index];
      const acceleration = (velocities[index + 1] ** 2 - velocities[index] ** 2) / (2 * distance);
      const speed = Math.sqrt(Math.max(0, (velocities[index] ** 2 + velocities[index + 1] ** 2) * 0.5));
      const omega = (omegas[index] + omegas[index + 1]) * 0.5;
      const alpha = (omegas[index + 1] - omegas[index]) / Math.max(EPSILON, dt);
      const angular = angularLimits(doc, ranges.filter((range) => overlaps(range, points[index].f, points[index + 1].f)));
      const reversing = Math.sign(omegas[index + 1]) && Math.sign(omegas[index]) && Math.sign(omegas[index + 1]) !== Math.sign(omegas[index]);
      const alphaLimit = reversing ? Math.min(angular.acceleration, angular.deceleration) : Math.abs(omegas[index + 1]) >= Math.abs(omegas[index]) ? angular.acceleration : angular.deceleration;
      if (Math.abs(alpha) > alphaLimit + tolerance(alphaLimit, 2e-3, 0.02)) violations.push({ kind: 'angular-acceleration', index: index + 1, measured: Math.abs(alpha), limit: alphaLimit });
      const linear = limitsForRanges(doc, robot, ranges.filter((range) => overlaps(range, points[index].f, points[index + 1].f)));
      const midpoint = interpolate(points[index], points[index + 1]);
      evaluateModule(midpoint, robot, speed, acceleration, omega, alpha).forEach((module) => {
        const accelerationLimit = doc.constraints.maxCentripetalAccel || linear.acceleration;
        if (module.speed > robot.maxSpeed + tolerance(robot.maxSpeed)) violations.push({ kind: 'drivetrain-velocity', index: index + 1, measured: module.speed, limit: robot.maxSpeed });
        if (module.acceleration > accelerationLimit + tolerance(accelerationLimit)) violations.push({ kind: 'drivetrain-acceleration', index: index + 1, measured: module.acceleration, limit: accelerationLimit });
      });
    }
    return violations;
  }

  window.TrajectoryOptimizer = { optimize, validateFollowed };
})();
