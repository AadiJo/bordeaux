import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildWaypoints, createDemoProject } = require('../dist-electron/shared/project/defaults.js');

function driveModel() {
  return {
    motorId: 'corpus',
    motorFreeRpm: 5_000,
    motorMaxTorqueNm: 2.6,
    motorCount: 4,
    gearRatio: 6,
    wheelDiameterM: 0.1,
    massKg: 52,
    moiKgM2: 6,
    wheelbaseM: 0.6,
    trackwidthM: 0.8,
    wheelFrictionCoefficient: 1.1,
  };
}

function demoCase() {
  const project = createDemoProject();
  return { name: 'demo', input: { path: project.paths[0], robot: project.robot }, expectedStatuses: ['optimal'] };
}

function curvedCase() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.headingMode = 'tangent';
  path.waypoints = buildWaypoints([
    { x: 0.8, y: 1.0, nextC: { x: 2.2, y: 0.8 } },
    { x: 4.0, y: 4.9, prevC: { x: 2.8, y: 4.8 }, nextC: { x: 5.2, y: 5.0 } },
    { x: 8.0, y: 2.0, prevC: { x: 6.8, y: 2.1 }, nextC: { x: 10.0, y: 1.8 } },
    { x: 14.5, y: 6.8, prevC: { x: 12.5, y: 6.7 } },
  ]);
  return { name: 'curved', input: { path, robot: project.robot }, expectedStatuses: ['optimal'] };
}

function constrainedStopCase() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.headingMode = 'tangent';
  path.waypoints = buildWaypoints([
    { x: 1, y: 1, nextC: { x: 2, y: 1 } },
    { x: 5, y: 1, prevC: { x: 4, y: 1 }, nextC: { x: 7, y: 1 }, stop: true },
    { x: 11, y: 1, prevC: { x: 9, y: 1 } },
  ]);
  path.ranges = [{
    anchor: 'param', f0: 0.2, f1: 0.8,
    maxVel: 1.5, maxAccel: 1, maxDecel: 1, maxAngVel: 360, maxAngAccel: 720,
  }];
  return { name: 'range-stop', input: { path, robot: project.robot }, expectedStatuses: ['optimal'] };
}

function rotatingSwerveCase() {
  const project = createDemoProject();
  project.robot.driveModel = driveModel();
  const path = project.paths[0];
  path.headingMode = 'manual';
  path.constraints = { ...path.constraints, maxVel: 5, maxAccel: 10, maxDecel: 10, maxAngVel: 2_000, maxAngAccel: 4_000 };
  path.waypoints = buildWaypoints([
    { x: 1, y: 1, theta: 0, thetaOn: true },
    { x: 6, y: 1, theta: 180, thetaOn: true },
  ]);
  return { name: 'rotating-swerve', input: { path, robot: project.robot }, expectedStatuses: ['optimal'] };
}

function physicalTankCase() {
  const project = createDemoProject();
  project.robot.drive = 'tank';
  project.robot.driveModel = driveModel();
  const path = project.paths[0];
  path.headingMode = 'tangent';
  path.waypoints = buildWaypoints([
    { x: 1, y: 1, nextC: { x: 3, y: 1 }, segType: 'bezier' },
    { x: 5, y: 4, prevC: { x: 3, y: 4 }, nextC: { x: 7, y: 4 }, segType: 'bezier', stop: true },
    { x: 9, y: 2, prevC: { x: 7, y: 2 } },
  ]);
  return { name: 'physical-tank', input: { path, robot: project.robot }, expectedStatuses: ['optimal'] };
}

function translationPriorityCase() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.headingMode = 'manual';
  path.constraints = { ...path.constraints, maxAngVel: 60, maxAngAccel: 120, maxAngDecel: 120 };
  path.waypoints = buildWaypoints([
    { x: 1, y: 2, theta: 0, thetaOn: true, segType: 'line' },
    { x: 8, y: 2, theta: 180, thetaOn: true },
  ]);
  path.ranges = [{
    anchor: 'param', f0: 0.05, f1: 0.95,
    maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 60, maxAngAccel: 120,
    rotationPriority: 'translation',
  }];
  return { name: 'translation-priority', input: { path, robot: project.robot }, expectedStatuses: ['optimal'] };
}

function stationaryActionCase() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.headingMode = 'manual';
  path.waypoints = buildWaypoints([
    { x: 2, y: 2, theta: 0, thetaOn: true, segType: 'line' },
    { x: 4, y: 2, theta: 90, thetaOn: true, stop: true, wait: 0.12, segType: 'line', turnInPlace: { headingDeg: 90 } },
    { x: 6, y: 2, theta: 90, thetaOn: true },
  ]);
  return { name: 'stationary-action', input: { path, robot: project.robot }, expectedStatuses: ['optimal'] };
}

function unsupportedJerkCase() {
  const project = createDemoProject();
  project.paths[0].constraints.maxJerk = 4;
  return {
    name: 'unsupported-jerk',
    input: { path: project.paths[0], robot: project.robot },
    expectedStatuses: ['invalid-input'],
    benchmark: false,
  };
}

function longPathCase() {
  const project = createDemoProject();
  delete project.robot.driveModel;
  const path = project.paths[0];
  path.headingMode = 'manual';
  const points = Array.from({ length: 31 }, (_unused, index) => ({
    x: 0.7 + index * 0.48,
    y: 3 + Math.sin(index * 0.45) * 0.35,
  }));
  path.waypoints = buildWaypoints(points.map((point, index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.max(1e-9, Math.hypot(dx, dy));
    const handle = 0.16;
    return {
      ...point,
      theta: 0,
      thetaOn: true,
      segType: 'bezier',
      prevC: { x: point.x - dx / length * handle, y: point.y - dy / length * handle },
      nextC: { x: point.x + dx / length * handle, y: point.y + dy / length * handle },
    };
  }));
  return { name: 'long-path', input: { path, robot: project.robot }, expectedStatuses: ['optimal'], stress: true };
}

export function optimizerCorpus() {
  return [
    demoCase(), curvedCase(), constrainedStopCase(), rotatingSwerveCase(), physicalTankCase(),
    translationPriorityCase(), stationaryActionCase(), longPathCase(), unsupportedJerkCase(),
  ];
}
