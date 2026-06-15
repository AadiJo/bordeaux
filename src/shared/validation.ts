import type { BordeauxProject, ValidationIssue, ValidationResult } from "./types";
import { FIELD_H, FIELD_W } from "./math/fieldBounds";

function issue(path: string, message: string, severity: "error" | "warning" = "error"): ValidationIssue {
  return { path, message, severity };
}

export function validateProject(project: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!project || typeof project !== "object") {
    return { ok: false, issues: [issue("$", "Project must be a JSON object")] };
  }

  const p = project as BordeauxProject;
  if (!p.name || typeof p.name !== "string") issues.push(issue("$.name", "Project name is required"));
  if (!p.robot || typeof p.robot !== "object") issues.push(issue("$.robot", "Robot config is required"));
  if (!Array.isArray(p.paths)) issues.push(issue("$.paths", "Project paths must be an array"));

  if (p.robot) {
    if (p.robot.drive !== "swerve" && p.robot.drive !== "tank") issues.push(issue("$.robot.drive", "Drive must be swerve or tank"));
    if (!(p.robot.w > 0)) issues.push(issue("$.robot.w", "Robot width must be greater than zero"));
    if (!(p.robot.l > 0)) issues.push(issue("$.robot.l", "Robot length must be greater than zero"));
    if (!(p.robot.maxSpeed > 0)) issues.push(issue("$.robot.maxSpeed", "Robot max speed must be greater than zero"));
  }

  (p.paths || []).forEach((path, pi) => {
    const base = `$.paths[${pi}]`;
    if (!path.name) issues.push(issue(`${base}.name`, "Path name is required"));
    if (!Array.isArray(path.waypoints) || path.waypoints.length < 2) {
      issues.push(issue(`${base}.waypoints`, "Path must contain at least two waypoints"));
    }
    (path.waypoints || []).forEach((wp, wi) => {
      if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y)) issues.push(issue(`${base}.waypoints[${wi}]`, "Waypoint position must be finite"));
      else if (wp.x < 0 || wp.x > FIELD_W || wp.y < 0 || wp.y > FIELD_H) {
        issues.push(issue(`${base}.waypoints[${wi}]`, "Waypoint must stay inside the FRC field bounds"));
      }
      if (!wp.prevC || !wp.nextC) issues.push(issue(`${base}.waypoints[${wi}]`, "Waypoint handles are required"));
    });
    if (!path.constraints) {
      issues.push(issue(`${base}.constraints`, "Path constraints are required"));
    } else {
      if (!(path.constraints.maxVel > 0)) issues.push(issue(`${base}.constraints.maxVel`, "Max velocity must be greater than zero"));
      if (!(path.constraints.maxAccel > 0)) issues.push(issue(`${base}.constraints.maxAccel`, "Max acceleration must be greater than zero"));
      if (!(path.constraints.maxDecel > 0)) issues.push(issue(`${base}.constraints.maxDecel`, "Max deceleration must be greater than zero"));
    }
  });

  return { ok: issues.every((x) => x.severity !== "error"), issues };
}
