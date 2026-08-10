export function createPathId(): string {
  return `path_${globalThis.crypto.randomUUID()}`;
}

export function createMarkerId(): string {
  return `event_${globalThis.crypto.randomUUID()}`;
}

export function createRoutineId(): string {
  return `routine_${globalThis.crypto.randomUUID()}`;
}

export function createPathLinkId(): string {
  return `pathlink_${globalThis.crypto.randomUUID()}`;
}
