import { isNewerVersion, isVersion } from "./update";
import type { UpdateInfo, UpdateProgress, UpdateStatus } from "./update";

// The update of the app itself (NOR-F20-02a) for the fake backend: the version that is running, a
// release feed in memory that a test fills, and the update the last check found. It follows
// `src-tauri/src/update.rs` step by step, with the same sentences: a check keeps the update only
// when it is a newer version, an install needs one found, a package the signature does not match is
// refused after it has come, and a successful install leaves the version running as it is (the
// app has to be restarted, or on Windows exits when the installer starts). Nothing here touches a
// network or runs an installer.

/** The version the fake says it is until a test says another. */
export const FAKE_CURRENT_VERSION = "0.1.0";

/** The size of the package, in bytes, when a release does not say. */
const DEFAULT_PACKAGE_BYTES = 48 * 1024 * 1024;

/** What the feed of the fake announces. */
export interface FakeRelease {
  /** The version announced (a leading `v` is dropped, as the app does). */
  version: string;
  notes?: string | null;
  /** In seconds since 1970. */
  publishedAt?: number | null;
  /** The size of the package in bytes, for the progress; 48 MiB when absent. */
  bytes?: number;
  /**
   * Why the package would be refused once it has been downloaded (the signature does not match the
   * key, say): the install then rejects with "the update was refused: <this>" and installs nothing.
   */
  refusal?: string;
}

/** The sentences of `noren_core::update::UpdateError` the fake can end with. */
export const UPDATE_MESSAGES = {
  notConfigured: "this build has no update key yet, so it cannot check or install updates",
  nothingToInstall: "there is no update to install: check first",
} as const;

export class FakeUpdates {
  #currentVersion = FAKE_CURRENT_VERSION;
  #configured = true;
  #release: FakeRelease | undefined;
  #pending: { info: UpdateInfo; release: FakeRelease } | undefined;
  #installed: string[] = [];
  #listeners = new Set<(progress: UpdateProgress) => void>();

  status(): UpdateStatus {
    return {
      configured: this.#configured,
      currentVersion: this.#currentVersion,
      pending: this.#pending === undefined ? null : { ...this.#pending.info },
    };
  }

  check(): UpdateInfo | null {
    this.#requireConfigured();
    const release = this.#release;
    if (release === undefined) {
      this.#pending = undefined;
      return null;
    }
    const version = release.version.startsWith("v") ? release.version.slice(1) : release.version;
    if (!isVersion(version)) {
      this.#pending = undefined;
      throw new Error(
        "the update feed is not usable: it does not follow the format of the updater",
      );
    }
    if (!isNewerVersion(version, this.#currentVersion)) {
      this.#pending = undefined;
      return null;
    }
    const info: UpdateInfo = {
      version,
      currentVersion: this.#currentVersion,
      notes: release.notes ?? null,
      publishedAt: release.publishedAt ?? null,
    };
    this.#pending = { info, release };
    return { ...info };
  }

  /**
   * Downloads and installs the update found. The first quarter of the package is told, then the
   * install waits for `pause` (a test that wants to see a download half way holds it), then the
   * rest comes. With no `pause` the three pieces come one after the other.
   */
  async install(pause?: Promise<void>): Promise<void> {
    this.#requireConfigured();
    const pending = this.#pending;
    if (pending === undefined) throw new Error(UPDATE_MESSAGES.nothingToInstall);
    const total = pending.release.bytes ?? DEFAULT_PACKAGE_BYTES;
    const pieces = [Math.floor(total / 4), Math.floor(total / 2), total];
    const tell = (downloaded: number) => {
      for (const listener of [...this.#listeners]) listener({ downloaded, total });
    };
    tell(pieces[0] ?? 0);
    if (pause !== undefined) await pause;
    for (const downloaded of pieces.slice(1)) tell(downloaded);
    if (pending.release.refusal !== undefined) {
      throw new Error(`the update was refused: ${pending.release.refusal}`);
    }
    this.#installed.push(pending.info.version);
    this.#pending = undefined;
  }

  onProgress(callback: (progress: UpdateProgress) => void): () => void {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  // ---- what a test sets and reads -------------------------------------------------------------

  setCurrentVersion(version: string): void {
    this.#currentVersion = version;
  }

  setConfigured(configured: boolean): void {
    this.#configured = configured;
  }

  setRelease(release: FakeRelease | undefined): void {
    this.#release = release === undefined ? undefined : { ...release };
  }

  /** The versions installed, in order (installing is all the fake does with them). */
  installed(): string[] {
    return [...this.#installed];
  }

  #requireConfigured(): void {
    if (!this.#configured) throw new Error(UPDATE_MESSAGES.notConfigured);
  }
}
