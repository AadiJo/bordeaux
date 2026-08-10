const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const rendererHtml = process.env.BORDEAUX_BENCHMARK_RENDERER_HTML;
const label = process.env.BORDEAUX_BENCHMARK_LABEL || "renderer";
const latencySamples = Number.parseInt(process.env.BORDEAUX_BROWSER_LATENCY_SAMPLES || "24", 10);
const stressDurationMs = Number.parseInt(process.env.BORDEAUX_BROWSER_STRESS_MS || "2000", 10);
const inputHz = Number.parseInt(process.env.BORDEAUX_BROWSER_INPUT_HZ || "120", 10);
const checkCorrectness = process.env.BORDEAUX_BROWSER_CHECK_CORRECTNESS === "1";
const frameBudgetMs = 1000 / 60;

if (!rendererHtml) throw new Error("BORDEAUX_BENCHMARK_RENDERER_HTML is required");

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const epochNow = () => performance.timeOrigin + performance.now();

function percentile(values, fraction) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function statistics(values) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function frameSummary(frameDeltas) {
  let droppedFrames = 0;
  let expectedFrames = 0;
  for (const delta of frameDeltas) {
    const occupiedSlots = Math.max(1, Math.round(delta / frameBudgetMs));
    droppedFrames += occupiedSlots - 1;
    expectedFrames += occupiedSlots;
  }
  return {
    frameTimeMs: statistics(frameDeltas),
    droppedFrames,
    expectedFrames,
    droppedFramePercent: expectedFrames ? droppedFrames / expectedFrames * 100 : 0,
  };
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(16);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function installProbe(waypointIndex) {
  const epoch = () => performance.timeOrigin + performance.now();
  const state = {
    active: false,
    frames: [],
    geometry: [],
    lastGeometry: null,
    pending: null,
    lastCorrect: null,
    trace: null,
  };
  const waypoint = () => document.querySelector(`[data-role="wp"][data-idx="${waypointIndex}"]`);
  const benchmarkSvg = waypoint()?.ownerSVGElement;
  const benchmarkInverse = benchmarkSvg?.getScreenCTM()?.inverse();
  const localAt = (x, y) => {
    if (!benchmarkSvg || !benchmarkInverse) return null;
    const point = benchmarkSvg.createSVGPoint();
    point.x = x;
    point.y = y;
    const local = point.matrixTransform(benchmarkInverse);
    return { x: local.x, y: local.y };
  };
  const read = () => {
    const node = waypoint();
    const svg = node?.ownerSVGElement;
    if (!node || !svg) return null;
    const rect = node.getBoundingClientRect();
    const screen = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const point = svg.createSVGPoint();
    point.x = Number(node.getAttribute("x")) + Number(node.getAttribute("width")) / 2;
    point.y = Number(node.getAttribute("y")) + Number(node.getAttribute("height")) / 2;
    const centerlines = [...svg.querySelectorAll("path")].filter((candidate) =>
      candidate.getAttribute("stroke") === "#05060a" && candidate.getAttribute("stroke-opacity") === "0.75");
    const curveCorrect = centerlines.some((candidate) =>
      typeof candidate.isPointInStroke === "function" && candidate.isPointInStroke(point));
    return { ...screen, localX: point.x, localY: point.y, curveCorrect };
  };
  window.addEventListener("pointermove", (event) => {
    const local = localAt(event.clientX, event.clientY);
    state.pending = { x: event.clientX, y: event.clientY, localX: local?.x, localY: local?.y, inputAtEpochMs: epoch() };
  }, true);
  const tick = (timestamp) => {
    const current = read();
    if (state.active) {
      state.frames.push(timestamp);
      if (current?.curveCorrect && (!state.lastGeometry
        || Math.hypot(current.localX - state.lastGeometry.localX, current.localY - state.lastGeometry.localY) > 0.75)) {
        state.geometry.push(epoch());
        state.lastGeometry = current;
      }
    }
    if (state.trace && current) state.trace.push({ atEpochMs: epoch(), x: current.x, y: current.y, curveCorrect: current.curveCorrect });
    if (state.pending && current?.curveCorrect
      && Math.hypot(current.x - state.pending.x, current.y - state.pending.y) <= 2.5
      && Math.hypot(current.localX - state.pending.localX, current.localY - state.pending.localY) <= 7) {
      state.lastCorrect = { ...state.pending, correctAtEpochMs: epoch() };
      state.pending = null;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__rendererBenchmark = {
    read,
    localAt,
    lastCorrect: () => state.lastCorrect,
    start() {
      const current = read();
      state.active = true;
      state.frames = [];
      state.geometry = [];
      state.lastGeometry = current;
    },
    stop() {
      state.active = false;
      return { frames: state.frames, geometry: state.geometry };
    },
    startTrace() { state.trace = []; },
    stopTrace() { const trace = state.trace || []; state.trace = null; return trace; },
  };
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    useContentSize: true,
    backgroundColor: "#000000",
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      offscreen: true,
      preload: path.join(__dirname, "renderer-browser-benchmark-preload.cjs"),
      sandbox: false,
    },
  });
  window.webContents.setFrameRate(60);

  const paintTimestamps = [];
  const paintWaiters = new Set();
  let lastPaintAt = epochNow();
  window.webContents.on("paint", () => {
    const timestamp = epochNow();
    lastPaintAt = timestamp;
    paintTimestamps.push(timestamp);
    for (const waiter of paintWaiters) {
      if (timestamp < waiter.after) continue;
      paintWaiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(timestamp);
    }
  });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error" && !details.message.startsWith("Loading the font 'data:font/woff2")) {
      process.stderr.write(`[${label} renderer] ${details.message}\n`);
    }
  });

  function paintAfter(after, timeoutMs = 4000) {
    const recorded = paintTimestamps.find((timestamp) => timestamp >= after);
    if (recorded) return Promise.resolve(recorded);
    return new Promise((resolve, reject) => {
      const waiter = {
        after,
        resolve,
        timeout: setTimeout(() => {
          paintWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for a paint after ${after.toFixed(3)}ms`));
        }, timeoutMs),
      };
      paintWaiters.add(waiter);
    });
  }

  async function waitForPaintQuiet(quietMs = 70, timeoutMs = 4000) {
    await waitFor(() => epochNow() - lastPaintAt >= quietMs, timeoutMs, "a quiet paint interval");
  }

  async function loadFixture() {
    await window.loadFile(rendererHtml);
    await waitFor(
      () => window.webContents.executeJavaScript('document.querySelectorAll(\'[data-role="wp"]\').length === 100'),
      10000,
      "the 100-waypoint fixture",
    );
    await window.webContents.executeJavaScript(`(${installProbe.toString()})(50)`);
    await waitForPaintQuiet(100);
  }

  const readProbe = () => window.webContents.executeJavaScript("window.__rendererBenchmark.read()");
  const center = async () => {
    const point = await readProbe();
    if (!point) throw new Error("Benchmark waypoint 50 is missing");
    return { x: Math.round(point.x), y: Math.round(point.y), localX: point.localX, localY: point.localY };
  };
  const moveMouse = (point) => window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(point.x), y: Math.round(point.y), button: "left" });
  const pressMouse = async (point) => {
    moveMouse(point);
    await delay(16);
    window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const releaseMouse = (point) => window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 });
  const localAt = (target) => window.webContents.executeJavaScript(`window.__rendererBenchmark.localAt(${target.x}, ${target.y})`);
  const matchesTarget = (current, target, expectedLocal) => current?.curveCorrect
    && Math.hypot(current.x - target.x, current.y - target.y) <= 2.5
    && (!expectedLocal || Math.hypot(current.localX - expectedLocal.x, current.localY - expectedLocal.y) <= 7);
  const waitForCorrect = (target, expectedLocal, timeoutMs = 5000) => waitFor(
    async () => {
      const current = await readProbe();
      return matchesTarget(current, target, expectedLocal) ? current : null;
    },
    timeoutMs,
    `correct curve geometry at ${target.x},${target.y}`,
  );

  async function correctnessChecks() {
    await loadFixture();
    const origin = await center();
    const lastMove = { x: origin.x + 42, y: origin.y - 16 };
    const release = { x: lastMove.x + 28, y: lastMove.y + 10 };
    await pressMouse(origin);
    const lastMoveLocal = await localAt(lastMove);
    const releaseLocal = await localAt(release);
    moveMouse(lastMove);
    await waitForCorrect(lastMove, lastMoveLocal);
    await window.webContents.executeJavaScript("window.__rendererBenchmark.startTrace()");
    releaseMouse(release);
    await waitForCorrect(release, releaseLocal);
    await delay(100);
    const releaseFinal = await readProbe();
    const trace = await window.webContents.executeJavaScript("window.__rendererBenchmark.stopTrace()");
    const releaseStable = trace.length > 0 && trace.every((point) => point.curveCorrect
      && Math.hypot(point.x - release.x, point.y - release.y) <= 4);

    await loadFixture();
    const saveOrigin = await center();
    const saveTarget = { x: saveOrigin.x + 55, y: saveOrigin.y + 18 };
    await pressMouse(saveOrigin);
    const saveTargetLocal = await localAt(saveTarget);
    moveMouse(saveTarget);
    await waitForCorrect(saveTarget, saveTargetLocal);
    await window.webContents.executeJavaScript("window.bordeauxAPI.__benchmarkCommand('save-project')");
    const savedState = await waitFor(async () => {
      const state = await window.webContents.executeJavaScript("window.bordeauxAPI.__benchmarkState()");
      return state.savedProjects.length ? state : null;
    }, 3000, "an active edit to be saved");
    releaseMouse(saveTarget);
    const savedWaypoint = savedState.savedProjects.at(-1).paths[0].waypoints[50];
    const originalWaypoint = JSON.parse(Buffer.from(process.env.BORDEAUX_BENCHMARK_PROJECT, "base64").toString("utf8")).paths[0].waypoints[50];
    const saveIncludesDraft = Math.hypot(savedWaypoint.x - originalWaypoint.x, savedWaypoint.y - originalWaypoint.y) > 0.02;
    const closeGuardDirty = savedState.dirtyValues.includes(true);

    await loadFixture();
    const undoOrigin = await center();
    const undoTarget = { x: undoOrigin.x - 48, y: undoOrigin.y + 22 };
    await pressMouse(undoOrigin);
    const undoTargetLocal = await localAt(undoTarget);
    moveMouse(undoTarget);
    await waitForCorrect(undoTarget, undoTargetLocal);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
    await waitForCorrect(undoOrigin, { x: undoOrigin.localX, y: undoOrigin.localY });
    releaseMouse(undoTarget);
    await delay(150);
    const afterUndoRelease = await readProbe();
    const undoCancelsDrag = matchesTarget(afterUndoRelease, undoOrigin, { x: undoOrigin.localX, y: undoOrigin.localY });

    await loadFixture();
    const cancelOrigin = await center();
    const cancelTarget = { x: cancelOrigin.x + 44, y: cancelOrigin.y - 20 };
    const originalProject = JSON.parse(Buffer.from(process.env.BORDEAUX_BENCHMARK_PROJECT, "base64").toString("utf8"));
    const originalCancelWaypoint = originalProject.paths[0].waypoints[50];
    await pressMouse(cancelOrigin);
    const cancelTargetLocal = await localAt(cancelTarget);
    moveMouse(cancelTarget);
    await waitForCorrect(cancelTarget, cancelTargetLocal);
    await waitFor(async () => {
      const state = await window.webContents.executeJavaScript("window.bordeauxAPI.__benchmarkState()");
      const waypoint = state.autosavedProjects.at(-1)?.paths[0]?.waypoints[50];
      return waypoint && Math.hypot(waypoint.x - originalCancelWaypoint.x, waypoint.y - originalCancelWaypoint.y) > 0.02;
    }, 4000, "the active draft to be autosaved");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
    await waitForCorrect(cancelOrigin, { x: cancelOrigin.localX, y: cancelOrigin.localY });
    releaseMouse(cancelTarget);
    const restoredAutosave = await waitFor(async () => {
      const state = await window.webContents.executeJavaScript("window.bordeauxAPI.__benchmarkState()");
      const waypoint = state.autosavedProjects.at(-1)?.paths[0]?.waypoints[50];
      return waypoint && Math.hypot(waypoint.x - originalCancelWaypoint.x, waypoint.y - originalCancelWaypoint.y) <= 1e-6
        ? state.autosavedProjects.at(-1)
        : null;
    }, 4000, "the canceled draft autosave to be rolled back");
    const cancelAutosaveRestored = Boolean(restoredAutosave);

    await loadFixture();
    const commandOrigin = await center();
    const commandTarget = { x: commandOrigin.x - 52, y: commandOrigin.y + 18 };
    const originalCommandWaypoint = originalProject.paths[0].waypoints[50];
    const expectedNudgeX = originalCommandWaypoint.x + 0.05;
    const saveWaypoint = async () => {
      const before = await window.webContents.executeJavaScript("window.bordeauxAPI.__benchmarkState().savedProjects.length");
      await window.webContents.executeJavaScript("window.bordeauxAPI.__benchmarkCommand('save-project')");
      const state = await waitFor(async () => {
        const next = await window.webContents.executeJavaScript("window.bordeauxAPI.__benchmarkState()");
        return next.savedProjects.length > before ? next : null;
      }, 3000, "the command-race project to be saved");
      return state.savedProjects.at(-1).paths[0].waypoints[50];
    };
    const pressKey = (keyCode, modifiers = []) => {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    };
    await pressMouse(commandOrigin);
    const commandTargetLocal = await localAt(commandTarget);
    moveMouse(commandTarget);
    await waitForCorrect(commandTarget, commandTargetLocal);
    pressKey("Right");
    releaseMouse(commandTarget);
    await delay(150);
    const commandWaypoint = await saveWaypoint();
    const commandSurvivesDrag = Math.abs(commandWaypoint.x - expectedNudgeX) <= 1e-6
      && Math.abs(commandWaypoint.y - originalCommandWaypoint.y) <= 1e-6;

    pressKey("Z", ["control"]);
    await delay(150);
    const undoneWaypoint = await saveWaypoint();
    const commandUndoRestores = Math.hypot(undoneWaypoint.x - originalCommandWaypoint.x, undoneWaypoint.y - originalCommandWaypoint.y) <= 1e-6;
    const redoCancelOrigin = await center();
    const redoCancelTarget = { x: redoCancelOrigin.x + 38, y: redoCancelOrigin.y + 20 };
    await pressMouse(redoCancelOrigin);
    const redoCancelTargetLocal = await localAt(redoCancelTarget);
    moveMouse(redoCancelTarget);
    await waitForCorrect(redoCancelTarget, redoCancelTargetLocal);
    pressKey("Z", ["control"]);
    releaseMouse(redoCancelTarget);
    pressKey("Y", ["control"]);
    await delay(150);
    const redoneWaypoint = await saveWaypoint();
    const cancelPreservesRedo = Math.abs(redoneWaypoint.x - expectedNudgeX) <= 1e-6
      && Math.abs(redoneWaypoint.y - originalCommandWaypoint.y) <= 1e-6;

    await loadFixture();
    const switchOrigin = await center();
    const switchTarget = { x: switchOrigin.x + 35, y: switchOrigin.y + 15 };
    await pressMouse(switchOrigin);
    const switchTargetLocal = await localAt(switchTarget);
    moveMouse(switchTarget);
    await waitForCorrect(switchTarget, switchTargetLocal);
    await window.webContents.executeJavaScript("document.querySelector('button.pathsw-btn')?.click()");
    const switched = await waitFor(async () => window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button.pathlib-pick')]
        .find((candidate) => candidate.textContent.includes('Alternate benchmark path'));
      if (!button) return false;
      button.click();
      return true;
    })()`), 2000, "the alternate path picker");
    if (switched) await waitFor(
      () => window.webContents.executeJavaScript('document.querySelectorAll(\'[data-role="wp"]\').length === 3'),
      3000,
      "the alternate path",
    );
    releaseMouse({ x: switchOrigin.x + 70, y: switchOrigin.y + 30 });
    await delay(150);
    const pathSwitchCancelsDrag = switched && await window.webContents.executeJavaScript('document.querySelectorAll(\'[data-role="wp"]\').length === 3');

    return { releaseUsesTerminalCoordinates: matchesTarget(releaseFinal, release, releaseLocal), releaseStable, saveIncludesDraft, closeGuardDirty, undoCancelsDrag, cancelAutosaveRestored, commandSurvivesDrag, commandUndoRestores, cancelPreservesRedo, pathSwitchCancelsDrag };
  }

  async function measureLatency() {
    await loadFixture();
    const origin = await center();
    await pressMouse(origin);
    await waitForPaintQuiet(80);
    const correctPaintSamples = [];
    const anyPaintSamples = [];
    let target = origin;
    for (let index = 0; index < latencySamples; index++) {
      await waitForPaintQuiet(34);
      const direction = index % 2 === 0 ? 1 : -1;
      target = { x: origin.x + direction * (42 + index % 5), y: origin.y + ((index % 7) - 3) * 4 };
      const sentAt = epochNow();
      moveMouse(target);
      const anyPaint = await paintAfter(sentAt);
      const correct = await waitFor(async () => {
        const value = await window.webContents.executeJavaScript("window.__rendererBenchmark.lastCorrect()");
        return value && Math.hypot(value.x - target.x, value.y - target.y) <= 1 ? value : null;
      }, 5000, "a correct-geometry frame");
      // Without a cross-process frame token, only a compositor paint observed
      // after correct geometry is known can safely be called a correct paint.
      const correctPaint = await paintAfter(correct.correctAtEpochMs);
      if (correctPaint < correct.correctAtEpochMs) throw new Error('A correct paint cannot precede the correct-geometry observation.');
      anyPaintSamples.push(anyPaint - sentAt);
      correctPaintSamples.push(correctPaint - sentAt);
    }
    releaseMouse(target);
    await waitForPaintQuiet(100);
    return { anyPaintMs: statistics(anyPaintSamples), correctPaintMs: statistics(correctPaintSamples), samples: correctPaintSamples };
  }

  async function measureStress() {
    await loadFixture();
    const origin = await center();
    await pressMouse(origin);
    await waitForPaintQuiet(80);
    await window.webContents.executeJavaScript("window.__rendererBenchmark.start()");
    const firstPaint = paintTimestamps.length;
    const startedAt = epochNow();
    const inputIntervalMs = 1000 / inputHz;
    const inputCount = Math.floor(stressDurationMs / inputIntervalMs);
    let target = origin;
    const finalAngle = (inputCount - 1) / 11;
    const finalTarget = { x: origin.x + Math.cos(finalAngle) * 54, y: origin.y + Math.sin(finalAngle) * 32 };
    const finalTargetLocal = await localAt(finalTarget);
    for (let index = 0; index < inputCount; index++) {
      const remaining = startedAt + index * inputIntervalMs - epochNow();
      if (remaining > 0.5) await delay(remaining);
      const angle = index / 11;
      target = { x: origin.x + Math.cos(angle) * 54, y: origin.y + Math.sin(angle) * 32 };
      moveMouse(target);
    }
    const endedAt = epochNow();
    await waitForCorrect(target, finalTargetLocal);
    releaseMouse(target);
    const probe = await window.webContents.executeJavaScript("window.__rendererBenchmark.stop()");
    const frameDeltas = probe.frames.slice(1).map((timestamp, index) => timestamp - probe.frames[index]);
    const geometry = probe.geometry.filter((timestamp) => timestamp >= startedAt && timestamp <= endedAt);
    const geometryBoundaries = [startedAt, ...geometry, endedAt];
    const geometryGaps = geometryBoundaries.slice(1).map((timestamp, index) => timestamp - geometryBoundaries[index]);
    const paints = paintTimestamps.slice(firstPaint).filter((timestamp) => timestamp <= endedAt);
    const actualDurationMs = endedAt - startedAt;
    await waitForPaintQuiet(100);
    return {
      actualDurationMs,
      inputEvents: inputCount,
      frameDeltas,
      paintCallbackRateHz: paints.length / actualDurationMs * 1000,
      correctCurveUpdates: geometry.length,
      correctCurveRateHz: geometry.length / actualDurationMs * 1000,
      maxCorrectCurveGapMs: Math.max(...geometryGaps),
      timingBoundsEpochMs: { startedAt, endedAt },
      rawGeometryEpochMs: probe.geometry,
      ...frameSummary(frameDeltas),
    };
  }

  try {
    const correctness = checkCorrectness ? await correctnessChecks() : null;
    const latency = await measureLatency();
    const stress = await measureStress();
    const result = {
      label,
      runtime: { chrome: process.versions.chrome, electron: process.versions.electron, node: process.versions.node },
      fixture: { waypoints: 100, viewport: "1440x900", inputHz, compositorFrameRateHz: 60 },
      correctness,
      latency,
      stress,
    };
    process.stdout.write(`BORDEAUX_BROWSER_BENCHMARK=${JSON.stringify(result)}\n`);
  } finally {
    window.destroy();
    app.quit();
  }
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.quit();
  process.exitCode = 1;
});
