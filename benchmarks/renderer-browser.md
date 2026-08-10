# Renderer browser benchmark

Run `npm run benchmark:renderer:browser` from a clean checkout after fetching
`origin/main`. The default protocol compares the merge base of `HEAD` and
`origin/main` with `HEAD`, alternating their order across three trials. Raw JSON
is written to the ignored `.benchmark-results/renderer-browser.json` file.

The fixture is a 100-waypoint profiled spline in a 1440×900 offscreen Electron
window. Each variant uses its production Vite bundle and real preview worker.
The harness verifies terminal pointer coordinates, save/dirty behavior, undo,
path-switch cancellation, and matching waypoint/curve geometry before timing.

Latency is measured from Electron input dispatch to the first compositor paint
where both the dragged waypoint and the SVG centerline match that input. The
probe checks both screen position and SVG-local coordinates against the
pre-drag transform, so viewport movement cannot masquerade as a path edit. The
stress phase sends pointer input at 120 Hz and reports frame-time, estimated
dropped frames, correct-curve update rate, and the longest correct-curve gap.

Useful overrides:

```sh
npm run benchmark:renderer:browser -- --baseline <ref> --candidate <ref>
npm run benchmark:renderer:browser -- --trials 5 --latency-samples 48 --stress-ms 3000
npm run benchmark:renderer:browser -- --output .benchmark-results/custom.json
```

Keep the machine otherwise idle. Compare results from the same machine and
display stack; Electron, Chrome, Node, revisions, raw trials, and protocol are
recorded in the JSON report. Generated results are evidence, not source, and
must not be committed.
