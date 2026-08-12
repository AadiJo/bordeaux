import { describe, expect, it } from "vitest";
import { AUTO } from "../src/renderer/lib/routineModel";
import { createDemoProject } from "../src/shared/project/defaults";
import { normalizeProject } from "../src/shared/project/normalize";
import { validateProject } from "../src/shared/validation";

describe("renderer routine model", () => {
  it("creates collision-safe IDs after loading legacy routine nodes", () => {
    const project = createDemoProject();
    const pathId = project.paths[0].id;
    const legacyNodes = [
      { id: "p_1", type: "path", ref: pathId },
      { id: "d_2", type: "decision", cond: "robot.ready", thenLabel: "Yes", elseLabel: "No", then: [], else: [] },
      { id: "c_3", type: "function", cat: "command", title: "Legacy command", invocation: null },
      { id: "g_4", type: "function", cat: "generate", funcRef: "GeneratePath", trigger: "On entry" },
      { id: "s_5", type: "function", cat: "sequence", op: "skip", trigger: "When condition is true" },
      { id: "v_6", type: "function", cat: "velocity", title: "Legacy velocity", trigger: "When condition is true", scale: 0.5 },
      { id: "f_7", type: "function", cat: "terminate", title: "Legacy terminate", trigger: "When condition is true" },
    ];
    project.routines[0].nodes = legacyNodes;
    const loaded = normalizeProject(structuredClone(project));
    const routine = loaded.routines[0];
    const created = [
      AUTO.newNode("path", null, pathId),
      AUTO.newNode("decision", null, pathId),
      AUTO.newNode("function", "command", pathId),
      AUTO.newNode("function", "generate", pathId),
      AUTO.newNode("function", "sequence", pathId),
      AUTO.newNode("function", "velocity", pathId),
      AUTO.newNode("function", "terminate", pathId),
    ];
    const withCreated = { ...routine, nodes: [...routine.nodes, ...created] };
    const createdIds = created.map((node) => node.id);
    const legacyIds = new Set(legacyNodes.map((node) => node.id));

    expect(createdIds.every((id) => !legacyIds.has(id))).toBe(true);
    expect(new Set(createdIds).size).toBe(createdIds.length);
    expect(validateProject({ ...loaded, routines: [withCreated] })).toEqual({ ok: true, issues: [] });

    const command = created[2];
    const updated = AUTO.update(withCreated, command.id, { title: "Updated command" });
    expect(AUTO.findNode(updated, "c_3").title).toBe("Legacy command");
    expect(AUTO.findNode(updated, command.id).title).toBe("Updated command");

    const removed = AUTO.remove(updated, command.id);
    expect(AUTO.findNode(removed, "c_3")).not.toBeNull();
    expect(AUTO.findNode(removed, command.id)).toBeNull();
    expect(validateProject({ ...loaded, routines: [removed] })).toEqual({ ok: true, issues: [] });
  });
});
