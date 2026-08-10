import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { appUpdateChannel, AppUpdateController, supportsAppUpdates, usesGitHubAppUpdates, type UpdatePresenter, type UpdateRuntime } from "../src/electron/appUpdates";

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = false;
  allowDowngrade = true;
  channel: string | null = null;
  checks = 0;
  checkResult: Promise<unknown> = Promise.resolve({});
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
    prepareToInstall: () => undefined,
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
    expect(usesGitHubAppUpdates("win32", false, true)).toBe(false);
    expect(usesGitHubAppUpdates("darwin", false)).toBe(true);
    expect(usesGitHubAppUpdates("linux", false, false, true)).toBe(true);
    expect(usesGitHubAppUpdates("linux", false, false, false)).toBe(false);
  });

  it("keeps prereleases on beta and stable builds on production updates", () => {
    expect(appUpdateChannel("0.2.0-beta.1")).toBe("beta");
    expect(appUpdateChannel("0.2.0-rc.1")).toBe("beta");
    expect(appUpdateChannel("0.2.0")).toBe("latest");

    const { controller, updater } = fixture();
    controller.start();
    expect(updater).toMatchObject({
      autoDownload: true,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: true,
      allowDowngrade: false,
      channel: "beta",
    });

    const stable = fixture({ currentVersion: "0.2.0" });
    stable.controller.start();
    expect(stable.updater).toMatchObject({
      allowPrerelease: false,
      channel: "latest",
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

  it("reports an updater that cannot run in the current package format", async () => {
    const { controller, updater, calls } = fixture();
    updater.checkResult = Promise.resolve(null);
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
    const prepareToInstall = vi.fn();
    clean.runtime.prepareToInstall = prepareToInstall;
    clean.presenter.ready = async () => "restart" as const;
    clean.controller.start();
    clean.updater.emit("update-downloaded", { version: "0.2.0-beta.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prepareToInstall).toHaveBeenCalledOnce();
    expect(prepareToInstall.mock.invocationCallOrder[0]).toBeLessThan(clean.updater.quitAndInstall.mock.invocationCallOrder[0]);
    expect(clean.updater.quitAndInstall).toHaveBeenCalledWith(false, true);

    const dirty = fixture();
    dirty.setDirty(true);
    dirty.presenter.ready = async () => "restart" as const;
    dirty.controller.start();
    dirty.updater.emit("update-downloaded", { version: "0.2.0-beta.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dirty.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not install when backend shutdown fails", async () => {
    const { controller, updater, presenter, runtime, calls } = fixture();
    presenter.ready = async () => "restart" as const;
    runtime.prepareToInstall = async () => { throw new Error("backend is still running"); };
    controller.start();
    updater.emit("update-downloaded", { version: "0.2.0-beta.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(calls).toEqual(["failed:backend is still running"]);
  });

  it("does not install if the project changes during backend shutdown", async () => {
    const { controller, updater, presenter, runtime, setDirty } = fixture();
    presenter.ready = async () => "restart" as const;
    runtime.prepareToInstall = () => setDirty(true);
    controller.start();
    updater.emit("update-downloaded", { version: "0.2.0-beta.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("reports an updater error after installation begins", async () => {
    const { controller, updater, presenter, calls } = fixture();
    presenter.ready = async () => "restart" as const;
    controller.start();
    updater.emit("update-downloaded", { version: "0.2.0-beta.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    updater.emit("error", new Error("installer failed"));
    expect(calls).toEqual(["failed:installer failed"]);
  });

  it("can offer a downloaded update again after Later", async () => {
    const { controller, updater, presenter } = fixture();
    const ready = vi.fn(async () => "later" as const);
    presenter.ready = ready;
    controller.start();
    updater.emit("update-downloaded", { version: "0.2.0-beta.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    updater.emit("update-downloaded", { version: "0.2.0-beta.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ready).toHaveBeenCalledTimes(2);
  });
});
