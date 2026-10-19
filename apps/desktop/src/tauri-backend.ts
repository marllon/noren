import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { OutputStream, fontNameList, sniffImageMime } from "@noren/model";
import type {
  Backend,
  BackgroundImageFile,
  CreateSessionOptions,
  GitInfo,
  ModFile,
  SessionExit,
  SessionId,
  ShellProfile,
  Unsubscribe,
  UserProfile,
  WindowEffect,
  WindowEffectReport,
  WindowScheme,
} from "@noren/model";

/** The part of a Tauri `Channel` this backend uses. */
export interface ChannelLike<T> {
  onmessage: (message: T) => void;
}

/** What the backend needs from `@tauri-apps/api`, injected so tests can fake it. */
export interface TauriBridge {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
  createChannel<T>(): ChannelLike<T>;
}

/** The bridge on top of the real `@tauri-apps/api`. */
export function tauriBridge(): TauriBridge {
  return {
    invoke: (command, args) => invoke(command, args),
    listen: (event, handler) => listen(event, handler),
    createChannel: <T>() => new Channel<T>(),
  };
}

/** Payload of the `session-exit` event emitted by the Rust side. */
interface SessionExitPayload {
  id: number;
  code: number;
  signal?: string | null;
}

const SESSION_EXIT_EVENT = "session-exit";

/** Event emitted by the Rust side when `config.jsonc` changes; the payload is the new text or `null`. */
const CONFIG_CHANGED_EVENT = "config-changed";

/** Event emitted by the Rust side when a mod file is added, changed or removed; the payload is the whole list. */
const MODS_CHANGED_EVENT = "mods-changed";

/** `Backend` over the Tauri commands in `src-tauri/src/bridge.rs`. */
export class TauriBackend implements Backend {
  readonly #bridge: TauriBridge;
  readonly #streams = new Map<SessionId, OutputStream>();
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  /** Ids already handed to `session_kill`, so the exit event does not kill them again. */
  readonly #released = new Set<SessionId>();
  /** Exits that arrived before `session_create` returned the id. */
  readonly #earlyExits = new Map<SessionId, SessionExit>();
  readonly #configListeners = new Set<(text: string | null) => void>();
  readonly #modListeners = new Set<(files: ModFile[]) => void>();
  #exitSubscription: Promise<() => void> | undefined;
  #configSubscription: Promise<() => void> | undefined;
  #modSubscription: Promise<() => void> | undefined;

  constructor(bridge: TauriBridge = tauriBridge()) {
    this.#bridge = bridge;
  }

  listProfiles(): Promise<ShellProfile[]> {
    return this.#bridge.invoke<ShellProfile[]>("profiles_list");
  }

  async setUserProfiles(profiles: readonly UserProfile[]): Promise<void> {
    await this.#bridge.invoke("profiles_set_user", { profiles });
  }

  async createSession(options: CreateSessionOptions): Promise<SessionId> {
    // The exit event must be heard before the shell exists, or a quick exit could be missed.
    await this.#listenForExits();

    const stream = new OutputStream();
    const channel = this.#bridge.createChannel<ArrayBuffer>();
    channel.onmessage = (message) => stream.push(new Uint8Array(message));

    const id = await this.#bridge.invoke<SessionId>("session_create", {
      cols: options.cols,
      rows: options.rows,
      onOutput: channel,
      ...(options.profileId !== undefined ? { profileId: options.profileId } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    this.#streams.set(id, stream);

    const early = this.#earlyExits.get(id);
    if (early) {
      this.#earlyExits.delete(id);
      this.#handleExit(early);
    }
    return id;
  }

  async write(id: SessionId, data: string | Uint8Array): Promise<void> {
    await this.#bridge.invoke("session_write", {
      id,
      data: typeof data === "string" ? data : Array.from(data),
    });
  }

  async resize(id: SessionId, cols: number, rows: number): Promise<void> {
    await this.#bridge.invoke("session_resize", { id, cols, rows });
  }

  async kill(id: SessionId): Promise<void> {
    this.#released.add(id);
    await this.#bridge.invoke("session_kill", { id });
  }

  onOutput(id: SessionId, callback: (data: Uint8Array) => void): Unsubscribe {
    // A session that already ended has no stream left; there is nothing more to deliver.
    return this.#streams.get(id)?.subscribe(callback) ?? (() => undefined);
  }

  onExit(callback: (exit: SessionExit) => void): Unsubscribe {
    this.#exitListeners.add(callback);
    void this.#listenForExits().catch(() => undefined);
    return () => {
      this.#exitListeners.delete(callback);
    };
  }

  loadState(): Promise<string | null> {
    return this.#bridge.invoke<string | null>("state_load");
  }

  async saveState(content: string): Promise<void> {
    await this.#bridge.invoke("state_save", { content });
  }

  quarantineState(): Promise<string> {
    return this.#bridge.invoke<string>("state_quarantine");
  }

  loadScrollback(paneId: string): Promise<string | null> {
    return this.#bridge.invoke<string | null>("scrollback_load", { paneId });
  }

  async saveScrollback(paneId: string, text: string): Promise<void> {
    await this.#bridge.invoke("scrollback_save", { paneId, content: text });
  }

  listScrollback(): Promise<string[]> {
    return this.#bridge.invoke<string[]>("scrollback_list");
  }

  async deleteScrollback(paneId: string): Promise<void> {
    await this.#bridge.invoke("scrollback_delete", { paneId });
  }

  loadConfig(): Promise<string | null> {
    return this.#bridge.invoke<string | null>("config_load");
  }

  async saveConfig(text: string): Promise<void> {
    await this.#bridge.invoke("config_save", { content: text });
  }

  listUserThemes(): Promise<string[]> {
    return this.#bridge.invoke<string[]>("theme_list");
  }

  async saveUserTheme(id: string, text: string): Promise<void> {
    await this.#bridge.invoke("theme_save", { id, content: text });
  }

  async listMods(): Promise<ModFile[]> {
    const files = await this.#bridge.invoke<ModFile[]>("mod_list");
    return files.map(({ name, text }) => ({ name, text }));
  }

  watchMods(callback: (files: ModFile[]) => void): Unsubscribe {
    this.#modListeners.add(callback);
    this.#startWatchingMods();
    return () => {
      this.#modListeners.delete(callback);
    };
  }

  watchConfig(callback: (text: string | null) => void): Unsubscribe {
    this.#configListeners.add(callback);
    this.#startWatchingConfig();
    return () => {
      this.#configListeners.delete(callback);
    };
  }

  async setWindowEffect(effect: WindowEffect, scheme: WindowScheme): Promise<WindowEffectReport> {
    const report = await this.#bridge.invoke<WindowEffectReport>("window_effect_set", {
      effect,
      scheme,
    });
    return {
      requested: report.requested,
      applied: report.applied,
      ...(report.reason !== undefined && report.reason !== null ? { reason: report.reason } : {}),
    };
  }

  async readBackgroundImage(path: string): Promise<BackgroundImageFile> {
    // A raw response arrives as an ArrayBuffer; a plain list of numbers is read too, for a bridge
    // that has no binary channel.
    const answer = await this.#bridge.invoke<ArrayBuffer | number[]>("background_image_read", {
      path,
    });
    const bytes = answer instanceof ArrayBuffer ? new Uint8Array(answer) : Uint8Array.from(answer);
    const mime = sniffImageMime(bytes);
    if (mime === undefined) throw new Error(`${path} is not a picture Noren can show.`);
    return { mime, bytes };
  }

  async listMonospaceFonts(): Promise<string[]> {
    // The Rust side already keeps only family names; the page does not take its word for it.
    return fontNameList(await this.#bridge.invoke<unknown[]>("fonts_list_monospace"));
  }

  readActionsFile(cwd: string): Promise<string | null> {
    return this.#bridge.invoke<string | null>("project_actions_read", { cwd });
  }

  runCommand(cwd: string, command: string): Promise<number> {
    return this.#bridge.invoke<number>("project_command_run", { cwd, command });
  }

  async gitInfo(cwd: string): Promise<GitInfo | null> {
    const info = await this.#bridge.invoke<GitInfo | null>("git_info", { cwd });
    return info === null ? null : { branch: info.branch, detached: info.detached };
  }

  async notify(title: string, body: string): Promise<void> {
    await this.#bridge.invoke("notify_show", { title, body });
  }

  isWindowFocused(): Promise<boolean> {
    return this.#bridge.invoke<boolean>("window_is_focused");
  }

  /** Stops listening to `session-exit` and `config-changed`. Sessions still running will keep their ids until killed. */
  async dispose(): Promise<void> {
    const subscription = this.#exitSubscription;
    this.#exitSubscription = undefined;
    if (subscription) (await subscription)();
    const config = this.#configSubscription;
    this.#configSubscription = undefined;
    this.#configListeners.clear();
    if (config) (await config.catch(() => undefined))?.();
    const mods = this.#modSubscription;
    this.#modSubscription = undefined;
    this.#modListeners.clear();
    if (mods) (await mods.catch(() => undefined))?.();
  }

  /**
   * Hears `mods-changed` first and only then asks the Rust side to start watching, so no change is
   * missed. Done once; if it fails the mods stay as they were loaded, and the next `watchMods`
   * tries again.
   */
  #startWatchingMods(): void {
    if (this.#modSubscription) return;
    const subscription = this.#bridge
      .listen<ModFile[]>(MODS_CHANGED_EVENT, (event) => {
        for (const listener of [...this.#modListeners]) {
          listener(event.payload.map(({ name, text }) => ({ name, text })));
        }
      })
      .then(async (unlisten) => {
        try {
          await this.#bridge.invoke("mod_watch");
        } catch (error) {
          unlisten();
          throw error;
        }
        return unlisten;
      });
    this.#modSubscription = subscription;
    subscription.catch(() => {
      if (this.#modSubscription === subscription) this.#modSubscription = undefined;
    });
  }

  /**
   * Hears `config-changed` first and only then asks the Rust side to start watching, so no change
   * is missed. Done once; if it fails the settings still load, they only stop following the file,
   * and the next `watchConfig` tries again.
   */
  #startWatchingConfig(): void {
    if (this.#configSubscription) return;
    const subscription = this.#bridge
      .listen<string | null>(CONFIG_CHANGED_EVENT, (event) => {
        for (const listener of [...this.#configListeners]) listener(event.payload);
      })
      .then(async (unlisten) => {
        try {
          await this.#bridge.invoke("config_watch");
        } catch (error) {
          unlisten();
          throw error;
        }
        return unlisten;
      });
    this.#configSubscription = subscription;
    subscription.catch(() => {
      if (this.#configSubscription === subscription) this.#configSubscription = undefined;
    });
  }

  #listenForExits(): Promise<() => void> {
    this.#exitSubscription ??= this.#bridge.listen<SessionExitPayload>(
      SESSION_EXIT_EVENT,
      (event) => {
        const { id, code, signal } = event.payload;
        const exit: SessionExit = { id, code, ...(signal ? { signal } : {}) };
        if (this.#streams.has(id)) this.#handleExit(exit);
        else this.#earlyExits.set(id, exit);
      },
    );
    return this.#exitSubscription;
  }

  #handleExit(exit: SessionExit): void {
    this.#streams.delete(exit.id);
    for (const listener of [...this.#exitListeners]) listener(exit);
    // The Rust session manager only frees an id in `session_kill`, never by itself.
    if (!this.#released.delete(exit.id)) {
      this.#bridge.invoke("session_kill", { id: exit.id }).catch(() => undefined);
    }
  }
}
