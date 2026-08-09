import { parentPort } from "node:worker_threads";
import { runAgentPlanningJobDirect, type AgentPlanningJob } from "./agentSession";

if (!parentPort) throw new Error("Agent planning worker requires a parent port");

parentPort.once("message", (job: AgentPlanningJob) => {
  void runAgentPlanningJobDirect(job).then(
    (result) => parentPort!.postMessage({ result }),
    (error) => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
});
