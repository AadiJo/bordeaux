import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const repository = fileURLToPath(new URL("..", import.meta.url));
const runner = path.join(repository, "scripts", "renderer-browser-benchmark-electron.cjs");
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-browser-benchmark-"));

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const mergeBase = execFileSync("git", ["merge-base", "origin/main", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
const baselineRef = option("baseline", mergeBase);
const candidateRef = option("candidate", "HEAD");
const trials = Number.parseInt(option("trials", process.env.BORDEAUX_BROWSER_TRIALS || "3"), 10);
const latencySamples = option("latency-samples", process.env.BORDEAUX_BROWSER_LATENCY_SAMPLES || "24");
const stressMs = option("stress-ms", process.env.BORDEAUX_BROWSER_STRESS_MS || "2000");
const output = path.resolve(repository, option("output", ".benchmark-results/renderer-browser.json"));

function makePath(count, name, id) {
  return {
    id,
    name,
    waypoints: Array.from({ length: count }, (_, index) => {
      const progress = index / (count - 1);
      const phase = progress * Math.PI * 4;
      const x = 0.7 + progress * 16;
      const y = 4 + Math.sin(phase) * 2.2;
      const dx = 16 / (count - 1) / 3;
      const dy = Math.cos(phase) * 2.2 * Math.PI * 4 / (count - 1) / 3;
      return {
        x,
        y,
        theta: 0,
        thetaOn: index === 0 || index === count - 1,
        stop: false,
        linked: true,
        prevC: { x: x - dx, y: y - dy },
        nextC: { x: x + dx, y: y + dy },
      };
    }),
    targets: [],
    markers: [],
    ranges: [],
    constraints: { maxVel: 4.2, maxAccel: 6.5, maxDecel: 6.5, maxAngVel: 540, maxAngAccel: 720, maxAngDecel: 720, maxJerk: 0, maxAngJerk: 0 },
    headingMode: "targets",
    startVel: 0,
    goalVel: 0,
  };
}

const primaryPath = makePath(100, "100-waypoint browser benchmark", "browser_benchmark_path");
const alternatePath = makePath(3, "Alternate benchmark path", "browser_benchmark_alternate");
const routine = { id: "browser_benchmark_routine", name: "Browser benchmark", nodes: [] };
const fixture = {
  schemaVersion: "1.0",
  name: "Renderer browser benchmark",
  robot: { drive: "swerve", w: 0.84, l: 0.84, heightM: 0.5, maxSpeed: 5 },
  paths: [primaryPath, alternatePath],
  pathLinks: [],
  routines: [routine],
  activeRoutineId: routine.id,
  routine,
  plannerId: "profiledSpline",
  editor: { activePathId: primaryPath.id },
};
const encodedFixture = Buffer.from(JSON.stringify(fixture)).toString("base64");

const revision = (reference) => execFileSync("git", ["rev-parse", "--short=12", reference], { cwd: repository, encoding: "utf8" }).trim();

async function archive(reference, destination) {
  await fs.mkdir(destination, { recursive: true });
  const trackedRoots = ["src/renderer", "src/shared"].filter((entry) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${reference}:${entry}`], { cwd: repository, stdio: "ignore" });
      return true;
    } catch (_error) {
      return false;
    }
  });
  const tar = execFileSync("git", ["archive", "--format=tar", reference, ...trackedRoots], {
    cwd: repository,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", destination], { input: tar, maxBuffer: 64 * 1024 * 1024 });
  await fs.symlink(path.join(repository, "node_modules"), path.join(destination, "node_modules"), "dir");
}

async function buildVariant(reference, key) {
  const root = path.join(temporaryDirectory, key);
  const outDir = path.join(temporaryDirectory, `dist-${key}`);
  await archive(reference, root);
  await build({
    root: path.join(root, "src", "renderer"),
    base: "./",
    publicDir: false,
    cacheDir: path.join(temporaryDirectory, `.vite-${key}`),
    plugins: [react()],
    logLevel: "warn",
    build: { outDir, emptyOutDir: true, sourcemap: false, target: "es2022" },
  });
  const assets = await fs.readdir(path.join(outDir, "assets"));
  return {
    html: path.join(outDir, "index.html"),
    workerBundle: assets.some((asset) => asset.startsWith("path-preview-worker-")),
  };
}

function runVariant(label, variant, checkCorrectness) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [runner], {
      cwd: repository,
      env: {
        ...process.env,
        BORDEAUX_BENCHMARK_LABEL: label,
        BORDEAUX_BENCHMARK_PROJECT: encodedFixture,
        BORDEAUX_BENCHMARK_RENDERER_HTML: variant.html,
        BORDEAUX_BROWSER_LATENCY_SAMPLES: latencySamples,
        BORDEAUX_BROWSER_STRESS_MS: stressMs,
        BORDEAUX_BROWSER_CHECK_CORRECTNESS: checkCorrectness ? "1" : "0",
        DISPLAY: process.env.DISPLAY || ":0",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/mnt/wslg/runtime-dir",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`${label} benchmark exited with ${code}\n${stderr}`));
      const line = stdout.split("\n").find((entry) => entry.startsWith("BORDEAUX_BROWSER_BENCHMARK="));
      if (!line) return reject(new Error(`${label} benchmark returned no result\n${stdout}\n${stderr}`));
      resolve(JSON.parse(line.slice("BORDEAUX_BROWSER_BENCHMARK=".length)));
    });
  });
}

const percentile = (values, fraction) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
};
const deviation = (values) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
};

function aggregate(runs, workerBundle) {
  const latency = runs.flatMap((run) => run.latency.samples);
  const frames = runs.flatMap((run) => run.stress.frameDeltas);
  const dropped = runs.reduce((sum, run) => sum + run.stress.droppedFrames, 0);
  const expected = runs.reduce((sum, run) => sum + run.stress.expectedFrames, 0);
  const duration = runs.reduce((sum, run) => sum + run.stress.actualDurationMs, 0);
  const updates = runs.reduce((sum, run) => sum + run.stress.correctCurveUpdates, 0);
  return {
    workerBundle,
    correctness: runs.find((run) => run.correctness)?.correctness || null,
    correctPaintMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), trialP95Deviation: deviation(runs.map((run) => run.latency.correctPaintMs.p95)) },
    frameTimeMs: { p95: percentile(frames, 0.95), trialP95Deviation: deviation(runs.map((run) => run.stress.frameTimeMs.p95)) },
    droppedFramePercent: expected ? dropped / expected * 100 : 0,
    correctCurveRateHz: updates / duration * 1000,
    maxCorrectCurveGapMs: Math.max(...runs.map((run) => run.stress.maxCorrectCurveGapMs)),
    rawTrials: runs,
  };
}

const improvement = (upstream, candidate, higherIsBetter = false) => higherIsBetter
  ? (candidate - upstream) / upstream * 100
  : (upstream - candidate) / upstream * 100;

function comparison(upstream, candidate) {
  return [
    { metric: "input-to-correct-paint p50", unit: "ms", upstream: upstream.correctPaintMs.p50, candidate: candidate.correctPaintMs.p50 },
    { metric: "input-to-correct-paint p95", unit: "ms", upstream: upstream.correctPaintMs.p95, candidate: candidate.correctPaintMs.p95 },
    { metric: "frame time p95", unit: "ms", upstream: upstream.frameTimeMs.p95, candidate: candidate.frameTimeMs.p95 },
    { metric: "estimated dropped frames", unit: "%", upstream: upstream.droppedFramePercent, candidate: candidate.droppedFramePercent },
    { metric: "correct curve update rate", unit: "Hz", upstream: upstream.correctCurveRateHz, candidate: candidate.correctCurveRateHz, higherIsBetter: true },
    { metric: "maximum correct curve gap", unit: "ms", upstream: upstream.maxCorrectCurveGapMs, candidate: candidate.maxCorrectCurveGapMs },
  ].map((row) => ({ ...row, improvementPercent: improvement(row.upstream, row.candidate, row.higherIsBetter) }));
}

const format = (value, digits = 2) => Number(value.toFixed(digits));

try {
  const [upstreamVariant, candidateVariant] = await Promise.all([
    buildVariant(baselineRef, "upstream"),
    buildVariant(candidateRef, "candidate"),
  ]);
  const runs = { upstream: [], candidate: [] };
  for (let trial = 0; trial < trials; trial++) {
    const order = trial % 2 === 0 ? ["upstream", "candidate"] : ["candidate", "upstream"];
    for (const key of order) {
      const variant = key === "upstream" ? upstreamVariant : candidateVariant;
      runs[key].push(await runVariant(`${key}-${trial + 1}`, variant, key === "candidate" && trial === 0));
    }
  }
  const variants = {
    upstream: aggregate(runs.upstream, upstreamVariant.workerBundle),
    candidate: aggregate(runs.candidate, candidateVariant.workerBundle),
  };
  const candidateChecks = variants.candidate.correctness || {};
  const failedChecks = Object.entries(candidateChecks).filter(([, passed]) => !passed).map(([name]) => name);
  if (!variants.candidate.workerBundle) failedChecks.push("realWorkerBundle");
  if (failedChecks.length) throw new Error(`Candidate correctness checks failed: ${failedChecks.join(", ")}`);
  const report = {
    generatedAt: new Date().toISOString(),
    revisions: { upstream: revision(baselineRef), candidate: revision(candidateRef) },
    protocol: {
      fixture: "100-waypoint profiled spline plus a 3-waypoint path-switch fixture",
      viewport: "1440x900 offscreen Electron compositor at 60 Hz",
      input: `mouse input at 120 Hz; ${latencySamples} isolated latency samples; ${stressMs} ms stress; ${trials} alternating trials`,
      correctPaint: "input dispatch to the first compositor paint after the waypoint matches in screen and pre-drag SVG coordinates and the centerline contains it",
      droppedFrames: "missed 16.67 ms requestAnimationFrame slots during continuous input",
      worker: "production Vite bundle with its emitted Web Worker; no worker replacement or mock",
    },
    variants,
    comparison: comparison(variants.upstream, variants.candidate),
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`upstream ${report.revisions.upstream} vs candidate ${report.revisions.candidate}\n\n`);
  process.stdout.write("| Metric | Upstream | Candidate | Improvement |\n| --- | ---: | ---: | ---: |\n");
  for (const row of report.comparison) {
    process.stdout.write(`| ${row.metric} | ${format(row.upstream)} ${row.unit} | ${format(row.candidate)} ${row.unit} | ${format(row.improvementPercent, 1)}% |\n`);
  }
  process.stdout.write(`\nRaw report: ${path.relative(repository, output)}\n`);
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
