# Renderer browser benchmark

Run `npm run benchmark:renderer:browser` from a clean checkout after fetching
`origin/main`. The default protocol compares the merge base of `HEAD` and
`origin/main` with `HEAD`, alternating their order across three trials. Raw JSON
is written to the ignored `.benchmark-results/renderer-browser.json` file.

The fixture is a 100-waypoint profiled spline in a 1440×900 offscreen Electron
window. Each variant uses its production Vite bundle. Before timing the candidate,
the harness loads its emitted preview worker and requires a real request/result
round trip, then verifies terminal pointer coordinates, save/dirty behavior,
undo, path-switch cancellation, and matching waypoint/curve geometry.

Latency is measured from Electron input dispatch to the first compositor bitmap
that contains sample-specific colors on the exact dragged waypoint and
centerline nodes. The renderer applies those colors only after screen position,
SVG-local position, and centerline containment match the input; the main process
then verifies both colors in the offscreen `NativeImage`. The stress phase sends
pointer input at 120 Hz and reports frame-time, estimated dropped frames,
correct-curve update rate, and the longest correct-curve gap.

Useful overrides:

```sh
npm run benchmark:renderer:browser -- --baseline <ref> --candidate <ref>
npm run benchmark:renderer:browser -- --trials 5 --latency-samples 48 --stress-ms 3000
npm run benchmark:renderer:browser -- --correctness-only
npm run benchmark:renderer:browser -- --output .benchmark-results/custom.json
```

Keep the machine otherwise idle. Compare results from the same machine and
display stack; Electron, Chrome, Node, revisions, raw trials, and protocol are
recorded in the JSON report. Generated results are evidence, not source, and
must not be committed.

Each Electron child has a two-minute watchdog by default. Override it with
`--variant-timeout-ms` when deliberately running a slower fixture.
