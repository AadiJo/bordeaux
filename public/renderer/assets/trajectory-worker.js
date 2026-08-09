self.window = self;
importScripts('trajectory-optimizer.js', 'path-math.js', 'trajectory-geometry-optimizer.js');

self.onmessage = (event) => {
  const request = event.data || {};
  try {
    const value = request.operation === 'refineGeometry'
      ? self.TrajectoryGeometryOptimizer.refine(request.path, request.robot, request.perSegment, request.options)
      : self.PM.derivePath(request.path, request.robot, request.perSegment, 'optimizedTrajectory');
    self.postMessage({ generation: request.generation, ok: true, value });
  } catch (error) {
    self.postMessage({
      generation: request.generation,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
