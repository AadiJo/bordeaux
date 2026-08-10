import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AppUpdateController, supportsAppUpdates, usesGitHubAppUpdates, type UpdatePresenter, type UpdateRuntime } from "../src/electron/appUpdates";

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  allowDowngrade = true;
  channel: string | null = null;
  checks = 0;
  checkResult: Promise<unknown> = Promise.resolve(null);
  quitAndInstall = vi.fn();

  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    return this.checkResult;
  }
}

function fixture(overrides: Partial<UpdateRuntime> = {}) {
  const updater = new FakeUpdater();
  const calls: string[] = [];
  const presenter: UpdatePresenter = {
    unavailable: () => { calls.push("unavailable"); },
    downloading: (version) => { calls.push(`downloading:${version}`); },
    upToDate: (version) => { calls.push(`current:${version}`); },
    failed: (message) => { calls.push(`failed:${message}`); },
    ready: async (version, dirty) => { calls.push(`ready:${version}:${dirty}`); return "later" as const; },
  };
  let dirty = false;
  const runtime: UpdateRuntime = {
    packaged: true,
    supported: true,
    currentVersion: "0.2.0-beta.1",
    isProjectDirty: () => dirty,
    warn: () => undefined,
    ...overrides,
  };
  const controller = new AppUpdateController(updater, presenter, runtime);
  return {
    updater, presenter, runtime, controller, calls,
    setDirty(value: boolean) { dirty = value; },
  };
}

describe("application updates", () => {
  it("supports every Electron desktop platform", () => {
    expect(["darwin", "win32", "linux"].every((platform) => supportsAppUpdates(platform as NodeJS.Platform))).toBe(true);
    expect(supportsAppUpdates("aix")).toBe(false);
  });

  it("leaves Store-installed Windows updates to Microsoft", () => {
    expect(usesGitHubAppUpdates("win32", true)).toBe(false);
    expect(usesGitHubAppUpdates("win32", false)).toBe(true);
    expect(usesGitHubAppUpdates("darwin", false)).toBe(true);
  });

  it("configures packaged desktop builds for the GitHub beta channel", () => {
    const { controller, updater } = fixture();
    controller.start();
    expect(updater).toMatchObject({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      allowDowngrade: false,
      channel: "beta",
    });
  });

  it("never contacts the update feed from development builds", async () => {
    const { controller, updater, calls } = fixture({ packaged: false });
    await controller.check(false);
    await controller.check(true);
    expect(updater.checks).toBe(0);
    expect(calls).toEqual(["unavailable"]);
  });

  it("does not require an update client in unavailable builds", async () => {
    const { presenter, runtime, calls } = fixture({ packaged: false });
    const controller = new AppUpdateController(null, presenter, runtime);
    await controller.check(true);
    expect(calls).toEqual(["unavailable"]);
  });

  it("reports interactive availability without making automatic checks noisy", async () => {
    const automatic = fixture();
    const automaticCheck = automatic.controller.check(false);
    automatic.updater.emit("update-not-available", { version: "0.2.0-beta.1" });
    await automaticCheck;
    expect(automatic.calls).toEqual([]);

    const interactive = fixture();
    const interactiveCheck = interactive.controller.check(true);
    interactive.updater.emit("update-available", { version: "0.2.0-beta.2" });
    await interactiveCheck;
    expect(interactive.calls).toEqual(["downloading:0.2.0-beta.2"]);
  });

  it("contains update-check errors and reports them once", async () => {
    const { controller, updater, calls } = fixture();
    updater.checkResult = Promise.reject(new Error("feed unavailable"));
    await controller.check(true);
    expect(calls).toEqual(["failed:feed unavailable"]);
  });

  it("reports a download failure after an interactive check found an update", async () => {
    const { controller, updater, calls } = fixture();
    const check = controller.check(true);
    updater.emit("update-available", { version: "0.2.0-beta.2" });
    await check;
    updater.emit("error", new Error("download failed"));
    expect(calls).toEqual(["downloading:0.2.0-beta.2", "failed:download failed"]);
  });

  it("installs only after an explicit clean-project restart", async () => {
    const clean = fixture();
    clean.presenter.ready = async () => "restart" as const;
    clean.controller.start();
    clean.updater.emit("update-downloaded", { version: "0.2.0-beta.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clean.updater.quitAndInstall).toHaveBeenCalledWith(false, true);

    const dirty = fixture();
    dirty.setDirty(true);
    dirty.presenter.ready = async () => "restart" as const;
    dirty.controller.start();
    dirty.updater.emit("update-downloaded", { version: "0.2.0-beta.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dirty.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
