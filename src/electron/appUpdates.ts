export interface UpdateVersionInfo {
  version: string;
}

export interface AppUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  channel: string | null;
  on(event: "update-available" | "update-not-available" | "update-downloaded", listener: (info: UpdateVersionInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdatePresenter {
  unavailable(currentVersion: string): void | Promise<void>;
  downloading(version: string): void | Promise<void>;
  upToDate(currentVersion: string): void | Promise<void>;
  failed(message: string): void | Promise<void>;
  ready(version: string, projectDirty: boolean): "later" | "restart" | Promise<"later" | "restart">;
}

export interface UpdateRuntime {
  packaged: boolean;
  supported: boolean;
  currentVersion: string;
  isProjectDirty(): boolean;
  warn(message: string, error?: unknown): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AppUpdateController {
  private started = false;
  private interactiveCheck = false;
  private checkPromise: Promise<void> | null = null;
  private readonly promptedVersions = new Set<string>();

  constructor(
    private readonly updater: AppUpdaterLike,
    private readonly presenter: UpdatePresenter,
    private readonly runtime: UpdateRuntime,
  ) {}

  get available(): boolean {
    return this.runtime.packaged && this.runtime.supported;
  }

  start(): void {
    if (this.started || !this.available) return;
    this.started = true;
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.allowPrerelease = true;
    this.updater.channel = "beta";
    this.updater.allowDowngrade = false;

    this.updater.on("update-available", (info) => {
      if (!this.interactiveCheck) return;
      void this.presenter.downloading(info.version);
    });
    this.updater.on("update-not-available", () => {
      if (!this.interactiveCheck) return;
      this.interactiveCheck = false;
      void this.presenter.upToDate(this.runtime.currentVersion);
    });
    this.updater.on("error", (error) => {
      this.runtime.warn("Bordeaux update check failed", error);
      if (!this.interactiveCheck) return;
      this.interactiveCheck = false;
      void this.presenter.failed(errorMessage(error));
    });
    this.updater.on("update-downloaded", (info) => {
      if (this.promptedVersions.has(info.version)) return;
      this.promptedVersions.add(info.version);
      this.interactiveCheck = false;
      void this.offerRestart(info.version);
    });
  }

  async check(interactive = false): Promise<void> {
    if (!this.available) {
      if (interactive) await this.presenter.unavailable(this.runtime.currentVersion);
      return;
    }
    this.start();
    this.interactiveCheck ||= interactive;
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = (async () => {
      try {
        await this.updater.checkForUpdates();
      } catch (error) {
        this.runtime.warn("Bordeaux update check failed", error);
        if (this.interactiveCheck) {
          this.interactiveCheck = false;
          await this.presenter.failed(errorMessage(error));
        }
      } finally {
        this.checkPromise = null;
      }
    })();
    return this.checkPromise;
  }

  private async offerRestart(version: string): Promise<void> {
    const projectDirty = this.runtime.isProjectDirty();
    const choice = await this.presenter.ready(version, projectDirty);
    if (choice !== "restart" || this.runtime.isProjectDirty()) return;
    this.updater.quitAndInstall(false, true);
  }
}
