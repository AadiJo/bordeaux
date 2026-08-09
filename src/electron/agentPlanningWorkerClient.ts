import path from "node:path";
import { Worker } from "node:worker_threads";
import type { AgentPlanningJob, AgentPlanningRunner } from "./agentSession";

export const runAgentPlanningInWorker: AgentPlanningRunner = (job: AgentPlanningJob, signal?: AbortSignal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error("Agent planning was canceled.")); return; }
  const worker = new Worker(path.join(__dirname, "agentPlanningWorker.js"));
  let settled = false;
  const finish = (error?: Error, result?: unknown) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", cancel);
    worker.removeAllListeners();
    void worker.terminate();
    error ? reject(error) : resolve(result);
  };
  const cancel = () => finish(new Error("Agent planning was canceled."));
  signal?.addEventListener("abort", cancel, { once: true });
  worker.once("message", (message: { result?: unknown; error?: string }) => {
    if (message.error) finish(new Error(message.error));
    else finish(undefined, message.result);
  });
  worker.once("error", (error) => finish(error));
  worker.once("exit", (code) => {
    if (!settled) finish(new Error(code === 0 ? "Agent planning worker exited without a result" : `Agent planning worker exited with code ${code}`));
  });
  worker.postMessage(job);
});
