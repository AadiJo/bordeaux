// Bordeaux fixed-path reachability mirror for the static renderer.
(function () {
  const EPSILON = 1e-9;
  const CONTROLLABLE_TOLERANCE = 1e-9;
  const SAFETY = 0.99;
  const DRIVETRAIN_SAFETY = 0.95;
  const MODULE_MOTOR_SAFETY = 0.95;
  const ACTIVE = 0.995;
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

  function canonicalState(doc, pts, head, waypointIndices, headingBreakIndex, syntheticStops) {
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
    const headingBreaks = new Set(stopped);
    if (headingBreakIndex != null) headingBreaks.add(headingBreakIndex);
    (syntheticStops || []).forEach((index) => headingBreaks.add(index));
    const headingDerivatives = derivative(headings, positions, headingBreaks);
    const headingSecondDerivatives = derivative(headingDerivatives, positions, headingBreaks);
    const waypointBySample = new Map();
    waypointIndices.forEach((sampleIndex, waypointIndex) => {
      if (!waypointBySample.has(sampleIndex)) waypointBySample.set(sampleIndex, waypointIndex);
    });
    return pts.map((point, index) => {
      const length = Math.hypot(tangentXRaw[index], tangentYRaw[index]);
      const tangentX = length > EPSILON ? tangentXRaw[index] / length : Math.cos(tangentAngles[index]);
      const tangentY = length > EPSILON ? tangentYRaw[index] / length : Math.sin(tangentAngles[index]);
      const sampledCurvature = Math.abs(point.curv || 0);
      const derivedCurvature = curvatures[index];
      const curvatureSign = Math.sign(derivedCurvature) || 1;
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
        curvature: curvatureSign * Math.max(Math.abs(derivedCurvature), sampledCurvature),
        heading: headings[index],
        headingDerivative: headingDerivatives[index],
        headingSecondDerivative: headingSecondDerivatives[index],
        waypointIndex: waypointBySample.get(index),
        stop: stopped.has(index) || (syntheticStops && syntheticStops.has(index)),
      };
    });
  }

  function findDynamicHeadingStops(points, waypointIndices, stopAtIndex) {
    const result = new Set();
    waypointIndices.slice(1, -1).forEach((sampleIndex) => {
      if (stopAtIndex != null && sampleIndex >= stopAtIndex) return;
      const before = points[sampleIndex - 1], point = points[sampleIndex], after = points[sampleIndex + 1];
      if (!before || !point || !after || point.stop) return;
      const beforeDistance = point.s - before.s, afterDistance = after.s - point.s;
      if (beforeDistance <= EPSILON || afterDistance <= EPSILON) return;
      const incomingRate = (point.heading - before.heading) / beforeDistance;
      const outgoingRate = (after.heading - point.heading) / afterDistance;
      if (Math.abs(outgoingRate - incomingRate) > 0.05) result.add(sampleIndex);
    });
    return result;
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
    const first = range.f0 != null ? range.f0 : range.start;
    const second = range.f1 != null ? range.f1 : range.end;
    const low = Math.min(first, second), high = Math.max(first, second);
    return Math.min(end, high) - Math.max(start, low) > EPSILON;
  }

  function insertBoundaries(doc, pts, head, ranges, waypointIndices, transitions) {
    if (pts.length < 2) return { pts, head, waypointIndices };
    const total = pts[pts.length - 1].s || 0;
    const boundaries = [...ranges.flatMap((range) => [range.f0, range.f1]), ...transitions.flatMap((transition) => [transition.start, transition.end])]
      .filter((fraction) => fraction > EPSILON && fraction < 1 - EPSILON)
      .sort((left, right) => left - right)
      .filter((fraction, index, values) => index === 0 || Math.abs(fraction - values[index - 1]) > EPSILON);
    const missing = boundaries.filter((fraction) => !pts.some((point) => Math.abs(point.s / Math.max(total, EPSILON) - fraction) <= EPSILON));
    if (pts.length + missing.length > 250000) throw new Error('Optimization boundaries require more than 250000 trajectory samples');
    const nextPoints = [...pts];
    const nextHead = [...head];
    const nextWaypointIndices = [...waypointIndices];
    for (const fraction of missing) {
      const target = fraction * total;
      const afterIndex = nextPoints.findIndex((point) => point.s > target);
      if (afterIndex <= 0) continue;
      const before = nextPoints[afterIndex - 1], after = nextPoints[afterIndex];
      const ratio = (target - before.s) / Math.max(EPSILON, after.s - before.s);
      const mix = (first, second) => first + (second - first) * ratio;
      const headingDelta = Math.atan2(Math.sin(nextHead[afterIndex] - nextHead[afterIndex - 1]), Math.cos(nextHead[afterIndex] - nextHead[afterIndex - 1]));
      nextPoints.splice(afterIndex, 0, {
        ...before,
        x: mix(before.x, after.x),
        y: mix(before.y, after.y),
        s: target,
        heading: mix(before.heading || 0, after.heading || 0),
        curv: mix(before.curv || 0, after.curv || 0),
        t: before.seg === after.seg ? mix(before.t || 0, after.t || 0) : before.t,
      });
      nextHead.splice(afterIndex, 0, nextHead[afterIndex - 1] + headingDelta * ratio);
      for (let index = 0; index < nextWaypointIndices.length; index++) {
        if (nextWaypointIndices[index] >= afterIndex) nextWaypointIndices[index] += 1;
      }
    }
    return { pts: nextPoints, head: nextHead, waypointIndices: nextWaypointIndices };
  }

  function activeRanges(ranges, fraction) {
    return ranges.filter((range) => fraction >= Math.min(range.f0, range.f1) - EPSILON
      && fraction <= Math.max(range.f0, range.f1) + EPSILON);
  }

  function limitsForRanges(doc, robot, ranges) {
    const velocityCap = Math.max(0.01, robot.maxSpeed || doc.constraints.maxVel || 0.01);
    const hardLimits = window.PM.robotHardLimits(robot);
    const freeSpeed = hardLimits ? velocityCap : 1e9;
    const motorAcceleration = hardLimits ? hardLimits.motorAccel : 1e9;
    let velocity = Math.max(0.01, Math.min(velocityCap, doc.constraints.maxVel || velocityCap));
    let acceleration = Math.max(0.01, doc.constraints.maxAccel || 0.01);
    let deceleration = Math.max(0.01, doc.constraints.maxDecel || doc.constraints.maxAccel || 0.01);
    ranges.forEach((range) => {
      if (range.maxVel > 0) velocity = Math.min(velocity, range.maxVel);
      if (range.maxAccel > 0) acceleration = Math.min(acceleration, range.maxAccel);
      const rangeDeceleration = range.maxDecel || range.maxAccel;
      if (rangeDeceleration > 0) deceleration = Math.min(deceleration, rangeDeceleration);
    });
    return { freeSpeed, motorAcceleration, velocity, acceleration, deceleration };
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
    const policyOverlaps = (range, before, after) => {
      const start = Math.min(before, after), end = Math.max(before, after);
      const first = range.f0 != null ? range.f0 : range.start;
      const second = range.f1 != null ? range.f1 : range.end;
      return Math.min(end, Math.max(first, second)) - Math.max(start, Math.min(first, second)) >= -EPSILON;
    };
    for (let index = 1; index < points.length; index++) {
      const active = ranges.filter((range) => policyOverlaps(range, points[index - 1].f, points[index].f));
      const activeTransitions = transitions.filter((range) => policyOverlaps(range, points[index - 1].f, points[index].f));
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

  function project(point, robot, accelerationLimit, motorSafety) {
    const velocityConstraints = [], accelerationConstraints = [], motorAccelerationConstraints = [];
    let velocityLimit = Math.max(0.01, robot.maxSpeed);
    const hardLimits = window.PM.robotHardLimits(robot);
    motorSafety = motorSafety == null ? 1 : motorSafety;
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
      accelerationConstraints.push({
        uX, uY, xX, xY,
        limit: Math.max(0.01, accelerationLimit),
        label: module.label,
      });
      if (hardLimits && coefficient > EPSILON) {
        const motorAcceleration = hardLimits.motorAccel * motorSafety;
        motorAccelerationConstraints.push({
          u: coefficient,
          x: (uX * xX + uY * xY) / coefficient,
          minimum: -motorAcceleration,
          maximum: motorAcceleration,
          velocityCoefficient: coefficient,
          freeSpeed: hardLimits.maxSpeed,
          motorAcceleration,
          label: module.label,
        });
      }
      const constantSpeed = Math.hypot(xX, xY);
      if (constantSpeed > EPSILON) {
        velocityLimit = Math.min(velocityLimit, Math.sqrt(Math.max(0, accelerationLimit) / constantSpeed));
      }
    });
    return { velocityLimit, velocityConstraints, accelerationConstraints, motorAccelerationConstraints };
  }

  function accelerationBounds(constraints, speedSquared, scalarConstraints, envelopeSquared) {
    envelopeSquared = envelopeSquared == null ? speedSquared : envelopeSquared;
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
    (scalarConstraints || []).forEach((constraint) => {
      if (minimum > maximum + EPSILON) return;
      const offset = constraint.x * speedSquared;
      const moduleSpeed = (constraint.velocityCoefficient || 0) * Math.sqrt(Math.max(0, envelopeSquared));
      const motorLimit = constraint.freeSpeed > 0 && constraint.motorAcceleration > 0
        ? constraint.motorAcceleration * Math.max(0, 1 - moduleSpeed / constraint.freeSpeed)
        : Infinity;
      const constraintMinimum = Math.max(constraint.minimum, -motorLimit);
      const constraintMaximum = Math.min(constraint.maximum, motorLimit);
      if (Math.abs(constraint.u) <= EPSILON) {
        if (offset < constraintMinimum - EPSILON || offset > constraintMaximum + EPSILON) minimum = Infinity;
        return;
      }
      const first = (constraintMinimum - offset) / constraint.u;
      const second = (constraintMaximum - offset) / constraint.u;
      minimum = Math.max(minimum, Math.min(first, second));
      maximum = Math.min(maximum, Math.max(first, second));
    });
    if (minimum > maximum + EPSILON) return null;
    return { minimum, maximum };
  }

  function intervalBounds(constraints, startSquared, distance, scalarConstraints, envelopeSquared) {
    return accelerationBounds(constraints.map((constraint) => ({
      ...constraint,
      uX: constraint.uX + constraint.xX * distance,
      uY: constraint.uY + constraint.xY * distance,
    })), startSquared, (scalarConstraints || []).map((constraint) => ({
      ...constraint,
      ...(envelopeSquared == null ? { velocityCoefficient: undefined, freeSpeed: undefined, motorAcceleration: undefined } : {}),
      u: constraint.u + constraint.x * distance,
    })), envelopeSquared == null ? startSquared : envelopeSquared);
  }

  function tightenMotorBounds(constraints, startSquared, distance, bounds) {
    const dynamic = constraints.filter((constraint) => constraint.velocityCoefficient > 0 && constraint.freeSpeed > 0 && constraint.motorAcceleration > 0);
    if (!dynamic.length) return bounds;
    const gap = (acceleration) => {
      const midpointSquared = Math.max(0, startSquared + acceleration * distance);
      const endSquared = Math.max(0, startSquared + 2 * acceleration * distance);
      const envelopeSpeed = Math.sqrt(Math.max(startSquared, endSquared));
      return dynamic.reduce((maximum, constraint) => {
        const moduleSpeed = constraint.velocityCoefficient * envelopeSpeed;
        const limit = constraint.motorAcceleration * Math.max(0, 1 - moduleSpeed / constraint.freeSpeed);
        const measured = Math.abs(constraint.u * acceleration + constraint.x * midpointSquared);
        return Math.max(maximum, measured - limit);
      }, -Infinity);
    };
    const tolerance = 1e-9 * Math.max(1, ...dynamic.map((constraint) => constraint.motorAcceleration));
    const roots = (a, b, c) => {
      if (Math.abs(a) <= EPSILON) return Math.abs(b) <= EPSILON ? [] : [-c / b];
      const discriminant = b ** 2 - 4 * a * c;
      if (discriminant < 0) return [];
      const root = Math.sqrt(Math.max(0, discriminant));
      return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
    };
    const critical = [bounds.minimum, bounds.maximum, Math.max(bounds.minimum, Math.min(bounds.maximum, 0))];
    dynamic.forEach((constraint) => {
      const coefficient = constraint.u + constraint.x * distance;
      const offset = constraint.x * startSquared;
      const stallAtStart = constraint.motorAcceleration * Math.max(0, 1 - constraint.velocityCoefficient * Math.sqrt(startSquared) / constraint.freeSpeed);
      if (Math.abs(coefficient) > EPSILON) critical.push((-stallAtStart - offset) / coefficient, (stallAtStart - offset) / coefficient);
      const quadratic = coefficient / (2 * distance);
      const constant = offset - quadratic * startSquared;
      const linear = constraint.motorAcceleration * constraint.velocityCoefficient / constraint.freeSpeed;
      critical.push(((constraint.freeSpeed / constraint.velocityCoefficient) ** 2 - startSquared) / (2 * distance));
      [...roots(quadratic, linear, constant - constraint.motorAcceleration), ...roots(-quadratic, linear, -constant - constraint.motorAcceleration)].forEach((velocity) => {
        if (velocity >= 0) critical.push((velocity ** 2 - startSquared) / (2 * distance));
      });
    });
    const values = critical
      .filter((value) => Number.isFinite(value) && value >= bounds.minimum - EPSILON && value <= bounds.maximum + EPSILON)
      .map((value) => Math.max(bounds.minimum, Math.min(bounds.maximum, value)))
      .sort((left, right) => left - right)
      .filter((value, index, all) => index === 0 || Math.abs(value - all[index - 1]) > 1e-10);
    const segments = [];
    const addSegment = (minimum, maximum) => {
      const previous = segments[segments.length - 1];
      if (previous && minimum <= previous.maximum + 1e-8) previous.maximum = Math.max(previous.maximum, maximum);
      else segments.push({ minimum, maximum });
    };
    values.forEach((value, index) => {
      if (gap(value) <= tolerance) addSegment(value, value);
      const next = values[index + 1];
      if (next != null && gap((value + next) * 0.5) <= tolerance) addSegment(value, next);
    });
    if (!segments.length) return null;
    const selected = segments.find((segment) => segment.minimum <= 0 && segment.maximum >= 0)
      || segments.reduce((best, segment) => segment.maximum - segment.minimum > best.maximum - best.minimum ? segment : best);
    const center = (selected.minimum + selected.maximum) * 0.5;
    let minimum = selected.minimum;
    if (gap(minimum) > tolerance) {
      let infeasible = minimum, feasible = center;
      for (let iteration = 0; iteration < 32; iteration++) { const candidate = (infeasible + feasible) * 0.5; if (gap(candidate) <= tolerance) feasible = candidate; else infeasible = candidate; }
      minimum = feasible;
    }
    let maximum = selected.maximum;
    if (gap(maximum) > tolerance) {
      let feasible = center, infeasible = maximum;
      for (let iteration = 0; iteration < 32; iteration++) { const candidate = (feasible + infeasible) * 0.5; if (gap(candidate) <= tolerance) feasible = candidate; else infeasible = candidate; }
      maximum = feasible;
    }
    return { minimum, maximum };
  }

  function solve(input) {
    const count = input.positions.length;
    const squaredLimits = input.velocityLimits.map((velocity) => velocity ** 2);
    const controllable = new Array(count);
    controllable[count - 1] = { minimum: input.goalVelocity ** 2, maximum: input.goalVelocity ** 2 };
    const controlBounds = (index, speedSquared, distance) => {
      const bounds = intervalBounds(input.accelerationConstraints[index], speedSquared, distance, input.scalarAccelerationConstraints[index]);
      if (!bounds) return null;
      const minimum = Math.max(-input.decelerationLimits[index], bounds.minimum);
      let maximum = Math.min(input.accelerationLimits[index], bounds.maximum);
      if (maximum > 0 && input.freeSpeeds[index] < 1e8) {
        const motorAcceleration = input.motorAccelerationLimits[index];
        const coefficient = 2 * distance * motorAcceleration / input.freeSpeeds[index];
        const endVelocity = Math.max(0, (
          Math.sqrt(coefficient ** 2 + 4 * (speedSquared + 2 * distance * motorAcceleration)) - coefficient
        ) * 0.5);
        const motorLimitedAcceleration = distance > EPSILON
          ? (endVelocity ** 2 - speedSquared) / (2 * distance)
          : motorAcceleration * Math.max(0, 1 - Math.sqrt(Math.max(0, speedSquared)) / input.freeSpeeds[index]);
        maximum = Math.min(maximum, Math.max(0, motorLimitedAcceleration));
      }
      if (minimum > maximum + EPSILON) return null;
      return tightenMotorBounds(input.scalarAccelerationConstraints[index], speedSquared, distance, { minimum, maximum });
    };
    for (let index = count - 2; index >= 0; index--) {
      const distance = Math.max(0, input.positions[index + 1] - input.positions[index]);
      if (distance <= EPSILON) {
        const minimum = Math.max(0, controllable[index + 1].minimum);
        const maximum = Math.min(squaredLimits[index], controllable[index + 1].maximum);
        if (minimum > maximum + EPSILON) return { status: 'infeasible', reason: 'Zero-distance interval requires incompatible velocities.', velocities: [] };
        controllable[index] = { minimum, maximum };
        continue;
      }
      const motorLimitAtPointCap = input.freeSpeeds[index] >= 1e8
        ? Infinity
        : input.motorAccelerationLimits[index]
          * Math.max(0, Math.min(1, 1 - Math.sqrt(Math.max(squaredLimits[index], controllable[index + 1].maximum)) / input.freeSpeeds[index]));
      const hasModuleMotorEnvelope = input.scalarAccelerationConstraints[index].some((constraint) => constraint.velocityCoefficient != null);
      if (input.accelerationConstraints[index].length === 0
        && !hasModuleMotorEnvelope
        && motorLimitAtPointCap >= input.accelerationLimits[index] - EPSILON) {
        let minimum = 0, maximum = squaredLimits[index];
        const lower = [
          { slope: 0, intercept: -input.decelerationLimits[index] },
          { slope: -1 / (2 * distance), intercept: controllable[index + 1].minimum / (2 * distance) },
        ];
        const upper = [
          { slope: 0, intercept: input.accelerationLimits[index] },
          { slope: -1 / (2 * distance), intercept: controllable[index + 1].maximum / (2 * distance) },
        ];
        let invalid = false;
        input.scalarAccelerationConstraints[index].forEach((constraint) => {
          if (invalid) return;
          const coefficient = constraint.u + constraint.x * distance;
          if (Math.abs(coefficient) <= EPSILON) {
            if (Math.abs(constraint.x) <= EPSILON) {
              if (constraint.minimum > EPSILON || constraint.maximum < -EPSILON) invalid = true;
            } else {
              const first = constraint.minimum / constraint.x, second = constraint.maximum / constraint.x;
              minimum = Math.max(minimum, Math.min(first, second));
              maximum = Math.min(maximum, Math.max(first, second));
            }
          } else {
            const slope = -constraint.x / coefficient;
            const first = constraint.minimum / coefficient, second = constraint.maximum / coefficient;
            lower.push({ slope, intercept: Math.min(first, second) });
            upper.push({ slope, intercept: Math.max(first, second) });
          }
        });
        lower.forEach((low) => upper.forEach((high) => {
          if (invalid) return;
          const coefficient = low.slope - high.slope, limit = high.intercept - low.intercept;
          if (Math.abs(coefficient) <= EPSILON) {
            if (limit < -EPSILON) invalid = true;
          } else if (coefficient > 0) maximum = Math.min(maximum, limit / coefficient);
          else minimum = Math.max(minimum, limit / coefficient);
        }));
        minimum = Math.max(0, minimum); maximum = Math.min(squaredLimits[index], maximum);
        if (invalid) return { status: 'infeasible', reason: 'Drivetrain acceleration bounds are empty.', velocities: [] };
        if (minimum > maximum + EPSILON) return { status: 'infeasible', reason: 'Velocity caps require impossible acceleration.', velocities: [] };
        controllable[index] = { minimum, maximum };
        continue;
      }
      const scale = 2 * distance;
      const controllableTolerance = CONTROLLABLE_TOLERANCE * Math.max(
        1,
        input.accelerationLimits[index],
        input.decelerationLimits[index],
        input.motorAccelerationLimits[index],
        squaredLimits[index] / scale,
        controllable[index + 1].maximum / scale,
      );
      const gap = (candidate) => {
        const control = controlBounds(index, candidate, distance);
        if (!control) return Infinity;
        return Math.max(control.minimum, (controllable[index + 1].minimum - candidate) / scale)
          - Math.min(control.maximum, (controllable[index + 1].maximum - candidate) / scale);
      };
      let left = 0, right = squaredLimits[index];
      for (let iteration = 0; iteration < 56; iteration++) {
        const first = (left * 2 + right) / 3, second = (left + right * 2) / 3;
        if (gap(first) <= gap(second)) right = second; else left = first;
      }
      const candidates = [0, squaredLimits[index], left, right, (left + right) * 0.5];
      const center = candidates.reduce((best, candidate) => gap(candidate) < gap(best) ? candidate : best, candidates[0]);
      const centerGap = gap(center);
      if (centerGap > controllableTolerance) return { status: 'infeasible', reason: 'Drivetrain acceleration bounds are empty.', velocities: [] };
      const boundaryTolerance = centerGap <= 0 ? 0 : controllableTolerance;
      let minimum = 0, maximum = squaredLimits[index];
      if (gap(minimum) > boundaryTolerance) {
        let infeasible = minimum, feasible = center;
        for (let iteration = 0; iteration < 56; iteration++) { const candidate = (infeasible + feasible) * 0.5; if (gap(candidate) <= boundaryTolerance) feasible = candidate; else infeasible = candidate; }
        minimum = feasible;
      }
      if (gap(maximum) > boundaryTolerance) {
        let feasible = center, infeasible = maximum;
        for (let iteration = 0; iteration < 56; iteration++) { const candidate = (feasible + infeasible) * 0.5; if (gap(candidate) <= boundaryTolerance) feasible = candidate; else infeasible = candidate; }
        maximum = feasible;
      }
      controllable[index] = { minimum: Math.max(0, minimum), maximum: Math.min(squaredLimits[index], maximum) };
    }
    const startSquared = input.startVelocity ** 2;
    if (startSquared < controllable[0].minimum - 1e-8 || startSquared > controllable[0].maximum + 1e-8) return { status: 'infeasible', reason: 'Start velocity cannot reach the authored stops and goal.', velocities: [] };
    const speedSquared = new Array(count).fill(0); speedSquared[0] = startSquared;
    for (let index = 0; index < count - 1; index++) {
      const distance = Math.max(0, input.positions[index + 1] - input.positions[index]);
      if (distance <= EPSILON) { speedSquared[index + 1] = speedSquared[index]; continue; }
      const control = controlBounds(index, speedSquared[index], distance);
      if (!control) return { status: 'infeasible', reason: 'Drivetrain acceleration bounds are empty.', velocities: [] };
      const reachableMinimum = speedSquared[index] + 2 * control.minimum * distance;
      const reachableMaximum = speedSquared[index] + 2 * control.maximum * distance;
      const nextMinimum = Math.max(controllable[index + 1].minimum, reachableMinimum, 0);
      const nextMaximum = Math.min(controllable[index + 1].maximum, reachableMaximum, squaredLimits[index + 1]);
      if (nextMinimum > nextMaximum + 1e-7) return { status: 'infeasible', reason: 'Velocity caps require impossible acceleration.', velocities: [] };
      speedSquared[index + 1] = nextMaximum;
    }
    if (speedSquared[count - 1] < input.goalVelocity ** 2 - 1e-8) return { status: 'infeasible', reason: 'Goal velocity is unreachable.', velocities: [] };
    speedSquared[count - 1] = input.goalVelocity ** 2;
    for (let index = 0; index < count - 1; index++) {
      if (input.positions[index + 1] - input.positions[index] > EPSILON
        && speedSquared[index] + speedSquared[index + 1] <= EPSILON) {
        return { status: 'invalid-input', reason: 'A moving interval is pinned between stopped samples.', velocities: [], refinable: true };
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
      : R((point.heading - points[index - 1].heading) / Math.max(EPSILON, times[index] - times[index - 1]), 7));
    return { velocities: velocities.map((value) => R(value, 6)), times: times.map((value) => R(value, 6)), omegas };
  }

  function tolerance(limit, absolute, relative) {
    return Math.max(absolute == null ? 1e-3 : absolute, Math.abs(limit) * (relative == null ? 2e-3 : relative));
  }

  function validate(doc, robot, points, linear, pointProjections, intervalProjections, velocities, times, omegas, ranges, skipAngularFrom) {
    const violations = [], active = new Set();
    const add = (kind, index, measured, limit, refinable) => violations.push({ kind, index, measured, limit, refinable });
    const stationaryTurn = (point) => point.stop && point.waypointIndex != null
      && doc.waypoints[point.waypointIndex] && doc.waypoints[point.waypointIndex].turnInPlace;
    const expectedStart = doc.waypoints[0].stop ? 0 : Math.min(linear.points[0].velocity, Math.max(0, doc.startVel || 0));
    const expectedGoal = doc.waypoints[doc.waypoints.length - 1].stop ? 0 : Math.min(linear.points[linear.points.length - 1].velocity, Math.max(0, doc.goalVel || 0));
    if (Math.abs(velocities[0] - expectedStart) > tolerance(expectedStart, 2e-4, 2e-4)) add('boundary-velocity', 0, velocities[0], expectedStart, false);
    if (Math.abs(velocities[velocities.length - 1] - expectedGoal) > tolerance(expectedGoal, 2e-4, 2e-4)) add('boundary-velocity', velocities.length - 1, velocities[velocities.length - 1], expectedGoal, false);
    for (let index = 0; index < points.length; index++) {
      const limit = Math.min(linear.points[index].velocity, linear.intervals[index - 1] ? linear.intervals[index - 1].velocity : Infinity, linear.intervals[index] ? linear.intervals[index].velocity : Infinity);
      if (velocities[index] > limit + tolerance(limit, 1e-4, 1e-4)) add('linear-velocity', index, velocities[index], limit, false);
      if (velocities[index] >= limit * ACTIVE) active.add('linear-velocity');
      const drivetrainLimit = pointProjections[index].velocityLimit;
      if (velocities[index] > drivetrainLimit + tolerance(drivetrainLimit)) add('drivetrain-velocity', index, velocities[index], drivetrainLimit, false);
      if (drivetrainLimit > EPSILON && velocities[index] >= drivetrainLimit * ACTIVE) active.add('drivetrain-velocity');
      if ((skipAngularFrom == null || index < skipAngularFrom) && !stationaryTurn(points[index])) {
        const angular = angularLimits(doc, activeRanges(ranges, points[index].f));
        const omega = points[index].headingDerivative * velocities[index];
        if (Math.abs(omega) > angular.velocity + tolerance(angular.velocity, 2e-3, 0.02)) add('angular-velocity', index, Math.abs(omega), angular.velocity, false);
        if (angular.velocity > EPSILON && Math.abs(omega) >= angular.velocity * ACTIVE) active.add('angular-velocity');
      }
    }
    for (let index = 0; index < points.length - 1; index++) {
      const distance = points[index + 1].s - points[index].s;
      if (distance <= EPSILON) continue;
      const beforeSquared = velocities[index] ** 2, afterSquared = velocities[index + 1] ** 2;
      const speedSquared = (beforeSquared + afterSquared) * 0.5;
      const acceleration = (afterSquared - beforeSquared) / (2 * distance);
      const interval = linear.intervals[index];
      const motor = Math.min(interval.acceleration, interval.motorAcceleration * Math.max(0, Math.min(1, 1 - Math.max(velocities[index], velocities[index + 1]) / interval.freeSpeed)));
      if (acceleration >= 0 && acceleration > motor + tolerance(motor, 2e-3, 0.01)) add('linear-acceleration', index + 1, acceleration, motor, true);
      if (acceleration < 0 && -acceleration > interval.deceleration + tolerance(interval.deceleration, 2e-3, 0.01)) add('linear-deceleration', index + 1, -acceleration, interval.deceleration, true);
      if (acceleration >= 0 && motor > EPSILON && acceleration >= motor * ACTIVE) active.add('linear-acceleration');
      if (acceleration < 0 && interval.deceleration > EPSILON && -acceleration >= interval.deceleration * ACTIVE) active.add('linear-deceleration');
      const midpoint = interpolate(points[index], points[index + 1]);
      const lateralLimit = doc.constraints.maxCentripetalAccel || interval.acceleration;
      const centripetalAcceleration = speedSquared * Math.abs(midpoint.curvature);
      if (centripetalAcceleration > lateralLimit + tolerance(lateralLimit)) add('centripetal-acceleration', index + 1, centripetalAcceleration, lateralLimit, true);
      if (lateralLimit > EPSILON && centripetalAcceleration >= lateralLimit * ACTIVE) active.add('centripetal-acceleration');
      const bounds = accelerationBounds(intervalProjections[index].accelerationConstraints, speedSquared);
      if (!bounds || acceleration < bounds.minimum - tolerance(Math.abs(bounds ? bounds.minimum : 0)) || acceleration > bounds.maximum + tolerance(Math.abs(bounds ? bounds.maximum : 0))) add('drivetrain-acceleration', index + 1, Math.abs(acceleration), bounds ? Math.max(Math.abs(bounds.minimum), Math.abs(bounds.maximum)) : 0, true);
      const speed = Math.sqrt(Math.max(0, speedSquared));
      if (speed > intervalProjections[index].velocityLimit + tolerance(intervalProjections[index].velocityLimit)) add('drivetrain-velocity', index + 1, speed, intervalProjections[index].velocityLimit, true);
      intervalProjections[index].velocityConstraints.forEach((constraint) => {
        if (constraint.limit > EPSILON && constraint.coefficient * speed >= constraint.limit * ACTIVE) active.add(constraint.label);
      });
      if (bounds) {
        intervalProjections[index].accelerationConstraints.forEach((constraint) => {
          const measured = Math.hypot(
            constraint.uX * acceleration + constraint.xX * speedSquared,
            constraint.uY * acceleration + constraint.xY * speedSquared,
          );
          if (measured >= constraint.limit * 0.94) active.add(constraint.label);
        });
      }
      intervalProjections[index].motorAccelerationConstraints.forEach((constraint) => {
        const moduleSpeed = constraint.velocityCoefficient * speed;
        const motorLimit = constraint.motorAcceleration * Math.max(0, 1 - moduleSpeed / constraint.freeSpeed);
        const measured = Math.abs(constraint.u * acceleration + constraint.x * speedSquared);
        if (measured > motorLimit + tolerance(motorLimit)) add('drivetrain-acceleration', index + 1, measured, motorLimit, true);
        if (measured >= motorLimit * 0.94) active.add(constraint.label);
      });
      if ((skipAngularFrom == null || index + 1 < skipAngularFrom) && !stationaryTurn(points[index]) && !stationaryTurn(points[index + 1])) {
        const angular = angularLimits(doc, ranges.filter((range) => overlaps(range, points[index].f, points[index + 1].f)));
        const omega = midpoint.headingDerivative * speed;
        if (Math.abs(omega) > angular.velocity + tolerance(angular.velocity, 2e-3, 0.02)) add('angular-velocity', index + 1, Math.abs(omega), angular.velocity, false);
        const signedAlpha = midpoint.headingDerivative * acceleration + midpoint.headingSecondDerivative * speedSquared;
        const direction = Math.sign(midpoint.headingDerivative);
        const magnitudeAcceleration = direction === 0 ? Math.abs(signedAlpha) : direction * signedAlpha;
        const alphaLimit = magnitudeAcceleration >= 0 ? angular.acceleration : angular.deceleration;
        const alpha = Math.abs(signedAlpha);
        if (alpha > alphaLimit + tolerance(alphaLimit, 2e-3, 0.02)) add('angular-acceleration', index + 1, alpha, alphaLimit, true);
        if (alphaLimit > EPSILON && alpha >= alphaLimit * ACTIVE) active.add('angular-acceleration');
      }
    }
    return { violations, activeConstraints: Array.from(active).sort() };
  }

  function optimize(doc, robot, pts, head, baseProfile, ranges, waypointIndices, transitions) {
    if ((doc.constraints.maxJerk || 0) > 0) return { status: 'invalid-input', reason: 'Optimized preview does not support nonzero translational jerk.' };
    const totalDistance = pts.length ? pts[pts.length - 1].s : 0;
    const boundaryPoints = pts.map((point) => ({
      ...point,
      f: totalDistance > EPSILON ? point.s / totalDistance : 0,
    }));
    const boundaryHead = head.map((heading) => heading + (doc.driveBackward ? Math.PI : 0));
    const translationStart = translationPriorityStart(ranges, transitions, boundaryPoints);
    let points = canonicalState(doc, boundaryPoints, boundaryHead, waypointIndices, translationStart);
    const dynamicHeadingStops = findDynamicHeadingStops(points, waypointIndices, translationStart);
    points = canonicalState(doc, boundaryPoints, boundaryHead, waypointIndices, translationStart, dynamicHeadingStops);
    const linear = {
      points: points.map((point) => limitsForRanges(doc, robot, activeRanges(ranges, point.f))),
      intervals: points.slice(1).map((point, index) => limitsForRanges(doc, robot, ranges.filter((range) => overlaps(range, points[index].f, point.f)))),
    };
    const pointProjections = points.map((point, index) => project(point, robot, (doc.constraints.maxCentripetalAccel || Math.min(linear.intervals[index - 1] ? linear.intervals[index - 1].acceleration : Infinity, linear.intervals[index] ? linear.intervals[index].acceleration : Infinity)) * DRIVETRAIN_SAFETY, MODULE_MOTOR_SAFETY));
    const validationPointProjections = points.map((point, index) => project(point, robot, doc.constraints.maxCentripetalAccel || Math.min(linear.intervals[index - 1] ? linear.intervals[index - 1].acceleration : Infinity, linear.intervals[index] ? linear.intervals[index].acceleration : Infinity)));
    const intervalProjections = points.slice(1).map((point, index) => project(interpolate(points[index], point), robot, (doc.constraints.maxCentripetalAccel || linear.intervals[index].acceleration) * DRIVETRAIN_SAFETY, MODULE_MOTOR_SAFETY));
    const validationProjections = points.slice(1).map((point, index) => project(interpolate(points[index], point), robot, doc.constraints.maxCentripetalAccel || linear.intervals[index].acceleration));
    const angularIntervalLimits = points.slice(1).map((point, index) => {
      const before = points[index], distance = point.s - before.s;
      const stationaryTurn = point.stop && point.waypointIndex != null && doc.waypoints[point.waypointIndex] && doc.waypoints[point.waypointIndex].turnInPlace;
      if (stationaryTurn || (translationStart != null && index + 1 >= translationStart) || distance <= EPSILON) return Infinity;
      const rate = Math.abs((point.heading - before.heading) / distance);
      return angularLimits(doc, ranges.filter((range) => overlaps(range, before.f, point.f))).velocity / Math.max(rate, EPSILON) * SAFETY;
    });
    const angularAccelerationConstraints = points.slice(1).map((point, index) => {
      const before = points[index];
      const stationaryTurn = (candidate) => candidate.stop && candidate.waypointIndex != null
        && doc.waypoints[candidate.waypointIndex] && doc.waypoints[candidate.waypointIndex].turnInPlace;
      if (stationaryTurn(before) || stationaryTurn(point) || (translationStart != null && index + 1 >= translationStart)) return [];
      const midpoint = interpolate(before, point);
      const limits = angularLimits(doc, ranges.filter((range) => overlaps(range, before.f, point.f)));
      const direction = Math.sign(midpoint.headingDerivative);
      return [{
        u: direction === 0 ? 0 : direction * midpoint.headingDerivative,
        x: direction === 0 ? midpoint.headingSecondDerivative : direction * midpoint.headingSecondDerivative,
        minimum: -(direction === 0 ? limits.acceleration : limits.deceleration) * SAFETY,
        maximum: limits.acceleration * SAFETY,
        label: 'angular-acceleration',
      }];
    });
    const curvatureVelocityLimits = points.map((point, index) => {
      const lateralLimit = doc.constraints.maxCentripetalAccel || Math.min(
        linear.intervals[index - 1] ? linear.intervals[index - 1].acceleration : Infinity,
        linear.intervals[index] ? linear.intervals[index].acceleration : Infinity,
      );
      return Math.abs(point.curvature) > EPSILON
        ? Math.sqrt(Math.max(0, lateralLimit * SAFETY) / Math.abs(point.curvature))
        : Infinity;
    });
    const intervalCurvatureVelocityLimits = points.slice(1).map((point, index) => {
      const curvature = Math.abs((points[index].curvature + point.curvature) * 0.5);
      const lateralLimit = doc.constraints.maxCentripetalAccel || linear.intervals[index].acceleration;
      return curvature > EPSILON
        ? Math.sqrt(Math.max(0, lateralLimit * SAFETY) / curvature)
        : Infinity;
    });
    const velocityLimits = points.map((_point, index) => Math.min(
      linear.points[index].velocity,
      linear.intervals[index - 1] ? linear.intervals[index - 1].velocity : Infinity,
      linear.intervals[index] ? linear.intervals[index].velocity : Infinity,
      pointProjections[index].velocityLimit * SAFETY,
      intervalProjections[index - 1] ? intervalProjections[index - 1].velocityLimit * SAFETY : Infinity,
      intervalProjections[index] ? intervalProjections[index].velocityLimit * SAFETY : Infinity,
      curvatureVelocityLimits[index],
      intervalCurvatureVelocityLimits[index - 1] == null ? Infinity : intervalCurvatureVelocityLimits[index - 1],
      intervalCurvatureVelocityLimits[index] == null ? Infinity : intervalCurvatureVelocityLimits[index],
      angularIntervalLimits[index - 1] == null ? Infinity : angularIntervalLimits[index - 1],
      angularIntervalLimits[index] == null ? Infinity : angularIntervalLimits[index],
      points[index].stop ? 0 : Infinity,
      dynamicHeadingStops.has(index) ? 0 : Infinity,
    ));
    const startVelocity = doc.waypoints[0].stop ? 0 : Math.min(linear.points[0].velocity, Math.max(0, doc.startVel || 0));
    const goalVelocity = doc.waypoints[doc.waypoints.length - 1].stop ? 0 : Math.min(linear.points[linear.points.length - 1].velocity, Math.max(0, doc.goalVel || 0));
    const solved = solve({
      positions: points.map((point) => point.s), velocityLimits,
      accelerationLimits: linear.intervals.map((limits) => limits.acceleration * SAFETY),
      decelerationLimits: linear.intervals.map((limits) => limits.deceleration * SAFETY),
      freeSpeeds: linear.intervals.map((limits) => limits.freeSpeed),
      motorAccelerationLimits: linear.intervals.map((limits) => limits.motorAcceleration),
      accelerationConstraints: intervalProjections.map((projection) => projection.accelerationConstraints),
      scalarAccelerationConstraints: angularAccelerationConstraints.map((constraints, index) => [
        ...constraints,
        ...intervalProjections[index].motorAccelerationConstraints,
      ]),
      startVelocity, goalVelocity,
    });
    if (solved.status !== 'optimal') return solved;
    const remapped = timing(points, solved.velocities);
    const validation = validate(doc, robot, points, linear, validationPointProjections, validationProjections, remapped.velocities, remapped.times, remapped.omegas, ranges, translationStart);
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

  function validateDense(doc, robot, pts, head, ranges, waypointIndices, transitions, sourcePoints, sourceVelocities) {
    const totalDistance = pts.length ? pts[pts.length - 1].s : 0;
    const boundaryPoints = pts.map((point) => ({
      ...point,
      f: totalDistance > EPSILON ? point.s / totalDistance : 0,
    }));
    const boundaryHead = head.map((heading) => heading + (doc.driveBackward ? Math.PI : 0));
    const translationStart = translationPriorityStart(ranges, transitions, boundaryPoints);
    let points = canonicalState(doc, boundaryPoints, boundaryHead, waypointIndices, translationStart);
    const dynamicHeadingStops = findDynamicHeadingStops(points, waypointIndices, translationStart);
    points = canonicalState(doc, boundaryPoints, boundaryHead, waypointIndices, translationStart, dynamicHeadingStops);
    const linear = {
      points: points.map((point) => limitsForRanges(doc, robot, activeRanges(ranges, point.f))),
      intervals: points.slice(1).map((point, index) => limitsForRanges(
        doc,
        robot,
        ranges.filter((range) => overlaps(range, points[index].f, point.f)),
      )),
    };
    const pointProjections = points.map((point, index) => project(point, robot, doc.constraints.maxCentripetalAccel || Math.min(
      linear.intervals[index - 1] ? linear.intervals[index - 1].acceleration : Infinity,
      linear.intervals[index] ? linear.intervals[index].acceleration : Infinity,
    )));
    const intervalProjections = points.slice(1).map((point, index) => project(
      interpolate(points[index], point),
      robot,
      doc.constraints.maxCentripetalAccel || linear.intervals[index].acceleration,
    ));
    const sourceTotal = sourcePoints.length ? sourcePoints[sourcePoints.length - 1].s : 0;
    let sourceIndex = 0;
    const velocities = points.map((point) => {
      const fraction = totalDistance > EPSILON ? point.s / totalDistance : 0;
      while (sourceIndex < sourcePoints.length - 2
        && sourcePoints[sourceIndex + 1].s / Math.max(sourceTotal, EPSILON) < fraction) sourceIndex++;
      for (let candidate = Math.max(0, sourceIndex - 2); candidate <= Math.min(sourcePoints.length - 1, sourceIndex + 3); candidate++) {
        if (Math.hypot(sourcePoints[candidate].x - point.x, sourcePoints[candidate].y - point.y) <= 1e-8) {
          sourceIndex = candidate;
          return Math.abs(sourceVelocities[candidate]);
        }
      }
      const beforeFraction = sourcePoints[sourceIndex].s / Math.max(sourceTotal, EPSILON);
      const afterIndex = Math.min(sourcePoints.length - 1, sourceIndex + 1);
      const afterFraction = sourcePoints[afterIndex].s / Math.max(sourceTotal, EPSILON);
      const ratio = Math.max(0, Math.min(
        1,
        (fraction - beforeFraction) / Math.max(EPSILON, afterFraction - beforeFraction),
      ));
      const beforeSquared = sourceVelocities[sourceIndex] ** 2;
      const afterSquared = sourceVelocities[afterIndex] ** 2;
      return Math.sqrt(Math.max(0, beforeSquared + (afterSquared - beforeSquared) * ratio));
    });
    const remapped = timing(points, velocities);
    const validation = validate(
      doc,
      robot,
      points,
      linear,
      pointProjections,
      intervalProjections,
      remapped.velocities,
      remapped.times,
      remapped.omegas,
      ranges,
      translationStart,
    );
    return { ...validation, checkedPoints: points.length * 2 - 1 };
  }

  function evaluateModule(point, robot, velocity, acceleration, omega, alpha) {
    const cos = Math.cos(point.heading), sin = Math.sin(point.heading);
    const hardLimits = window.PM.robotHardLimits(robot);
    return moduleOffsets(robot).map((module) => {
      const offsetX = cos * module.x - sin * module.y;
      const offsetY = sin * module.x + cos * module.y;
      const perpendicularX = -offsetY, perpendicularY = offsetX;
      const velocityX = point.tangentX * velocity + omega * perpendicularX;
      const velocityY = point.tangentY * velocity + omega * perpendicularY;
      const accelerationX = point.tangentX * acceleration + point.curvature * point.normalX * velocity ** 2 + alpha * perpendicularX - omega ** 2 * offsetX;
      const accelerationY = point.tangentY * acceleration + point.curvature * point.normalY * velocity ** 2 + alpha * perpendicularY - omega ** 2 * offsetY;
      const speed = Math.hypot(velocityX, velocityY);
      return {
        label: module.label,
        speed,
        acceleration: Math.hypot(accelerationX, accelerationY),
        longitudinalAcceleration: speed > EPSILON ? (velocityX * accelerationX + velocityY * accelerationY) / speed : 0,
        motorAccelerationLimit: hardLimits ? hardLimits.motorAccel * Math.max(0, 1 - speed / hardLimits.maxSpeed) : Infinity,
      };
    });
  }

  function validateFollowed(doc, robot, pts, trackedHead, profile, ranges, waypointIndices) {
    const totalDistance = pts.length ? pts[pts.length - 1].s : 0;
    const boundaryPoints = pts.map((point) => ({
      ...point,
      f: totalDistance > EPSILON ? point.s / totalDistance : 0,
    }));
    const physicalHead = trackedHead.map((heading) => heading + (doc.driveBackward ? Math.PI : 0));
    const points = canonicalState(doc, boundaryPoints, physicalHead, waypointIndices);
    const velocities = [...profile.v];
    const times = [...profile.t];
    const omegas = points.map((point, index) => index === 0
      ? 0
      : (point.heading - points[index - 1].heading) / Math.max(EPSILON, times[index] - times[index - 1]));
    const violations = [], active = new Set();
    const stationaryTurn = (point) => point.stop && point.waypointIndex != null
      && doc.waypoints[point.waypointIndex] && doc.waypoints[point.waypointIndex].turnInPlace;
    for (let index = 0; index < points.length; index++) {
      const angular = angularLimits(doc, activeRanges(ranges, points[index].f));
      if (!stationaryTurn(points[index]) && Math.abs(omegas[index]) > angular.velocity + tolerance(angular.velocity, 2e-3, 0.02)) {
        violations.push({ kind: 'angular-velocity', index, measured: Math.abs(omegas[index]), limit: angular.velocity });
      }
      if (!stationaryTurn(points[index]) && angular.velocity > EPSILON && Math.abs(omegas[index]) >= angular.velocity * ACTIVE) active.add('angular-velocity');
      evaluateModule(points[index], robot, velocities[index], 0, omegas[index], 0).forEach((module) => {
        if (module.speed > robot.maxSpeed + tolerance(robot.maxSpeed)) violations.push({ kind: 'drivetrain-velocity', index, measured: module.speed, limit: robot.maxSpeed });
        if (module.speed >= robot.maxSpeed * ACTIVE) active.add(module.label);
      });
    }
    for (let index = 0; index < points.length - 1; index++) {
      const distance = points[index + 1].s - points[index].s;
      if (distance <= EPSILON) continue;
      const dt = times[index + 1] - times[index];
      const acceleration = (velocities[index + 1] ** 2 - velocities[index] ** 2) / (2 * distance);
      const speed = Math.sqrt(Math.max(0, (velocities[index] ** 2 + velocities[index + 1] ** 2) * 0.5));
      const omega = (omegas[index] + omegas[index + 1]) * 0.5;
      const alpha = (omegas[index + 1] - omegas[index]) / Math.max(EPSILON, dt);
      const angular = angularLimits(doc, ranges.filter((range) => overlaps(range, points[index].f, points[index + 1].f)));
      const reversing = Math.sign(omegas[index + 1]) && Math.sign(omegas[index]) && Math.sign(omegas[index + 1]) !== Math.sign(omegas[index]);
      const alphaLimit = reversing ? Math.min(angular.acceleration, angular.deceleration) : Math.abs(omegas[index + 1]) >= Math.abs(omegas[index]) ? angular.acceleration : angular.deceleration;
      if (!stationaryTurn(points[index]) && !stationaryTurn(points[index + 1])) {
        if (Math.abs(alpha) > alphaLimit + tolerance(alphaLimit, 2e-3, 0.02)) violations.push({ kind: 'angular-acceleration', index: index + 1, measured: Math.abs(alpha), limit: alphaLimit });
        if (alphaLimit > EPSILON && Math.abs(alpha) >= alphaLimit * ACTIVE) active.add('angular-acceleration');
      }
      const linear = limitsForRanges(doc, robot, ranges.filter((range) => overlaps(range, points[index].f, points[index + 1].f)));
      const midpoint = interpolate(points[index], points[index + 1]);
      const accelerationLimit = doc.constraints.maxCentripetalAccel || linear.acceleration;
      const centripetalAcceleration = speed * speed * Math.abs(midpoint.curvature);
      if (centripetalAcceleration > accelerationLimit + tolerance(accelerationLimit)) violations.push({ kind: 'centripetal-acceleration', index: index + 1, measured: centripetalAcceleration, limit: accelerationLimit });
      if (accelerationLimit > EPSILON && centripetalAcceleration >= accelerationLimit * ACTIVE) active.add('centripetal-acceleration');
      evaluateModule(midpoint, robot, speed, acceleration, omega, alpha).forEach((module) => {
        if (module.speed > robot.maxSpeed + tolerance(robot.maxSpeed)) violations.push({ kind: 'drivetrain-velocity', index: index + 1, measured: module.speed, limit: robot.maxSpeed });
        if (module.acceleration > accelerationLimit + tolerance(accelerationLimit)) violations.push({ kind: 'drivetrain-acceleration', index: index + 1, measured: module.acceleration, limit: accelerationLimit });
        const longitudinalAcceleration = Math.abs(module.longitudinalAcceleration);
        if (longitudinalAcceleration > module.motorAccelerationLimit + tolerance(module.motorAccelerationLimit)) violations.push({ kind: 'drivetrain-acceleration', index: index + 1, measured: longitudinalAcceleration, limit: module.motorAccelerationLimit });
        if (module.speed >= robot.maxSpeed * ACTIVE || module.acceleration >= accelerationLimit * 0.94 || longitudinalAcceleration >= module.motorAccelerationLimit * 0.94) active.add(module.label);
      });
    }
    return { violations, activeConstraints: Array.from(active).sort() };
  }

  window.TrajectoryOptimizer = { insertBoundaries, optimize, validateDense, validateFollowed };
})();
