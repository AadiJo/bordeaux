export const FIELD_W = 17.548;
export const FIELD_H = 8.052;

export interface WorldPoint {
  x: number;
  y: number;
}

export function clampWorldPoint(point: WorldPoint): WorldPoint {
  return {
    x: Math.max(0, Math.min(FIELD_W, point.x)),
    y: Math.max(0, Math.min(FIELD_H, point.y)),
  };
}

