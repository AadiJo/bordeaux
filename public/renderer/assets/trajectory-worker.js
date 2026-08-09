self.window = self;
importScripts('trajectory-optimizer.js', 'path-math.js');

self.onmessage = (event) => {
  const request = event.data || {};
  try {
    const value = self.PM.derivePath(request.path, request.robot, request.perSegment, 'optimizedTrajectory');
    self.postMessage({ generation: request.generation, ok: true, value });
  } catch (error) {
    self.postMessage({
      generation: request.generation,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
