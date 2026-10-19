import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { OutputStream } from "@noren/model";
import type {
  Backend,
  CreateSessionOptions,
  GitInfo,
  SessionExit,
  SessionId,
  ShellProfile,
  Unsubscribe,
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

/** `Backend` over the Tauri commands in `src-tauri/src/bridge.rs`. */
export class TauriBackend implements Backend {
  readonly #bridge: TauriBridge;
  readonly #streams = new Map<SessionId, OutputStream>();
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  /** Ids already handed to `session_kill`, so the exit event does not kill them again. */
  readonly #released = new Set<SessionId>();
  /** Exits that arrived before `session_create` returned the id. */
  readonly #earlyExits = new Map<SessionId, SessionExit>();
  #exitSubscription: Promise<() => void> | undefined;

  constructor(bridge: TauriBridge = tauriBridge()) {
    this.#bridge = bridge;
  }

  listProfiles(): Promise<ShellProfile[]> {
    return this.#bridge.invoke<ShellProfile[]>("profiles_list");
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

  /** Stops listening to `session-exit`. Sessions still running will keep their ids until killed. */
  async dispose(): Promise<void> {
    const subscription = this.#exitSubscription;
    this.#exitSubscription = undefined;
    if (subscription) (await subscription)();
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
