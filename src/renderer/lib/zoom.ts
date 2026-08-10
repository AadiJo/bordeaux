export function wheelZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, viewportHeight) : 1);
  return Math.exp(Math.max(-120, Math.min(120, pixels)) * 0.0006);
}
