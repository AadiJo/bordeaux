import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentBridgeClient, AgentBridgeServer } from "../src/electron/agentBridge";
import { AgentSessionService, runAgentPlanningJobDirect } from "../src/electron/agentSession";
import { createDemoProject } from "../src/shared/project/defaults";

function snapshot(revision = 0) {
  const project = createDemoProject();
  return {
    sessionId: "session_test",
    revision,
    project,
    activePathId: project.paths[0].id,
    allianceView: "blue" as const,
    fieldPack: { id: "2026-rebuilt" as const, revision: "test" },
  };
}

describe("agent session and private bridge", () => {
  it("cancels an in-flight planning job when the editor revision changes", async () => {
    let aborted = false;
    const service = new AgentSessionService(() => {}, () => null, (_job, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("planning worker aborted"));
      }, { once: true });
    }));
    const initial = snapshot();
    service.publishSnapshot(initial);

    const pending = service.request({ method: "analyze_path", params: {} });
    service.publishSnapshot({ ...initial, revision: 1 });

    await expect(pending).rejects.toThrow("planning worker aborted");
    expect(aborted).toBe(true);
  });

  it("does not start planning for an already-canceled request", async () => {
    let invoked = false;
    const service = new AgentSessionService(() => {}, () => null, async () => {
      invoked = true;
      return { findings: [] };
    });
    service.publishSnapshot(snapshot());
    const controller = new AbortController();
    controller.abort();

    await expect(service.request({ method: "analyze_path", params: {} }, controller.signal)).rejects.toThrow("Agent planning was canceled");
    expect(invoked).toBe(false);
  });

  it("allows independent read-only planning jobs to complete concurrently", async () => {
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const service = new AgentSessionService(() => {}, () => null, async (job, signal) => {
      if (signal) signals.push(signal);
      await new Promise<void>((resolve) => releases.push(resolve));
      return runAgentPlanningJobDirect(job);
    });
    service.publishSnapshot(snapshot());

    const first = service.request({ method: "analyze_path", params: {} });
    const second = service.request({ method: "analyze_path", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(releases).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    releases.forEach((release) => release());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("keeps preview-producing planning jobs newest-wins", async () => {
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const staged: string[] = [];
    const service = new AgentSessionService((proposal) => { staged.push(proposal.intent); }, () => null, (job, signal) => new Promise((resolve, reject) => {
      if (signal) {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("planning worker aborted")), { once: true });
      }
      releases.push(() => resolve(runAgentPlanningJobDirect(job)));
    }));
    service.publishSnapshot(snapshot());

    const first = service.request({ method: "plan_path", params: {
      intent: "First preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });
    const firstRejected = expect(first).rejects.toThrow("planning worker aborted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = service.request({ method: "plan_path", params: {
      intent: "Second preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    releases[1]();
    await firstRejected;
    await expect(second).resolves.toMatchObject({ status: "ready", intent: "Second preview" });
    expect(staged).toEqual(["Second preview"]);
  });

  it("rejects an explicit stale context before starting planning", async () => {
    let invoked = false;
    const service = new AgentSessionService(() => {}, () => null, async () => {
      invoked = true;
      return {};
    });
    const initial = snapshot();
    service.publishSnapshot(initial);
    const context = { sessionId: initial.sessionId, revision: initial.revision, activePathId: initial.activePathId };
    service.publishSnapshot({ ...initial, revision: 1 });

    const result: any = await service.request({ method: "plan_path", params: {
      context, intent: "Stale request", alliance: "blue", goals: [{ x: 3, y: 1 }],
    } });

    expect(result).toMatchObject({ status: "stale_context", code: "STALE_CONTEXT", currentContext: { revision: 1 } });
    expect(invoked).toBe(false);
  });

  it("keeps field orientation separate from physical alliance ownership", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const initial = snapshot();
    service.publishSnapshot(initial);
    const uncolored: any[] = await service.request({ method: "resolve_field_terms", params: { phrases: ["left trench"] } }) as any[];
    expect(uncolored[0].status).toBe("unresolved");

    const blue: any[] = await service.request({ method: "resolve_field_terms", params: { phrases: ["left trench"], alliance: "blue" } }) as any[];
    service.publishSnapshot({ ...initial, revision: 1, allianceView: "red" });
    const flippedBlue: any[] = await service.request({ method: "resolve_field_terms", params: { phrases: ["left trench"], alliance: "blue" } }) as any[];
    expect(flippedBlue[0].matches[0].point).toEqual(blue[0].matches[0].point);
    expect(flippedBlue[0].matches[0].displayPoint).not.toEqual(blue[0].matches[0].displayPoint);
  });

  it("ignores invalid transient snapshots without replacing the last valid session", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const initial = snapshot();
    service.publishSnapshot(initial);

    const invalid = structuredClone(initial);
    invalid.revision = 1;
    invalid.project.robot.drive = "tank";
    invalid.project.paths[0].ranges.push({
      anchor: "param", f0: 0, f1: 1, rotationPriority: "translation",
      maxVel: 1, maxAccel: 1, maxAngVel: 90, maxAngAccel: 180,
    });

    expect(service.tryPublishSnapshot(invalid)).toBe(false);
    expect(await service.request({ method: "inspect_session" })).toMatchObject({
      sessionId: initial.sessionId,
      revision: initial.revision,
    });
  });

  it("stages proposals without changing the renderer snapshot and marks them stale on edit", async () => {
    const staged: any[] = [];
    const service = new AgentSessionService((proposal) => { staged.push(proposal); }, () => null);
    const initial = snapshot();
    service.publishSnapshot(initial);
    const proposal: any = await service.request({ method: "plan_path", params: { intent: "Go forward", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1 } });
    expect(staged).toHaveLength(1);
    expect(service.getActiveProposal()?.id).toBe(proposal.proposalId);
    expect(proposal.recommendedCandidate.valid).toBe(true);
    expect(proposal.candidates[0].path).toBeUndefined();
    expect(JSON.stringify(proposal).length).toBeLessThan(5_000);
    expect(initial.project.paths).toHaveLength(1);
    service.publishSnapshot({ ...initial, revision: 1 });
    expect(service.getActiveProposal()).toBeNull();
    const stale: any = await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } });
    expect(stale.status).toBe("stale");

    const nextSession = { ...initial, sessionId: "session_reopened", revision: 0 };
    service.publishSnapshot(nextSession);
    expect((await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } }) as any).status).toBe("stale");
  });

  it("returns invalid route candidates as a compact blocked result without staging", async () => {
    const staged: any[] = [];
    const service = new AgentSessionService((proposal) => { staged.push(proposal); }, () => null, async (job, signal) => {
      if (signal?.aborted) throw new Error("planning canceled");
      const result = await runAgentPlanningJobDirect(job);
      if (job.kind !== "route") return result;
      return (result as any[]).map((candidate) => ({ ...candidate, valid: false, rejectionReason: "Forced evaluation failure." }));
    });
    service.publishSnapshot(snapshot());

    const outcome: any = await service.request({ method: "plan_path", params: {
      intent: "Invalid preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });

    expect(outcome).toMatchObject({ status: "blocked", code: "NO_VALID_CANDIDATE", proposalId: null });
    expect(outcome.candidates[0]).toMatchObject({ valid: false, rejectionReason: "Forced evaluation failure." });
    expect(outcome.candidates[0].path).toBeUndefined();
    expect(staged).toHaveLength(0);
    expect(service.getActiveProposal()).toBeNull();
  });

  it("does not retain a ready proposal when the editor cannot receive it", async () => {
    const service = new AgentSessionService(() => { throw new Error("editor closed"); }, () => null);
    service.publishSnapshot(snapshot());
    await expect(service.request({ method: "plan_path", params: { intent: "Go", alliance: "blue", goals: [{ x: 3, y: 1 }], maximumCandidates: 1 } })).rejects.toThrow("editor closed");
    service.clearSnapshot();
    await expect(service.request({ method: "inspect_session" })).rejects.toThrow(/finish loading/);
  });

  it("waits for a renderer receipt before returning a ready proposal", async () => {
    let acknowledge: (() => void) | undefined;
    const service = new AgentSessionService((_proposal, requireReceipt) => requireReceipt ? new Promise<void>((resolve) => { acknowledge = resolve; }) : undefined, () => null);
    service.publishSnapshot(snapshot());
    let completed = false;
    const pending = service.request({ method: "plan_path", params: { intent: "Wait for preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1 } }).then((value) => { completed = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    acknowledge?.();
    expect((await pending as any).status).toBe("ready");
  });

  it("rolls back staging when cancellation arrives during renderer acknowledgment", async () => {
    let waitForReceipt = false;
    let proposalReceived: (() => void) | undefined;
    const notifications: Array<{ id: string; intent: string; status: string }> = [];
    const service = new AgentSessionService((proposal, requireReceipt) => {
      notifications.push({ id: proposal.id, intent: proposal.intent, status: proposal.status });
      if (!requireReceipt || !waitForReceipt) return;
      proposalReceived?.();
      return new Promise<void>(() => {});
    }, () => null);
    service.publishSnapshot(snapshot());
    const first: any = await service.request({ method: "plan_path", params: {
      intent: "Existing preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });

    waitForReceipt = true;
    const received = new Promise<void>((resolve) => { proposalReceived = resolve; });
    const controller = new AbortController();
    const pending = service.request({ method: "plan_path", params: {
      intent: "Abandoned preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } }, controller.signal);
    await received;
    controller.abort();

    await expect(pending).rejects.toThrow("Agent request was canceled");
    expect(service.getActiveProposal()?.id).toBe(first.proposalId);
    expect((await service.request({ method: "get_proposal", params: { proposalId: first.proposalId } }) as any).status).toBe("ready");
    expect(notifications.slice(-2)).toEqual([
      expect.objectContaining({ intent: "Abandoned preview", status: "stale" }),
      expect.objectContaining({ intent: "Existing preview", status: "ready" }),
    ]);
  });

  it("does not let an older staging failure restore a preview superseded by a newer proposal", async () => {
    let rejectOlder: ((error: Error) => void) | undefined;
    let olderReceived: (() => void) | undefined;
    const notifications: Array<{ intent: string; status: string }> = [];
    const service = new AgentSessionService((proposal, requireReceipt) => {
      notifications.push({ intent: proposal.intent, status: proposal.status });
      if (requireReceipt && proposal.intent === "Older pending preview") {
        olderReceived?.();
        return new Promise<void>((_resolve, reject) => { rejectOlder = reject; });
      }
    }, () => null);
    service.publishSnapshot(snapshot());
    const original: any = await service.request({ method: "plan_path", params: {
      intent: "Original preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });

    const received = new Promise<void>((resolve) => { olderReceived = resolve; });
    const older = service.request({ method: "plan_path", params: {
      intent: "Older pending preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });
    const olderRejected = expect(older).rejects.toThrow("renderer rejected older preview");
    await received;
    const newest: any = await service.request({ method: "plan_path", params: {
      intent: "Newest preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2.5, y: 1 }], maximumCandidates: 1,
    } });
    rejectOlder?.(new Error("renderer rejected older preview"));
    await olderRejected;

    expect(service.getActiveProposal()?.id).toBe(newest.proposalId);
    expect((await service.request({ method: "get_proposal", params: { proposalId: original.proposalId } }) as any).status).toBe("stale");
    expect((await service.request({ method: "get_proposal", params: { proposalId: newest.proposalId } }) as any).status).toBe("ready");
    expect(notifications.at(-1)).toEqual({ intent: "Newest preview", status: "ready" });
  });

  it("keeps only the newest proposal ready for the single preview surface", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    service.publishSnapshot(snapshot());
    const first: any = await service.request({ method: "plan_path", params: { intent: "First", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1 } });
    const second: any = await service.request({ method: "plan_path", params: { intent: "Second", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1 } });
    expect(second.status).toBe("ready");
    expect(second.supersededProposalId).toBe(first.proposalId);
    expect((await service.request({ method: "get_proposal", params: { proposalId: first.proposalId } }) as any).status).toBe("stale");
  });

  it("interviews for missing robot facts and stages profile answers without mutating the snapshot", async () => {
    const staged: any[] = [];
    const service = new AgentSessionService((proposal) => { staged.push(proposal); }, () => null);
    const initial = snapshot();
    service.publishSnapshot(initial);
    const inspection: any = await service.request({ method: "inspect_robot_profile" });
    expect(inspection.completeForFuelCollection).toBe(false);
    expect(inspection.questions.join(" ")).toContain("maximum safe collection speed");
    const planning = {
      intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.72, maxCollectSpeedMps: 2 },
      shooter: { directionDeg: 0, requiresTargetFacing: true, preferredRangeM: 2.5 },
      notes: "Keep the intake down throughout the collection span.",
    };
    const proposal: any = await service.request({ method: "propose_robot_profile", params: { intent: "Use the team's mechanism details", planning } });
    expect(proposal).toMatchObject({ operation: "configureRobot", status: "ready", recommendedCandidate: null });
    expect(staged).toHaveLength(1);
    expect(staged[0].planning).toEqual(planning);
    expect(initial.project.robot.planning).toBeUndefined();
    service.publishSnapshot({ ...initial, revision: 1 });
    expect((await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } }) as any).status).toBe("stale");
  });

  it("merges partial robot interview answers without erasing existing mechanism facts", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const initial = snapshot();
    initial.project.robot.planning = {
      intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.72, maxCollectSpeedMps: 2 },
      notes: "Keep the intake deployed while collecting.",
    };
    service.publishSnapshot(initial);
    const proposal: any = await service.request({ method: "propose_robot_profile", params: {
      intent: "Add the newly answered shooter details",
      planning: { shooter: { directionDeg: 180, requiresTargetFacing: true, preferredRangeM: 2.4 } },
    } });
    const full: any = await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId, detail: "full" } });
    expect(full.planning).toEqual({
      ...initial.project.robot.planning,
      shooter: { directionDeg: 180, requiresTargetFacing: true, preferredRangeM: 2.4 },
    });
  });

  it("binds an end action only through an explicit authoritative semantic tag", async () => {
    const catalog: any = {
      authoritative: true,
      commands: [{
        id: "robot.shoot", label: "Shoot", aliases: ["shoot"], semanticTags: ["shoot-fuel"], runtimeReady: true,
        ownerType: "robot.Actions", member: "shoot", kind: "factory", confidence: "confirmed", parameters: [], source: { file: "robot/Actions.java", line: 1 },
      }],
      warnings: [],
    };
    const service = new AgentSessionService(() => {}, () => catalog);
    service.publishSnapshot(snapshot());
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
    } });
    const fullProposal: any = await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId, detail: "full" } });
    expect(fullProposal.candidates[0].path.markers[0].invocation.commandId).toBe("robot.shoot");
    await expect(service.request({ method: "plan_path", params: {
      intent: "Drive and intake", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "intake-fuel" },
    } })).rejects.toThrow(/must match exactly one runtime-ready command/);

    catalog.commands.push({ ...catalog.commands[0], id: "robot.shootAlternate" });
    await expect(service.request({ method: "plan_path", params: {
      intent: "Ambiguous shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
    } })).rejects.toThrow(/found 2/);

    const bound = snapshot();
    bound.project.strategy = { actionBindings: [{ semanticTag: "shoot-fuel", commandId: "robot.shootAlternate" }] };
    service.publishSnapshot(bound);
    const boundProposal: any = await service.request({ method: "plan_path", params: {
      intent: "Bound shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shootAlternate", semanticTag: "shoot-fuel" },
    } });
    const fullBoundProposal: any = await service.request({ method: "get_proposal", params: { proposalId: boundProposal.proposalId, detail: "full" } });
    expect(fullBoundProposal.candidates[0].path.markers[0].invocation.commandId).toBe("robot.shootAlternate");
  });

  it("preserves an unbound shooting request without blocking valid geometry", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    service.publishSnapshot(snapshot());
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endActionIntent: { semanticTag: "shoot-fuel", description: "shoot into the HUB" },
    } });
    expect(proposal.blockingIssues).toBeUndefined();
    expect(proposal.advisories).toEqual([expect.stringContaining("shoot-fuel")]);
    const full: any = await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId, detail: "full" } });
    expect(full.candidates[0].path.markers).toEqual([expect.objectContaining({
      f: 1,
      cmd: "none",
      actionIntent: { semanticTag: "shoot-fuel", description: "shoot into the HUB" },
    })]);
  });

  it("requires an explicit shooting target when the robot profile requires target-facing alignment", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const initial = snapshot();
    initial.project.robot.planning = { shooter: { directionDeg: 0, requiresTargetFacing: true } };
    service.publishSnapshot(initial);
    const outcome: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endActionIntent: { semanticTag: "shoot-fuel", description: "shoot into the HUB" },
    } });
    expect(outcome).toMatchObject({ status: "needs_input", code: "TARGET_FACING_REQUIRED" });
  });

  it("authenticates a user-private framed IPC request", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-agent-test-"));
    const alternateTmp = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-client-tmp-"));
    const originalTmp = process.env.TMPDIR;
    const service = new AgentSessionService(() => {}, () => null);
    service.publishSnapshot(snapshot());
    const server = new AgentBridgeServer(directory, service);
    try {
      await server.start();
      process.env.TMPDIR = alternateTmp;
      const result: any = await new AgentBridgeClient(directory).request({ method: "inspect_session" });
      expect(result.sessionId).toBe("session_test");
    } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rm(alternateTmp, { recursive: true, force: true });
    }
  });
});
