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

export function supportsAppUpdates(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

export class AppUpdateController {
  private started = false;
  private interactiveCheck = false;
  private checkPromise: Promise<void> | null = null;
  private readonly promptedVersions = new Set<string>();

  constructor(
    private readonly updater: AppUpdaterLike | null,
    private readonly presenter: UpdatePresenter,
    private readonly runtime: UpdateRuntime,
  ) {}

  get available(): boolean {
    return this.runtime.packaged && this.runtime.supported && this.updater !== null;
  }

  start(): void {
    if (this.started || !this.available) return;
    const updater = this.updater;
    if (!updater) return;
    this.started = true;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = true;
    updater.channel = "beta";
    updater.allowDowngrade = false;

    updater.on("update-available", (info) => {
      if (!this.interactiveCheck) return;
      void this.presenter.downloading(info.version);
    });
    updater.on("update-not-available", () => {
      if (!this.interactiveCheck) return;
      this.interactiveCheck = false;
      void this.presenter.upToDate(this.runtime.currentVersion);
    });
    updater.on("error", (error) => {
      this.runtime.warn("Bordeaux update check failed", error);
      if (!this.interactiveCheck) return;
      this.interactiveCheck = false;
      void this.presenter.failed(errorMessage(error));
    });
    updater.on("update-downloaded", (info) => {
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
    const updater = this.updater;
    if (!updater) return;
    this.interactiveCheck ||= interactive;
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = (async () => {
      try {
        await updater.checkForUpdates();
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
    this.updater?.quitAndInstall(false, true);
  }
}
