import type { TrajectoryPlanner, TrajectoryPlannerId } from "../types";
import type { PlannerInput, PlannerResult } from "../types";
import { optimizedTrajectoryPlanner } from "./optimizedTrajectory";
import { profiledSplinePlanner } from "./profiledSpline";

export const planners: Record<TrajectoryPlannerId, TrajectoryPlanner> = {
  profiledSpline: profiledSplinePlanner,
  optimizedTrajectory: optimizedTrajectoryPlanner,
};

export function getPlanner(id: TrajectoryPlannerId): TrajectoryPlanner {
  const planner = planners[id];
  return planner;
}

export async function generateTrajectory(input: PlannerInput): Promise<PlannerResult> {
  const planner = getPlanner(input.plannerId ?? "profiledSpline");
  return planner.generate(input);
}
