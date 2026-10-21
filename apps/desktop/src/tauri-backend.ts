import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WINDOW_CLOSED_EVENT, windowIdOfPayload } from "./window-events";
import {
  AI_ERROR_KINDS,
  OutputStream,
  benchHardwareOf,
  decodeFilePreview,
  decodeGitDiff,
  fontNameList,
  sniffImageMime,
} from "@noren/model";
import type {
  AgentEntry,
  AgentHit,
  AiBackend,
  AiChatEvent,
  AiChatRequest,
  AiConnectionResult,
  AiErrorKind,
  AiProviderConfig,
  AiProviderInfo,
  AttachSessionOptions,
  Backend,
  BackgroundImageFile,
  BenchHardware,
  BenchResultFile,
  BrowserBounds,
  BrowserOpenOptions,
  CreateSessionOptions,
  FilePreview,
  GitDiff,
  GitInfo,
  Id,
  ModFile,
  OllamaMemoryReading,
  OllamaModels,
  SessionExit,
  SessionId,
  SessionLink,
  SessionLinkState,
  ShellProfile,
  TerminalTail,
  Unsubscribe,
  UserProfile,
  WindowEffect,
  WindowEffectReport,
  WindowScheme,
  Worktree,
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

/**
 * Payload of the `session-link` event: the connection of a session of an SSH profile changed. The
 * Rust side leaves out what does not apply to the state.
 */
interface SessionLinkPayload {
  id: number;
  state: SessionLinkState;
  attempt?: number | null;
  maxAttempts?: number | null;
  retryInMs?: number | null;
  reason?: string | null;
}

const SESSION_LINK_EVENT = "session-link";

/** Event emitted by the Rust side when `config.jsonc` changes; the payload is the new text or `null`. */
const CONFIG_CHANGED_EVENT = "config-changed";

/** Event emitted by the Rust side when a mod file is added, changed or removed; the payload is the whole list. */
const MODS_CHANGED_EVENT = "mods-changed";

/** What `ai_test_connection` answers: `kind` and `message` are there for a failure. */
interface ConnectionReportPayload {
  ok: boolean;
  kind?: AiErrorKind | null;
  message?: string | null;
}

/**
 * How long `ai.chat` waits for the last event after `ai_chat_stream` has returned. The Rust side
 * sends the end of the stream before it returns, but the channel and the answer of the command are
 * two roads to the page; if the end has not come by then it will not, and the request ends with an
 * error instead of hanging.
 */
export const AI_END_GRACE_MS = 2000;

/** What the channel of `ai_chat_stream` delivers: the shape is `AiStreamEvent` in `ai.rs`. */
interface AiStreamPayload {
  type?: unknown;
  text?: unknown;
  kind?: unknown;
  message?: unknown;
  outputTokens?: unknown;
}

/** A worktree as the bridge sends it, copied field by field so nothing else rides along. */
function worktreeOf(raw: Worktree): Worktree {
  return {
    path: raw.path,
    branch: raw.branch,
    head: raw.head,
    detached: raw.detached,
    main: raw.main,
    locked: raw.locked,
  };
}

/** One event of the channel as the model's `AiChatEvent`, or `undefined` for something that is not one. */
function chatEventOf(payload: AiStreamPayload): AiChatEvent | undefined {
  if (payload.type === "delta" && typeof payload.text === "string") {
    return { type: "delta", text: payload.text };
  }
  if (payload.type === "done") {
    // The Rust side leaves the count out when the provider gave none; anything that is not a
    // whole number of tokens is treated as none.
    const count = payload.outputTokens;
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? { type: "done", outputTokens: count }
      : { type: "done" };
  }
  if (payload.type === "error") {
    const kind = AI_ERROR_KINDS.find((known) => known === payload.kind) ?? "protocol";
    const message =
      typeof payload.message === "string"
        ? payload.message
        : "the provider gave an answer Noren could not read";
    return { type: "error", kind, message };
  }
  return undefined;
}

/** The AI side of `Backend` over the commands in `src-tauri/src/ai.rs`. */
function tauriAi(bridge: TauriBridge): AiBackend {
  return {
    async providers(): Promise<AiProviderInfo[]> {
      const list = await bridge.invoke<AiProviderInfo[]>("ai_providers");
      // The Rust side never sends a key; the page copies the fields it knows and nothing else.
      return list.map(({ id, kind, baseUrl, model, hasKey }) => ({
        id,
        kind,
        baseUrl,
        model,
        hasKey,
      }));
    },

    async configure(providers: readonly AiProviderConfig[]): Promise<void> {
      // Only the four fields of a provider cross the bridge, whatever the objects carry: a key
      // never travels with the list, and the Rust side would refuse the list if it did.
      await bridge.invoke("ai_configure", {
        providers: providers.map(({ id, kind, baseUrl, model }) => ({ id, kind, baseUrl, model })),
      });
    },

    async setKey(providerId: string, key: string): Promise<void> {
      await bridge.invoke("ai_set_key", { providerId, key });
    },

    async listOllamaModels(): Promise<OllamaModels> {
      const found = await bridge.invoke<{ found: boolean; models: string[] }>("ai_ollama_models");
      return found.found ? { found: true, models: [...found.models] } : { found: false };
    },

    async ollamaMemory(model: string): Promise<OllamaMemoryReading | null> {
      const memory = await bridge.invoke<{ bytes: number; vramBytes: number } | null>(
        "ai_ollama_memory",
        { model },
      );
      // The Rust side already refuses anything but whole numbers of 0 or more; a page that is
      // handed something else is not handed a measurement.
      if (
        memory === null ||
        typeof memory !== "object" ||
        !Number.isSafeInteger(memory.bytes) ||
        !Number.isSafeInteger(memory.vramBytes) ||
        memory.bytes < 0 ||
        memory.vramBytes < 0
      ) {
        return null;
      }
      return { bytes: memory.bytes, vramBytes: memory.vramBytes };
    },

    async testConnection(providerId: string): Promise<AiConnectionResult> {
      const report = await bridge.invoke<ConnectionReportPayload>("ai_test_connection", {
        providerId,
      });
      if (report.ok) return { ok: true };
      return {
        ok: false,
        kind: report.kind ?? "protocol",
        message: report.message ?? "the provider gave an answer Noren could not read",
      };
    },

    async chat(request: AiChatRequest, onEvent: (event: AiChatEvent) => void): Promise<void> {
      let ended = false;
      let release: () => void = () => undefined;
      const endSeen = new Promise<void>((resolve) => {
        release = resolve;
      });
      const channel = bridge.createChannel<AiStreamPayload>();
      channel.onmessage = (payload) => {
        // One end, and nothing after it: the Rust side promises that, and the page does not rely on it.
        if (ended) return;
        const event = chatEventOf(payload);
        if (event === undefined) return;
        if (event.type !== "delta") ended = true;
        try {
          onEvent(event);
        } finally {
          if (ended) release();
        }
      };

      // The key is not in the request and does not travel: the Rust side reads it from the keychain.
      const model = request.model?.trim();
      await bridge.invoke("ai_chat_stream", {
        providerId: request.providerId,
        requestId: request.requestId,
        ...(model !== undefined && model !== "" ? { model } : {}),
        messages: request.messages.map(({ role, content }) => ({ role, content })),
        onEvent: channel,
      });
      if (ended) return;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, AI_END_GRACE_MS);
      });
      await Promise.race([endSeen, late]);
      clearTimeout(timer);
      if (!ended) {
        ended = true;
        onEvent({
          type: "error",
          kind: "protocol",
          message: "the answer ended without a final event",
        });
      }
    },

    async cancel(requestId: string): Promise<boolean> {
      return bridge.invoke<boolean>("ai_cancel", { requestId });
    },
  };
}

export interface TauriBackendOptions {
  /**
   * The tail that takes the output of every session this backend holds (the main window gives it,
   * for `terminal.read` of the local API); a session that ends is forgotten by it.
   */
  tail?: TerminalTail;
}

/** `Backend` over the Tauri commands in `src-tauri/src/bridge.rs`. */
export class TauriBackend implements Backend {
  readonly ai: AiBackend;
  readonly #bridge: TauriBridge;
  readonly #streams = new Map<SessionId, OutputStream>();
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  /** Ids already handed to `session_kill`, so the exit event does not kill them again. */
  readonly #released = new Set<SessionId>();
  /** Exits that arrived before `session_create` returned the id. */
  readonly #earlyExits = new Map<SessionId, SessionExit>();
  readonly #configListeners = new Set<(text: string | null) => void>();
  readonly #modListeners = new Set<(files: ModFile[]) => void>();
  readonly #linkListeners = new Set<(link: SessionLink) => void>();
  readonly #windowClosedListeners = new Set<(windowId: Id) => void>();
  #windowClosedSubscription: Promise<() => void> | undefined;
  #exitSubscription: Promise<() => void> | undefined;
  #linkSubscription: Promise<() => void> | undefined;
  #configSubscription: Promise<() => void> | undefined;
  #modSubscription: Promise<() => void> | undefined;

  /** Where the output of every session also goes, for `terminal.read` of the local API. */
  readonly #tail: TerminalTail | undefined;
  /** The taps on the streams, so a session that ends stops feeding the tail. */
  readonly #taps = new Map<SessionId, Unsubscribe>();

  constructor(bridge: TauriBridge = tauriBridge(), options: TauriBackendOptions = {}) {
    this.#bridge = bridge;
    this.#tail = options.tail;
    this.ai = tauriAi(bridge);
  }

  /**
   * Keeps the stream of a session and, when there is a tail, feeds it everything the session
   * prints. The tail listens by `tap`, so what is held for the first subscriber (the terminal view
   * of the pane) is still held for it; and it is told the moment the stream is kept, so the output
   * of a session no view ever mounted for is not lost either.
   */
  #track(id: SessionId, stream: OutputStream): void {
    this.#streams.set(id, stream);
    const tail = this.#tail;
    if (tail === undefined) return;
    this.#taps.get(id)?.();
    this.#taps.set(
      id,
      stream.tap((data) => tail.feed(id, data)),
    );
  }

  /** The session ended: nothing more is fed to the tail, and what it held is dropped. */
  #untrack(id: SessionId): void {
    this.#taps.get(id)?.();
    this.#taps.delete(id);
    this.#tail?.forget(id);
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
      ...(options.paneId !== undefined ? { paneId: options.paneId } : {}),
    });
    this.#track(id, stream);

    const early = this.#earlyExits.get(id);
    if (early) {
      this.#earlyExits.delete(id);
      this.#handleExit(early);
    }
    return id;
  }

  async attachSession(id: SessionId, options?: AttachSessionOptions): Promise<void> {
    await this.#listenForExits();

    // The stream is not kept until the Rust side moved the output here: a rejected call (the session
    // is gone) leaves nothing behind. What arrives in between is held by the stream, and with
    // `replay` what the session printed before comes first (the Rust side sends it ahead of the
    // output that follows, from the buffer the session daemon keeps).
    const stream = new OutputStream();
    const channel = this.#bridge.createChannel<ArrayBuffer>();
    channel.onmessage = (message) => stream.push(new Uint8Array(message));
    await this.#bridge.invoke("session_attach", {
      id,
      onOutput: channel,
      ...(options?.replay === true ? { replay: true } : {}),
    });
    this.#track(id, stream);

    const early = this.#earlyExits.get(id);
    if (early) {
      this.#earlyExits.delete(id);
      this.#handleExit(early);
    }
  }

  async reattachSession(paneId: string): Promise<SessionId | undefined> {
    await this.#listenForExits();

    // As `attachSession`: what the shell printed while no app was there, and after, is held by the
    // stream until the terminal of the pane subscribes. A pane with no shell to come back to leaves
    // nothing behind but a stream nobody uses.
    const stream = new OutputStream();
    const channel = this.#bridge.createChannel<ArrayBuffer>();
    channel.onmessage = (message) => stream.push(new Uint8Array(message));
    const id = await this.#bridge.invoke<SessionId | null>("session_reattach", {
      paneId,
      onOutput: channel,
    });
    if (id === null) return undefined;
    this.#track(id, stream);

    const early = this.#earlyExits.get(id);
    if (early) {
      this.#earlyExits.delete(id);
      this.#handleExit(early);
    }
    return id;
  }

  async setKeepSessions(keep: boolean): Promise<void> {
    await this.#bridge.invoke("sessions_keep_set", { keep });
  }

  async quickToggle(): Promise<boolean> {
    return this.#bridge.invoke<boolean>("quick_toggle");
  }

  async setQuickShortcut(chord: string | null): Promise<void> {
    await this.#bridge.invoke("quick_shortcut_set", { chord });
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
    this.#untrack(id);
    await this.#bridge.invoke("session_kill", { id });
  }

  onSessionLink(callback: (link: SessionLink) => void): Unsubscribe {
    this.#linkListeners.add(callback);
    this.#listenForLinks();
    return () => {
      this.#linkListeners.delete(callback);
    };
  }

  async retrySession(id: SessionId): Promise<void> {
    await this.#bridge.invoke("session_retry", { id });
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

  saveBenchResult(text: string): Promise<string> {
    return this.#bridge.invoke<string>("bench_save", { content: text });
  }

  async listBenchResults(): Promise<BenchResultFile[]> {
    const files = await this.#bridge.invoke<BenchResultFile[]>("bench_list");
    return files.map(({ name, text }) => ({ name, text }));
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

  async readHardware(): Promise<BenchHardware | null> {
    // The Rust side already keeps only whole numbers above 0 that a JavaScript number holds
    // exactly; a page that is handed something else is not handed a measurement. A RAM that is
    // not one is no reading, a VRAM that is not one is an unknown VRAM.
    return benchHardwareOf(await this.#bridge.invoke<unknown>("hardware_read"));
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

  async listWorktrees(cwd: string): Promise<Worktree[]> {
    const list = await this.#bridge.invoke<Worktree[]>("worktree_list", { cwd });
    return list.map(worktreeOf);
  }

  async createWorktree(cwd: string, branch: string): Promise<Worktree> {
    return worktreeOf(await this.#bridge.invoke<Worktree>("worktree_create", { cwd, branch }));
  }

  async removeWorktree(cwd: string, path: string): Promise<void> {
    await this.#bridge.invoke("worktree_remove", { cwd, path });
  }

  async listSshHosts(): Promise<string[]> {
    const hosts = await this.#bridge.invoke<unknown>("ssh_hosts_list");
    return Array.isArray(hosts)
      ? hosts.filter((host): host is string => typeof host === "string")
      : [];
  }

  async scanAgents(
    sessionIds: readonly SessionId[],
    catalog: readonly AgentEntry[],
  ): Promise<AgentHit[]> {
    const hits = await this.#bridge.invoke<AgentHit[]>("agents_scan", {
      sessionIds: [...sessionIds],
      catalog: catalog.map((entry) => ({
        id: entry.id,
        executables: [...entry.executables],
        packages: [...(entry.packages ?? [])],
      })),
    });
    return hits.map((hit) => ({ sessionId: hit.sessionId, agentId: hit.agentId }));
  }

  async notify(title: string, body: string): Promise<void> {
    await this.#bridge.invoke("notify_show", { title, body });
  }

  isWindowFocused(): Promise<boolean> {
    return this.#bridge.invoke<boolean>("window_is_focused");
  }

  async openExternal(url: string): Promise<void> {
    await this.#bridge.invoke("link_open", { url });
  }

  async openBrowserPane(
    paneId: Id,
    url: string,
    bounds: BrowserBounds,
    options?: BrowserOpenOptions,
  ): Promise<void> {
    const windowId = options?.windowId;
    await this.#bridge.invoke("browser_open", {
      paneId,
      url,
      bounds,
      ...(windowId !== undefined ? { windowId } : {}),
    });
  }

  async navigateBrowserPane(paneId: Id, url: string): Promise<void> {
    await this.#bridge.invoke("browser_navigate", { paneId, url });
  }

  async setBrowserPaneBounds(paneId: Id, bounds: BrowserBounds): Promise<void> {
    await this.#bridge.invoke("browser_set_bounds", { paneId, bounds });
  }

  async closeBrowserPane(paneId: Id): Promise<void> {
    await this.#bridge.invoke("browser_close", { paneId });
  }

  async openWindow(windowId: Id, spaceId: Id): Promise<void> {
    await this.#bridge.invoke("window_open", { windowId, spaceId });
  }

  async closeWindow(windowId: Id): Promise<void> {
    await this.#bridge.invoke("window_close", { windowId });
  }

  async moveTabToWindow(windowId: Id, sessionIds: readonly SessionId[]): Promise<void> {
    // The Rust side tells the page of the window, which takes the output over (`session_attach`
    // from its own page), and answers when it has.
    await this.#bridge.invoke("window_move_tab", { windowId, sessionIds: [...sessionIds] });
  }

  onWindowClosed(callback: (windowId: Id) => void): Unsubscribe {
    this.#windowClosedListeners.add(callback);
    this.#listenForWindowClosed();
    return () => {
      this.#windowClosedListeners.delete(callback);
    };
  }

  async readFilePreview(path: string): Promise<FilePreview> {
    // One raw frame (a picture is megabytes); a plain list of numbers is read too, for a bridge
    // that has no binary channel. A file that is not shown is an answer; only a frame that cannot
    // be read, or a failure of the command itself, rejects.
    const answer = await this.#bridge.invoke<ArrayBuffer | number[]>("file_preview_read", { path });
    return decodeFilePreview(
      answer instanceof ArrayBuffer ? new Uint8Array(answer) : Uint8Array.from(answer),
    );
  }

  async readGitDiff(cwd: string): Promise<GitDiff> {
    // A folder git cannot be run in is an answer; only an answer the shell has no right to give, or
    // a failure of the command itself, rejects.
    return decodeGitDiff(await this.#bridge.invoke<unknown>("git_diff_read", { cwd }));
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
    const windows = this.#windowClosedSubscription;
    this.#windowClosedSubscription = undefined;
    this.#windowClosedListeners.clear();
    if (windows) (await windows.catch(() => undefined))?.();
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

  /** Hears `window-closed` once; if that fails the next `onWindowClosed` tries again. */
  #listenForWindowClosed(): void {
    if (this.#windowClosedSubscription) return;
    const subscription = this.#bridge.listen<unknown>(WINDOW_CLOSED_EVENT, (event) => {
      const windowId = windowIdOfPayload(event.payload);
      if (windowId === undefined) return;
      for (const listener of [...this.#windowClosedListeners]) listener(windowId);
    });
    this.#windowClosedSubscription = subscription;
    subscription.catch(() => {
      if (this.#windowClosedSubscription === subscription)
        this.#windowClosedSubscription = undefined;
    });
  }

  /** Hears `session-link` once; if that fails the next `onSessionLink` tries again. */
  #listenForLinks(): void {
    if (this.#linkSubscription) return;
    const subscription = this.#bridge.listen<SessionLinkPayload>(SESSION_LINK_EVENT, (event) => {
      const { id, state, attempt, maxAttempts, retryInMs, reason } = event.payload;
      const link: SessionLink = {
        id,
        state,
        ...(attempt != null ? { attempt } : {}),
        ...(maxAttempts != null ? { maxAttempts } : {}),
        ...(retryInMs != null ? { retryInMs } : {}),
        ...(reason != null ? { reason } : {}),
      };
      for (const listener of [...this.#linkListeners]) listener(link);
    });
    this.#linkSubscription = subscription;
    subscription.catch(() => {
      if (this.#linkSubscription === subscription) this.#linkSubscription = undefined;
    });
  }

  #handleExit(exit: SessionExit): void {
    this.#streams.delete(exit.id);
    this.#untrack(exit.id);
    for (const listener of [...this.#exitListeners]) listener(exit);
    // The Rust session manager only frees an id in `session_kill`, never by itself.
    if (!this.#released.delete(exit.id)) {
      this.#bridge.invoke("session_kill", { id: exit.id }).catch(() => undefined);
    }
  }
}
