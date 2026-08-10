import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function editModule() {
  const window: Record<string, unknown> = {};
  const source = fs.readFileSync(new URL("../src/renderer/assets/path-edit.js", import.meta.url), "utf8")
    .replace("export const PathEdit =", "window.PathEdit =");
  vm.runInNewContext(source, { window, Object, Set });
  return window.PathEdit as {
    create<T>(): {
      begin(value: T): boolean;
      update(value: T): boolean;
      finish(): T | null;
      cancel(): boolean;
      getSnapshot(): T | null;
      subscribe(listener: () => void): () => void;
    };
  };
}

describe("renderer path edit store", () => {
  it("publishes drafts without committing and returns the final value once", () => {
    const edit = editModule().create<{ x: number }>();
    const listener = vi.fn();
    edit.subscribe(listener);

    expect(edit.begin({ x: 1 })).toBe(true);
    expect(edit.update({ x: 2 })).toBe(true);
    expect(edit.getSnapshot()).toEqual({ x: 2 });
    expect(listener).toHaveBeenCalledTimes(1);

    expect(edit.finish()).toEqual({ x: 2 });
    expect(edit.getSnapshot()).toBeNull();
    expect(edit.finish()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("discards canceled drafts and refuses nested sessions", () => {
    const edit = editModule().create<{ x: number }>();
    expect(edit.begin({ x: 1 })).toBe(true);
    expect(edit.begin({ x: 9 })).toBe(false);
    expect(edit.cancel()).toBe(true);
    expect(edit.getSnapshot()).toBeNull();
  });
});
