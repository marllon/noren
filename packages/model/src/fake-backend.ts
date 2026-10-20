import {
  AI_CHAT_ROLES,
  OLLAMA_BASE_URL,
  OLLAMA_PROVIDER_ID,
  AiProviderSchema,
  aiProvidersProblem,
} from "./ai";
import type {
  AiBackend,
  AiChatEvent,
  AiChatRequest,
  AiConnectionResult,
  AiErrorKind,
  AiProviderConfig,
  AiProviderInfo,
  OllamaModels,
} from "./ai";
import type { AgentEntry } from "./agents";
import type {
  AgentHit,
  Backend,
  CreateSessionOptions,
  GitInfo,
  ModFile,
  SessionExit,
  SessionId,
  SessionLink,
  SessionLinkState,
  ShellProfile,
  Unsubscribe,
  Worktree,
} from "./backend";
import { MAX_BACKGROUND_BYTES, backgroundImageProblem, sniffImageMime } from "./background";
import type { BackgroundImageFile } from "./background";
import { ManualClock } from "./clock";
import type { Clock } from "./clock";
import { sameFolder } from "./deep-link";
import {
  browserBoundsProblem,
  browserUrlProblem,
  isBrowserPaneId,
  type BrowserBounds,
} from "./browser";
import { externalLinkProblem } from "./external-link";
import { classifyPreviewPath, previewOf } from "./file-preview";
import type { FilePreview, PreviewEntry } from "./file-preview";
import type { GitDiff, GitDiffRefusal } from "./git-diff";
import { MAX_MOD_BYTES, MAX_MODS, isValidModFileName } from "./mods";
import { OutputStream } from "./output-stream";
import { MAX_SCROLLBACK_BYTES, isScrollbackPaneId } from "./scrollback";
import { fontNameList } from "./terminal-options";
import { THEME_ID_PATTERN } from "./theme";
import type { Id } from "./types";
import { isSshProfile, profilesProblem } from "./user-profile-schema";
import type { SshUserProfile, UserProfile } from "./user-profile-schema";
import { decodeUtf8, encodeUtf8 } from "./utf8";
import { WINDOW_EFFECT_LABELS } from "./window-effect";
import { isWindowId } from "./windows";
import { branchProblem, worktreeDestination } from "./worktree";
import type { WindowEffect, WindowEffectReport, WindowScheme } from "./window-effect";

const ESC = "\x1b";
const BEL = "\x07";
const PROMPT = "fake$ ";
const OUTPUT_CHUNK = 64 * 1024;
const LS_OUTPUT = "README.md  notes.txt  src";

const osc = (body: string): string => `${ESC}]${body}${BEL}`;

/** A command line as OSC 633;E carries it: backslash doubled, `;` and control characters as `\xNN`. */
const escapeCommandLine = (line: string): string =>
  // eslint-disable-next-line no-control-regex
  line.replace(/[\\;\u0000-\u001f\u007f]/g, (ch) =>
    ch === "\\" ? "\\\\" : `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

/** The monospaced families a fake computer has unless it is told otherwise: the fallbacks of the terminal. */
export const DEFAULT_MONOSPACE_FONTS: readonly string[] = [
  "Cascadia Mono",
  "Consolas",
  "DejaVu Sans Mono",
];

/** The name a call to the AI side is recorded under: `ai.providers`, `ai.setKey`, ... */
export type FakeAiMethod = `ai.${keyof AiBackend & string}`;

/** The name of a recorded call: a method of the `Backend`, or one of its `ai` member. */
export type FakeCallMethod = keyof Backend | FakeAiMethod;

/** One recorded call to a `Backend` method. Callbacks are not recorded. */
/** The web view of a browser pane in the fake: its place and its page. */
export interface FakeBrowserPane {
  url: string;
  bounds: BrowserBounds;
}

/** An open window of the fake: the space it shows and the sessions whose output it received. */
export interface FakeWindow {
  spaceId: Id;
  sessions: SessionId[];
}

/**
 * What stands in for the native side of the windows in a page that draws them (the e2e tests draw a
 * window as a panel next to the app): the real backend makes a window, closes it and hands it the
 * output of sessions in Rust; the fake tells this object instead. Nothing is shown unless a page
 * gives one (`FakeBackend.setWindowHost`).
 */
export interface FakeWindowHost {
  /** The window `windowId` was opened to show the space `spaceId`. */
  opened(windowId: Id, spaceId: Id): void;
  /** The window was closed, by the app or by the person. */
  closed(windowId: Id): void;
  /**
   * The window is to take over the output of the sessions. Resolves once it did; rejects when it
   * could not, which fails `moveTabToWindow` as a window that refuses fails it for real.
   */
  take(windowId: Id, sessionIds: readonly SessionId[]): Promise<void>;
}

export interface FakeCall {
  readonly method: FakeCallMethod;
  readonly args: readonly unknown[];
}

export interface FakeBackendOptions {
  /** Time source for `sleep`. Defaults to a `ManualClock` nobody advances. */
  clock?: Clock;
  profiles?: ShellProfile[];
  /** Host name in the OSC 7 URL. */
  host?: string;
  /** Directory sessions start in without `cwd`, and the target of a bare `cd`. */
  home?: string;
  /** Initial content of `state.json`. Defaults to `null` (no saved state). */
  state?: string | null;
  /** Initial `.noren/actions.json` texts, by folder. */
  actionsFiles?: Record<string, string>;
  /** Exit code `runCommand` resolves with. Defaults to 0. */
  commandExitCode?: number;
  /** Fake git repositories, by the folder that holds each one (`{ "/proj": { branch: "main", detached: false } }`). */
  gitRepos?: Record<string, GitInfo>;
  /** Initial text of `config.jsonc`. Defaults to `null` (no such file). */
  config?: string | null;
  /** Initial theme files of the user, by theme id (the text of `themes/<id>.json`). */
  userThemes?: Record<string, string>;
  /** Initial mod files of the user, by file name (the text of `mods/<name>.css`). */
  mods?: Record<string, string>;
  /** Initial scrollback snapshots, by pane id (the text of `scrollback/<paneId>.txt`). */
  scrollback?: Record<string, string>;
  /** The window effects this fake system can paint. Defaults to none: every effect falls back to opaque. */
  windowEffects?: readonly WindowEffect[];
  /** Picture files by path (as `readBackgroundImage` is asked for them). */
  images?: Record<string, Uint8Array>;
  /**
   * The files and folders of this fake computer, by full path, for `readFilePreview`: the bytes of
   * a file, or `"directory"`. A path that is not here is not there.
   */
  files?: Record<string, Uint8Array | "directory">;
  /**
   * The git diff each fake repository answers `readGitDiff` with, by the folder that holds it: the
   * text `git diff` would print, or the refusal to answer with. A folder inside it gets the same
   * answer, as in a real repository. A repository with no entry here (see `gitRepos`) has no
   * changes, and a folder in no repository is refused as `not-a-repository`.
   */
  gitDiffs?: Record<string, string | GitDiffRefusal>;
  /** The monospaced font families this fake computer has. Defaults to the ones the terminal falls back to. */
  monospaceFonts?: readonly string[];
  /**
   * The models of the Ollama this fake computer has installed. Without it there is no Ollama here
   * (`ai.listOllamaModels` answers `found: false`), which is what most computers are.
   */
  ollamaModels?: readonly string[];
  /** Keys already in the fake keychain, by provider id. */
  aiKeys?: Record<string, string>;
  /**
   * What the fake provider answers to `ai.chat`: a text, or a function of the request. It comes
   * back in deltas, a word at a time. Defaults to `DEFAULT_AI_REPLY`.
   */
  aiReply?: string | ((request: AiChatRequest) => string);
}

/** What the fake provider answers when a test did not say. */
export const DEFAULT_AI_REPLY = "This is the answer of the fake provider.";

/** One notification given to `notify`, for assertions. */
export interface FakeNotification {
  readonly title: string;
  readonly body: string;
}

/** One command run through `runCommand`, for assertions. */
export interface FakeCommandRun {
  readonly cwd: string;
  readonly command: string;
}

/** Read-only view of a session, for assertions. */
export interface FakeSessionInfo {
  id: SessionId;
  profileId: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  alive: boolean;
  exitCode?: number;
  /** The program and arguments of a profile of the user; absent for the profiles the backend was built with. */
  program?: string;
  args?: string[];
  /** The machine of a session of an SSH profile, as the profile named it; absent for a local shell. */
  ssh?: FakeSshTarget;
  /** The connection of a session of an SSH profile (`connected` until `setSessionLink` says otherwise). */
  link?: SessionLink;
}

/** The machine an SSH profile names: what a real backend would hand to `ssh`. */
export interface FakeSshTarget {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  knownHostsFile?: string;
}

/** How many attempts the fake connection of a session makes before it gives up (`retrySession`). */
export const FAKE_LINK_MAX_ATTEMPTS = 20;

/** Splits a command line on spaces, honoring single and double quotes. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let inToken = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === " " || ch === "\t") {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/** A path that starts at a root: `/x`, `\x`, `C:\x` or `C:/x`. */
function isAbsolutePath(path: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(path);
}

/** The folder one level up, or `undefined` at the root (or for a path that has no separator). */
function parentFolder(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return undefined;
  const parent = trimmed.slice(0, cut);
  return parent === "" ? "/" : parent;
}

/** Resolves `target` against `cwd` (`~`, `.` and `..` included) into a normalized absolute path. */
function resolvePath(cwd: string, home: string, target: string): string {
  let path = target;
  if (path === "~" || path.startsWith("~/")) path = home + path.slice(1);
  else if (!path.startsWith("/")) path = `${cwd}/${path}`;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

interface SessionHooks {
  host: string;
  home: string;
  clock: Clock;
  emit(bytes: Uint8Array): void;
  /** The shell ended on its own (`exit N`). */
  exited(code: number): void;
}

/** Simulated interactive shell with shell integration (OSC 7 and OSC 133). */
class FakeSession {
  readonly env: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
  alive = true;
  exitCode: number | undefined;

  #line = "";
  #lastWasCr = false;
  #escape: "none" | "esc" | "csi" = "none";
  #cancelBusy: (() => void) | null = null;
  #out = "";

  constructor(
    readonly id: SessionId,
    readonly profileId: string,
    options: CreateSessionOptions,
    private readonly hooks: SessionHooks,
  ) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.cwd = options.cwd ?? hooks.home;
    this.env = {
      TERM: "xterm-256color",
      HOME: hooks.home,
      SHELL: "/bin/fake",
      ...options.env,
      PWD: this.cwd,
    };
    this.#write(this.#prompt());
    this.#flush();
  }

  /** Output the program wrote on its own, as is (a bell, a notification), with no prompt after it. */
  print(text: string): void {
    this.#write(text);
    this.#flush();
  }

  /** Keyboard input. Typed while a command runs, only Ctrl+C is honored. */
  input(text: string): void {
    for (const ch of text) {
      if (!this.alive) break;
      this.#key(ch);
    }
    this.#flush();
  }

  /** Stops the shell from outside (`kill`). */
  terminate(code: number): void {
    this.#cancelBusy?.();
    this.#cancelBusy = null;
    this.#flush();
    this.alive = false;
    this.exitCode = code;
  }

  #key(ch: string): void {
    if (this.#escape === "esc") {
      this.#escape = ch === "[" ? "csi" : "none";
      return;
    }
    if (this.#escape === "csi") {
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) this.#escape = "none";
      return;
    }
    const wasCr = this.#lastWasCr;
    this.#lastWasCr = ch === "\r";
    if (ch === "\x1b") {
      this.#escape = "esc";
    } else if (ch === "\x03") {
      this.#interrupt();
    } else if (this.#cancelBusy) {
      return;
    } else if (ch === "\r" || (ch === "\n" && !wasCr)) {
      this.#submit();
    } else if (ch === "\x7f" || ch === "\b") {
      if (this.#line.length > 0) {
        this.#line = Array.from(this.#line).slice(0, -1).join("");
        this.#write("\b \b");
      }
    } else if (ch >= " " && ch !== "\x7f") {
      this.#line += ch;
      this.#write(ch);
    }
  }

  #interrupt(): void {
    this.#write("^C\r\n");
    this.#line = "";
    if (this.#cancelBusy) {
      this.#cancelBusy();
      this.#cancelBusy = null;
      this.#finish(130);
    } else {
      this.#write(this.#prompt());
    }
  }

  #submit(): void {
    const line = this.#line;
    const argv = tokenize(line);
    this.#line = "";
    this.#write("\r\n");
    if (argv.length === 0) {
      this.#write(this.#prompt());
      return;
    }
    this.#write(osc(`633;E;${escapeCommandLine(line.trim())}`));
    this.#write(osc("133;C"));
    this.#run(argv);
  }

  #run(argv: string[]): void {
    const [name = "", ...args] = argv;
    switch (name) {
      case "echo":
        this.#finish(0, [args.join(" ")]);
        break;
      case "pwd":
        this.#finish(0, [this.cwd]);
        break;
      case "ls":
        this.#finish(0, [LS_OUTPUT]);
        break;
      case "true":
        this.#finish(0);
        break;
      case "false":
        this.#finish(1);
        break;
      case "cd":
        this.#cd(args);
        break;
      case "exit":
        this.#exit(args);
        break;
      case "sleep":
        this.#sleep(args);
        break;
      case "seq":
        this.#seq(args);
        break;
      default:
        this.#finish(127, [`fake: command not found: ${name}`]);
    }
  }

  #cd(args: string[]): void {
    if (args.length > 1) {
      this.#finish(1, ["cd: too many arguments"]);
      return;
    }
    this.cwd = resolvePath(this.cwd, this.hooks.home, args[0] ?? "~");
    this.env["PWD"] = this.cwd;
    this.#finish(0);
  }

  #exit(args: string[]): void {
    const arg = args[0];
    const valid =
      args.length <= 1 && (arg === undefined || /^\d{1,3}$/.test(arg)) && Number(arg ?? 0) <= 255;
    if (!valid) {
      this.#finish(2, ["exit: numeric argument required"]);
      return;
    }
    this.#flush();
    this.alive = false;
    this.exitCode = Number(arg ?? 0);
    this.hooks.exited(this.exitCode);
  }

  #sleep(args: string[]): void {
    const arg = args[0];
    if (args.length !== 1 || arg === undefined || !/^\d+(\.\d+)?$/.test(arg)) {
      this.#finish(1, ["sleep: invalid time interval"]);
      return;
    }
    this.#cancelBusy = this.hooks.clock.setTimer(
      () => {
        this.#cancelBusy = null;
        this.#finish(0);
        this.#flush();
      },
      Number(arg) * 1000,
    );
  }

  #seq(args: string[]): void {
    const arg = args[0];
    if (args.length !== 1 || arg === undefined || !/^\d+$/.test(arg)) {
      this.#finish(1, ["seq: invalid argument"]);
      return;
    }
    const last = Number(arg);
    this.#flush();
    let chunk = "";
    for (let i = 1; i <= last; i++) {
      chunk += `${i}\r\n`;
      if (chunk.length >= OUTPUT_CHUNK) {
        this.hooks.emit(encodeUtf8(chunk));
        chunk = "";
      }
    }
    this.#write(chunk);
    this.#finish(0);
  }

  /** Prints `lines`, then reports the exit code (OSC 133 D) and shows a new prompt. */
  #finish(code: number, lines: string[] = []): void {
    for (const line of lines) this.#write(`${line}\r\n`);
    this.#write(osc(`133;D;${code}`));
    this.#write(this.#prompt());
  }

  /** Current directory (OSC 7), start of prompt (A), the prompt, end of prompt (B). */
  #prompt(): string {
    const path = this.cwd
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    return osc(`7;file://${this.hooks.host}${path}`) + osc("133;A") + PROMPT + osc("133;B");
  }

  #write(text: string): void {
    this.#out += text;
  }

  #flush(): void {
    if (this.#out === "") return;
    const bytes = encodeUtf8(this.#out);
    this.#out = "";
    this.hooks.emit(bytes);
  }
}

/** A provider id as the keychain takes it: the check of the Rust side (`is_valid_provider_id`). */
const KEYCHAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** The longest key the keychain accepts, in characters. */
const MAX_KEY_CHARS = 1024;

/** A text in pieces of a word and the blanks after it (blanks at the start are a piece of their own): the pieces put back make the text. */
function wordsOf(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

type AiReply = string | ((request: AiChatRequest) => string);

/** What the fake computer's keychain, providers and Ollama hold, behind `FakeBackend.ai`. */
class FakeAi implements AiBackend {
  #providers: AiProviderConfig[] = [];
  readonly #keys = new Map<string, string>();
  #ollama: string[] | null = null;
  readonly #connections = new Map<string, AiConnectionResult>();
  /**
   * The requests of `chat` that are running, by request id; `cancelled` is set by `cancel`, and
   * `wake` ends the wait of a request that is being held (see `hold`).
   */
  readonly #chats = new Map<string, { cancelled: boolean; wake?: () => void }>();
  #holding = false;
  readonly #held = new Set<() => void>();
  #reply: AiReply;

  constructor(
    private readonly record: (method: FakeAiMethod, ...args: unknown[]) => void,
    ollamaModels: readonly string[] | undefined,
    keys: Record<string, string> | undefined,
    reply: AiReply | undefined,
  ) {
    this.#reply = reply ?? DEFAULT_AI_REPLY;
    if (ollamaModels !== undefined) this.#ollama = [...ollamaModels];
    for (const [id, key] of Object.entries(keys ?? {})) this.#keys.set(id, key);
  }

  async providers(): Promise<AiProviderInfo[]> {
    this.record("ai.providers");
    const ollama: AiProviderInfo = {
      id: OLLAMA_PROVIDER_ID,
      kind: "openai-compatible",
      baseUrl: OLLAMA_BASE_URL,
      model: "",
      hasKey: this.#keys.has(OLLAMA_PROVIDER_ID),
    };
    return [ollama, ...this.#providers.map((p) => ({ ...p, hasKey: this.#keys.has(p.id) }))];
  }

  async configure(providers: readonly AiProviderConfig[]): Promise<void> {
    this.record("ai.configure", providers);
    const problem = aiProvidersProblem(providers);
    if (problem !== undefined) throw new Error(problem);
    // The same as the Rust side keeps: the address and the model without the blanks around them.
    this.#providers = providers.map((p) => {
      const parsed = AiProviderSchema.parse(p);
      return { ...parsed, baseUrl: parsed.baseUrl.trim(), model: parsed.model.trim() };
    });
  }

  async setKey(providerId: string, key: string): Promise<void> {
    // The key is not recorded with the call: nothing that outlives the call holds it but the keychain.
    this.record("ai.setKey", providerId);
    if (!KEYCHAIN_ID.test(providerId)) {
      throw new Error(
        "the provider id must be 1 to 64 letters, digits, '-' or '_', starting with a letter or digit",
      );
    }
    const clean = key.trim();
    if (clean === "") {
      this.#keys.delete(providerId);
      return;
    }
    if ([...clean].length > MAX_KEY_CHARS) {
      throw new Error(`the key is longer than ${MAX_KEY_CHARS} characters`);
    }
    this.#keys.set(providerId, clean);
  }

  async listOllamaModels(): Promise<OllamaModels> {
    this.record("ai.listOllamaModels");
    return this.#ollama === null ? { found: false } : { found: true, models: [...this.#ollama] };
  }

  async testConnection(providerId: string): Promise<AiConnectionResult> {
    this.record("ai.testConnection", providerId);
    if (!KEYCHAIN_ID.test(providerId)) throw new Error(`\`${providerId}\` is not a provider id`);
    const provider = this.#providers.find((p) => p.id === providerId);
    if (providerId !== OLLAMA_PROVIDER_ID && provider === undefined) {
      throw new Error(`there is no provider \`${providerId}\``);
    }
    const chosen = this.#connections.get(providerId);
    if (chosen !== undefined) return this.#withoutKey(providerId, chosen);
    if (providerId === OLLAMA_PROVIDER_ID && this.#ollama === null) {
      return {
        ok: false,
        kind: "network",
        message: "could not reach the provider: connection refused",
      };
    }
    if (provider?.kind === "anthropic" && !this.#keys.has(providerId)) {
      return {
        ok: false,
        kind: "invalid-request",
        message: "this provider needs an API key and none is set",
      };
    }
    return { ok: true };
  }

  async chat(request: AiChatRequest, onEvent: (event: AiChatEvent) => void): Promise<void> {
    // The request is kept as it came, and it has no key: a test reads the messages back from the calls.
    this.record("ai.chat", structuredClone(request));
    const { requestId, providerId } = request;
    if (!KEYCHAIN_ID.test(requestId)) {
      throw new Error("the request id must be 1 to 64 letters, digits, '-' or '_'");
    }
    if (!KEYCHAIN_ID.test(providerId)) throw new Error(`\`${providerId}\` is not a provider id`);
    if (providerId !== OLLAMA_PROVIDER_ID && !this.#providers.some((p) => p.id === providerId)) {
      throw new Error(`there is no provider \`${providerId}\``);
    }
    for (const message of request.messages) {
      if (!AI_CHAT_ROLES.includes(message.role)) {
        throw new Error(`\`${String(message.role)}\` is not a role of a message`);
      }
    }
    if (this.#chats.has(requestId)) {
      throw new Error(`the request \`${requestId}\` is already running`);
    }
    const state: { cancelled: boolean; wake?: () => void } = { cancelled: false };
    this.#chats.set(requestId, state);

    try {
      const failure = this.#chatFailure(providerId);
      const deltas = failure === undefined ? wordsOf(this.#replyTo(request)) : [];
      // A turn of the event loop before each event, so a `cancel` has a moment to arrive.
      let first = true;
      for (const text of deltas) {
        await Promise.resolve();
        if (state.cancelled) break;
        onEvent({ type: "delta", text });
        // A held answer waits here, after its first piece, until released or cancelled.
        if (first && this.#holding) await this.#waitForRelease(state);
        first = false;
      }
      await Promise.resolve();
      if (state.cancelled) {
        onEvent({ type: "error", kind: "cancelled", message: "cancelled" });
      } else if (failure !== undefined) {
        onEvent({ type: "error", kind: failure.kind, message: failure.message });
      } else {
        onEvent({ type: "done" });
      }
    } finally {
      this.#chats.delete(requestId);
    }
  }

  async cancel(requestId: string): Promise<boolean> {
    this.record("ai.cancel", requestId);
    const state = this.#chats.get(requestId);
    if (state === undefined) return false;
    state.cancelled = true;
    state.wake?.();
    return true;
  }

  async #waitForRelease(state: { wake?: () => void }): Promise<void> {
    await new Promise<void>((resolve) => {
      const wake = () => {
        this.#held.delete(wake);
        delete state.wake;
        resolve();
      };
      state.wake = wake;
      this.#held.add(wake);
    });
  }

  /**
   * Holds every answer after its first piece (the rest waits, so a test can stop it in the middle)
   * until `hold(false)`, which lets the held ones go on; a `cancel` ends a held answer at once.
   */
  hold(on: boolean): void {
    this.#holding = on;
    if (!on) for (const wake of [...this.#held]) wake();
  }

  /** Why the fake provider cannot answer, as the connection test says it: no Ollama, no key, or the answer a test chose. */
  #chatFailure(providerId: string): { kind: AiErrorKind; message: string } | undefined {
    const chosen = this.#connections.get(providerId);
    if (chosen !== undefined) {
      const result = this.#withoutKey(providerId, chosen);
      return result.ok ? undefined : result;
    }
    if (providerId === OLLAMA_PROVIDER_ID && this.#ollama === null) {
      return { kind: "network", message: "could not reach the provider: connection refused" };
    }
    const provider = this.#providers.find((p) => p.id === providerId);
    if (provider?.kind === "anthropic" && !this.#keys.has(providerId)) {
      return { kind: "invalid-request", message: "this provider needs an API key and none is set" };
    }
    return undefined;
  }

  #replyTo(request: AiChatRequest): string {
    return typeof this.#reply === "string" ? this.#reply : this.#reply(request);
  }

  /** Changes what the fake provider answers from now on; `undefined` goes back to the default. */
  setReply(reply: AiReply | undefined): void {
    this.#reply = reply ?? DEFAULT_AI_REPLY;
  }

  /** The models of the fake Ollama; `null` takes Ollama away. */
  setOllamaModels(models: readonly string[] | null): void {
    this.#ollama = models === null ? null : [...models];
  }

  /** What `testConnection` answers for a provider, instead of what its key and Ollama say; `undefined` undoes it. */
  setConnectionResult(providerId: string, result: AiConnectionResult | undefined): void {
    if (result === undefined) this.#connections.delete(providerId);
    else this.#connections.set(providerId, result);
  }

  /** The key stored for a provider. Not a `Backend` call: a test peeks into the fake keychain. */
  storedKey(providerId: string): string | undefined {
    return this.#keys.get(providerId);
  }

  /** The text of an answer without the key of the provider, as the Rust side takes it out. */
  #withoutKey(providerId: string, result: AiConnectionResult): AiConnectionResult {
    const key = this.#keys.get(providerId);
    if (result.ok || key === undefined) return result;
    return { ...result, message: result.message.split(key).join("[key]") };
  }
}

/**
 * In-memory backend for tests, e2e and the web demo. Sessions run a simulated shell:
 *
 * - prompt `fake$ `, with OSC 7 (`file://host/cwd`), OSC 133 A, B, C and D (with the exit code)
 *   and OSC 633 E (the command line, before C)
 * - `echo`, `pwd`, `ls` (fixed output), `cd` (relative, absolute, `~`, `..`; any path is accepted),
 *   `true`, `false` (exit 1), `exit [N]` (ends the session), `sleep N` (seconds, on the injected
 *   clock), `seq N`; anything else answers 127
 * - `sendOutput` writes anything to a session as if its program had printed it
 * - Ctrl+C interrupts `sleep`; other input typed while a command runs is dropped
 * - `.noren/actions.json` texts live in memory (`setActionsFile`); `runCommand` only records the
 *   command and answers the configured exit code
 * - `gitInfo` answers from fake repositories (`gitRepos`, `setGitRepo`): a folder is in the
 *   repository of the nearest folder above it (or itself) that has one
 * - `readGitDiff` answers with the diff text a test gives a repository (`gitDiffs`, `setGitDiff`),
 *   nothing for a fake repository that has none, and `not-a-repository` outside one; a folder that
 *   is not a full local path is refused as the real one refuses it
 * - the worktrees live in memory over the fake repositories: `listWorktrees` lists the repository a
 *   folder is in (the main worktree, then the ones `createWorktree` made) and rejects outside one;
 *   `createWorktree` names the folder as the real one does, refuses what git would (an empty or
 *   dashed branch, a folder that exists, a branch checked out elsewhere) and makes the new folder a
 *   fake repository on its branch; `removeWorktree` refuses the main worktree, a path that is none
 *   and one marked with `setWorktreeDirty`
 * - `scanAgents` answers from the process trees a test describes with `setSessionAgent` (an agent
 *   under the shell of a session); a session that ended, or an agent not in the catalog, is left out
 * - `notify` only records the notification (`notifications`) and `isWindowFocused` answers what
 *   `setWindowFocused` said (focused at first): no notification is ever shown
 * - the web views of the browser panes live in memory: `openBrowserPane`, `navigateBrowserPane`,
 *   `setBrowserPaneBounds` and `closeBrowserPane` check what the real ones check (a pane id that is
 *   not a name, an address `browserUrlProblem` refuses, bounds `browserBoundsProblem` refuses, a
 *   pane that has a web view already or has none) and `browserPane(paneId)` says where each one is
 *   and what it shows; no page is ever loaded
 * - the windows of the app live in memory: `openWindow` checks what the real one checks (a window
 *   id that is not a name, a blank space, a window that is open already), `moveTabToWindow` takes
 *   the sessions it is given into the window (it refuses a window that is not open and a session
 *   that is not alive) and `windows()` and `windowOfSession` say where everything is;
 *   `closeWindowByPerson` is the person closing a window, which `onWindowClosed` reports. Nothing
 *   is ever shown, unless a page that draws windows (the e2e panels) hands over a `FakeWindowHost`
 *   (`setWindowHost`), which is told of every window opened or closed and asked to take the sessions
 *   of a tab moved to one, as the Rust side asks the page of a native window
 * - the quick terminal window is a flag: `quickToggle` flips `quickVisible` (hidden at first) and
 *   `setQuickShortcut` keeps the chord in `quickShortcut`; nothing is ever shown or registered
 * - `config.jsonc` lives in memory: `loadConfig` answers its text, `saveConfig` replaces it as the
 *   app does and `setConfig` as an edit made by another program would; both tell whoever called
 *   `watchConfig`
 * - the theme files of the user live in memory too: `saveUserTheme` writes one as the app does
 *   (an id that is not a theme id is refused, as the real one refuses it), `setUserTheme` puts a
 *   file there as if it had been placed by hand, `listUserThemes` answers them in the order of the ids
 * - the mod files of the user live in memory: `setMod` puts a file there, edits it or removes it as
 *   a person with an editor would, and tells whoever called `watchMods`; `listMods` answers the
 *   ones the real folder would list (a valid name, not too large, at most `MAX_MODS`) by name
 * - the scrollback snapshots live in memory: `saveScrollback` writes one as the app does (a pane id
 *   that is not a file name or a text over the limit is refused, as the real one refuses them),
 *   `setScrollback` puts a file there as if it had been placed by hand, `loadScrollback` and
 *   `deleteScrollback` read and remove one, `listScrollback` names them; `scrollbackFiles` shows the files as they are
 * - the profiles of the user (`setUserProfiles`) are checked as the real backend checks them and
 *   listed after the profiles it was built with; a session of one starts in its `cwd` unless the call
 *   names a folder, and `session(id)` tells the `program` and `args` it was asked to run
 * - a profile of kind `ssh` is listed with `kind: "ssh"`, and a session of one is a shell "on the
 *   other machine": the `cwd` and `env` of the call are ignored (a remote shell gets only what the
 *   profile says, as in the real backend), `session(id).ssh` says the machine, and its connection
 *   (`onSessionLink`) is up until a test breaks it with `setSessionLink` (one session) or
 *   `setProfileLink` (every live session of a profile, as a broken `ssh` breaks them all at once).
 *   `retrySession` on a connection that is not up moves it to `reconnecting`, attempt 1; it never
 *   comes back by itself, the test decides when
 * - the AI (`ai`) has a fake Ollama (`ollamaModels`, `setOllamaModels`; none unless it is given
 *   models), the providers handed over with `ai.configure` (checked as the real backend checks
 *   them) and a fake keychain: `ai.setKey` keeps the key, `ai.providers` says only `hasKey`, and
 *   `storedAiKey` lets a test peek. `ai.testConnection` answers ok, unless the provider is Ollama
 *   that is not there, or Anthropic without a key, or `setAiConnectionResult` chose the answer (a
 *   key in its text is taken out). `ai.chat` is answered by a fake provider (`aiReply`,
 *   `setAiReply`) in deltas, a word at a time, then one `done`; it ends with an `error` instead when
 *   the connection test would fail, and a `cancel` in between ends it with `error` of kind
 *   `cancelled`. `holdAiAnswer(true)` makes the answers wait after their first piece, so a test can
 *   stop one in the middle. Calls are recorded as `ai.providers`, `ai.setKey` (without the key), `ai.chat` (with
 *   the request, whose messages are what a test checks was sent), and so on.
 *
 * Everything is synchronous: effects of `write` have been delivered when its promise resolves.
 */
export class FakeBackend implements Backend {
  readonly clock: Clock;
  readonly ai: AiBackend;
  readonly #ai: FakeAi;
  readonly #profiles: ShellProfile[];
  #userProfiles: UserProfile[] = [];
  readonly #host: string;
  readonly #home: string;
  readonly #sessions = new Map<SessionId, FakeSession>();
  /** The agent each session has under its shell, as `setSessionAgent` said. */
  readonly #sessionAgents = new Map<SessionId, string>();
  readonly #streams = new Map<SessionId, OutputStream>();
  /** What the sessions of the profiles of the user were asked to run. */
  readonly #launched = new Map<SessionId, { program: string; args: string[] }>();
  /** The SSH profile of each session that has one. */
  readonly #remote = new Map<SessionId, SshUserProfile>();
  /** The connection of each session of an SSH profile, as last told. */
  readonly #links = new Map<SessionId, SessionLink>();
  readonly #linkListeners = new Set<(link: SessionLink) => void>();
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  readonly #calls: FakeCall[] = [];
  readonly #quarantined: string[] = [];
  readonly #actionsFiles = new Map<string, string>();
  readonly #commands: FakeCommandRun[] = [];
  readonly #gitRepos = new Map<string, GitInfo>();
  /** The linked worktrees made by `createWorktree`, by the root of the main worktree they belong to. */
  readonly #linkedWorktrees = new Map<string, { path: string; branch: string }[]>();
  readonly #dirtyWorktrees = new Set<string>();
  readonly #notifications: FakeNotification[] = [];
  readonly #openedLinks: string[] = [];
  readonly #browserPanes = new Map<string, FakeBrowserPane>();
  readonly #windows = new Map<Id, FakeWindow>();
  #windowHost: FakeWindowHost | undefined;
  readonly #windowClosedListeners = new Set<(windowId: Id) => void>();
  readonly #configListeners = new Set<(text: string | null) => void>();
  readonly #userThemes = new Map<string, string>();
  readonly #mods = new Map<string, string>();
  readonly #scrollback = new Map<string, string>();
  readonly #modListeners = new Set<(files: ModFile[]) => void>();
  readonly #windowEffects: Set<WindowEffect>;
  #appliedEffect: WindowEffect = "none";
  readonly #images = new Map<string, Uint8Array>();
  readonly #files = new Map<string, Uint8Array | "directory">();
  readonly #gitDiffs = new Map<string, string | GitDiffRefusal>();
  #monospaceFonts: readonly string[];
  #modListFailure: Error | undefined;
  #scrollbackFailure: Error | undefined;
  #userThemeSaveFailure: Error | undefined;
  #config: string | null;
  #configSaveFailure: Error | undefined;
  #windowFocused = true;
  #quickVisible = false;
  #quickShortcut: string | null = null;
  #quickShortcutFailure: Error | undefined;
  /** What the app was last told about keeping the shells of the panes (it starts by ending them). */
  #keepSessions = false;
  /** Sessions held over from an earlier run, by the pane they belong to (see `holdSessionForPane`). */
  readonly #heldForPanes = new Map<string, SessionId>();
  #notifyFailure: Error | undefined;
  #commandExitCode: number;
  #commandFailure: Error | undefined;
  #state: string | null;
  #nextId = 1;

  constructor(options: FakeBackendOptions = {}) {
    this.#state = options.state ?? null;
    this.#config = options.config ?? null;
    for (const [id, text] of Object.entries(options.userThemes ?? {})) {
      this.#userThemes.set(id, text);
    }
    for (const [name, text] of Object.entries(options.mods ?? {})) {
      this.#mods.set(name, text);
    }
    for (const [paneId, text] of Object.entries(options.scrollback ?? {})) {
      this.#scrollback.set(paneId, text);
    }
    this.#windowEffects = new Set(options.windowEffects ?? []);
    for (const [path, bytes] of Object.entries(options.images ?? {})) {
      this.#images.set(path, bytes);
    }
    for (const [path, entry] of Object.entries(options.files ?? {})) {
      this.#files.set(path, entry);
    }
    for (const [folder, entry] of Object.entries(options.gitDiffs ?? {})) {
      this.#gitDiffs.set(folder, entry);
    }
    this.#monospaceFonts = options.monospaceFonts ?? DEFAULT_MONOSPACE_FONTS;
    this.#ai = new FakeAi(
      (method, ...args) => this.#record(method, ...args),
      options.ollamaModels,
      options.aiKeys,
      options.aiReply,
    );
    this.ai = this.#ai;
    this.#commandExitCode = options.commandExitCode ?? 0;
    for (const [cwd, text] of Object.entries(options.actionsFiles ?? {})) {
      this.#actionsFiles.set(cwd, text);
    }
    this.replaceGitRepos(options.gitRepos ?? {});
    this.clock = options.clock ?? new ManualClock();
    this.#profiles = options.profiles ?? [{ id: "fake", name: "Fake shell", default: true }];
    this.#host = options.host ?? "fake-host";
    this.#home = options.home ?? "/home/fake";
  }

  /** Every `Backend` call so far, in order. */
  get calls(): readonly FakeCall[] {
    return this.#calls;
  }

  /** The calls to one method (`"ai.setKey"` for a method of `ai`). */
  callsTo(method: FakeCallMethod): FakeCall[] {
    return this.#calls.filter((call) => call.method === method);
  }

  /** Changes the models of the fake Ollama (as installing or removing one would); `null` takes Ollama away. Not a `Backend` call. */
  setOllamaModels(models: readonly string[] | null): void {
    this.#ai.setOllamaModels(models);
  }

  /**
   * Makes `ai.testConnection` answer `result` for the provider, instead of what its key and Ollama
   * say; `undefined` undoes it. Not a `Backend` call.
   */
  setAiConnectionResult(providerId: string, result: AiConnectionResult | undefined): void {
    this.#ai.setConnectionResult(providerId, result);
  }

  /**
   * Changes what the fake provider answers to `ai.chat` from now on: a text, or a function of the
   * request; `undefined` goes back to `DEFAULT_AI_REPLY`. Not a `Backend` call.
   */
  setAiReply(reply: string | ((request: AiChatRequest) => string) | undefined): void {
    this.#ai.setReply(reply);
  }

  /**
   * Holds the answers of the fake provider after their first piece until released with `false`, so
   * a test can press Stop while an answer is in the middle. Not a `Backend` call.
   */
  holdAiAnswer(on: boolean): void {
    this.#ai.hold(on);
  }

  /** The key `ai.setKey` stored for a provider, for a test to check; the interface never gets it. Not a `Backend` call. */
  storedAiKey(providerId: string): string | undefined {
    return this.#ai.storedKey(providerId);
  }

  /** Current content of the in-memory `state.json`, `null` when there is none. */
  get stateContent(): string | null {
    return this.#state;
  }

  /** Contents of the copies `quarantineState` made, oldest first. */
  get quarantined(): readonly string[] {
    return this.#quarantined;
  }

  /** How many times `quarantineState` made a copy. */
  get quarantineCount(): number {
    return this.#quarantined.length;
  }

  /** Puts the text of `.noren/actions.json` in the folder `cwd`; `null` removes the file. */
  setActionsFile(cwd: string, text: string | null): void {
    if (text === null) this.#actionsFiles.delete(cwd);
    else this.#actionsFiles.set(cwd, text);
  }

  /** Replaces every fake git repository with these (by the folder that holds each one). */
  replaceGitRepos(repos: Record<string, GitInfo>): void {
    this.#gitRepos.clear();
    for (const [folder, info] of Object.entries(repos)) this.#gitRepos.set(folder, { ...info });
  }

  /** Makes `folder` the root of a fake git repository; `null` removes it. */
  setGitRepo(folder: string, info: GitInfo | null): void {
    for (const known of [...this.#gitRepos.keys()]) {
      if (sameFolder(known, folder)) this.#gitRepos.delete(known);
    }
    if (info !== null) this.#gitRepos.set(folder, { ...info });
  }

  /** Exit code the next `runCommand` calls resolve with. */
  setCommandExitCode(code: number): void {
    this.#commandExitCode = code;
  }

  /** Makes `runCommand` reject with `error` (a command that cannot start or timed out); `undefined` undoes it. */
  setCommandFailure(error: Error | undefined): void {
    this.#commandFailure = error;
  }

  /** Every command `runCommand` was given, in order. Nothing is executed. */
  get commands(): readonly FakeCommandRun[] {
    return this.#commands;
  }

  /** Snapshot of a session (kept after it ends). */
  session(id: SessionId): FakeSessionInfo | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    const launched = this.#launched.get(id);
    const remote = this.#remote.get(id);
    const link = this.#links.get(id);
    return {
      id,
      profileId: session.profileId,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: { ...session.env },
      alive: session.alive,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(launched !== undefined ? { program: launched.program, args: [...launched.args] } : {}),
      ...(remote !== undefined
        ? {
            ssh: {
              host: remote.host,
              ...(remote.user !== undefined ? { user: remote.user } : {}),
              ...(remote.port !== undefined ? { port: remote.port } : {}),
              ...(remote.identityFile !== undefined ? { identityFile: remote.identityFile } : {}),
              ...(remote.knownHostsFile !== undefined
                ? { knownHostsFile: remote.knownHostsFile }
                : {}),
            },
          }
        : {}),
      ...(link !== undefined ? { link: { ...link } } : {}),
    };
  }

  async listProfiles(): Promise<ShellProfile[]> {
    this.#record("listProfiles");
    return [
      ...this.#profiles.map((profile) => ({ ...profile })),
      ...this.#userProfiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        default: false,
        ...(isSshProfile(profile) ? { kind: "ssh" as const } : {}),
      })),
    ];
  }

  async setUserProfiles(profiles: readonly UserProfile[]): Promise<void> {
    this.#record("setUserProfiles", structuredClone(profiles));
    const problem = profilesProblem(
      profiles,
      this.#profiles.map((profile) => profile.id),
    );
    if (problem !== undefined) throw new Error(problem);
    this.#userProfiles = structuredClone([...profiles]);
  }

  async createSession(options: CreateSessionOptions): Promise<SessionId> {
    this.#record("createSession", { ...options });
    const user = this.#userProfiles.find((p) => p.id === options.profileId);
    const profile =
      user !== undefined
        ? { id: user.id }
        : options.profileId === undefined
          ? (this.#profiles.find((p) => p.default) ?? this.#profiles[0])
          : this.#profiles.find((p) => p.id === options.profileId);
    if (!profile) {
      throw new Error(
        options.profileId === undefined
          ? "no shell profile was found"
          : `unknown shell profile '${options.profileId}'`,
      );
    }
    if (
      !Number.isInteger(options.cols) ||
      !Number.isInteger(options.rows) ||
      options.cols < 1 ||
      options.rows < 1
    ) {
      throw new RangeError("cols and rows must be positive integers");
    }
    const id = this.#nextId++;
    const stream = new OutputStream();
    this.#streams.set(id, stream);
    // A profile of the user starts in its own folder unless the session names one. A shell on
    // another machine gets only what its profile says: the folder and the environment of the call
    // belong to this machine, so they are not sent (a folder left out is the remote home).
    const remote = user !== undefined && isSshProfile(user) ? user : undefined;
    const started: CreateSessionOptions =
      remote !== undefined
        ? {
            cols: options.cols,
            rows: options.rows,
            ...(remote.cwd !== undefined ? { cwd: remote.cwd } : {}),
          }
        : user?.cwd !== undefined && options.cwd === undefined
          ? { ...options, cwd: user.cwd }
          : options;
    const session = new FakeSession(id, profile.id, started, {
      host: this.#host,
      home: this.#home,
      clock: this.clock,
      emit: (bytes) => stream.push(bytes),
      exited: (code) => this.#notifyExit({ id, code }),
    });
    this.#sessions.set(id, session);
    if (user !== undefined) {
      this.#launched.set(id, { program: user.program ?? "", args: user.args ?? [] });
    }
    if (remote !== undefined) {
      this.#remote.set(id, remote);
      this.#links.set(id, { id, state: "connected" });
    }
    return id;
  }

  /**
   * The fake has one process and one stream per session whichever window asks, so taking a session
   * over changes nothing about where its output goes; it only checks that the session is alive, as
   * the real one does, and is on record in `calls`.
   */
  async attachSession(id: SessionId): Promise<void> {
    this.#record("attachSession", id);
    this.#alive(id);
  }

  /**
   * The shell a pane had before the app was closed, when one was held for it
   * (`holdSessionForPane`) and it is still running; `undefined` otherwise, which is every pane of a
   * fake that holds nothing. A session is handed back once.
   */
  async reattachSession(paneId: string): Promise<SessionId | undefined> {
    this.#record("reattachSession", paneId);
    const id = this.#heldForPanes.get(paneId);
    if (id === undefined || !this.#sessions.get(id)?.alive) return undefined;
    this.#heldForPanes.delete(paneId);
    return id;
  }

  async setKeepSessions(keep: boolean): Promise<void> {
    this.#record("setKeepSessions", keep);
    this.#keepSessions = keep;
  }

  /** What the app last told the backend about keeping the shells of the panes (`false` at first). */
  get keepSessions(): boolean {
    return this.#keepSessions;
  }

  /**
   * Makes the running session `id` the shell that the pane `paneId` had before the app was closed, as
   * the session daemon holds it: the next `reattachSession(paneId)` gives it back. Not a `Backend`
   * call, so it is not recorded.
   */
  holdSessionForPane(paneId: string, id: SessionId): void {
    this.#alive(id);
    this.#heldForPanes.set(paneId, id);
  }

  /**
   * Flips the fake quick window (hidden at first) and says whether it shows now; recorded in
   * `calls`. Nothing is ever shown.
   */
  async quickToggle(): Promise<boolean> {
    this.#record("quickToggle");
    this.#quickVisible = !this.#quickVisible;
    return this.#quickVisible;
  }

  async setQuickShortcut(chord: string | null): Promise<void> {
    this.#record("setQuickShortcut", chord);
    if (this.#quickShortcutFailure !== undefined) throw this.#quickShortcutFailure;
    this.#quickShortcut = chord;
  }

  /** Whether the fake quick window shows (it starts hidden). */
  get quickVisible(): boolean {
    return this.#quickVisible;
  }

  /** The chord the fake quick terminal has registered now, `null` for none (nothing at first). */
  get quickShortcut(): string | null {
    return this.#quickShortcut;
  }

  /** Makes `setQuickShortcut` reject with `error` (another program has the key); `undefined` undoes it. */
  setQuickShortcutFailure(error: Error | undefined): void {
    this.#quickShortcutFailure = error;
  }

  /**
   * Makes the program of a session write `text` to the terminal, as is: a BEL, an OSC 9 or OSC 777
   * sequence, anything. Not a `Backend` call, so it is not recorded; an ended session throws.
   */
  sendOutput(id: SessionId, text: string): void {
    this.#alive(id).print(text);
  }

  async write(id: SessionId, data: string | Uint8Array): Promise<void> {
    this.#record("write", id, typeof data === "string" ? data : data.slice());
    this.#alive(id).input(typeof data === "string" ? data : decodeUtf8(data));
  }

  async resize(id: SessionId, cols: number, rows: number): Promise<void> {
    this.#record("resize", id, cols, rows);
    const session = this.#alive(id);
    session.cols = cols;
    session.rows = rows;
  }

  async kill(id: SessionId): Promise<void> {
    this.#record("kill", id);
    const session = this.#alive(id);
    session.terminate(137);
    this.#notifyExit({ id, code: 137, signal: "SIGKILL" });
  }

  onSessionLink(callback: (link: SessionLink) => void): Unsubscribe {
    this.#record("onSessionLink");
    this.#linkListeners.add(callback);
    return () => {
      this.#linkListeners.delete(callback);
    };
  }

  async retrySession(id: SessionId): Promise<void> {
    this.#record("retrySession", id);
    const link = this.#liveLink(id);
    if (link.state === "connected") return;
    const reason = link.reason;
    this.#setLink(id, {
      state: "reconnecting",
      attempt: 1,
      maxAttempts: FAKE_LINK_MAX_ATTEMPTS,
      retryInMs: 0,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * Sets the connection of the session `id` of an SSH profile to `link` (without its `id`) and
   * tells whoever listens with `onSessionLink`: a test breaks the connection, makes it come back or
   * makes it give up. Not a `Backend` call, so it is not recorded. Throws for a session that is not
   * a live session of an SSH profile.
   */
  setSessionLink(id: SessionId, link: Omit<SessionLink, "id">): void {
    this.#liveLink(id);
    this.#setLink(id, link);
  }

  /**
   * Sets the connection of every live session of the profile `profileId` to `link`, one event each:
   * one broken `ssh` breaks all the tabs that use it. Throws when the profile is not an SSH profile
   * of the user. Not a `Backend` call.
   */
  setProfileLink(profileId: string, link: Omit<SessionLink, "id">): void {
    const profile = this.#userProfiles.find((p) => p.id === profileId);
    if (profile === undefined || !isSshProfile(profile)) {
      throw new Error(`'${profileId}' is not an SSH profile`);
    }
    for (const [id, session] of this.#sessions) {
      if (session.alive && session.profileId === profileId && this.#remote.has(id)) {
        this.#setLink(id, link);
      }
    }
  }

  /** The state of the connection of a session of an SSH profile, `undefined` for any other. */
  sessionLink(id: SessionId): SessionLinkState | undefined {
    return this.#links.get(id)?.state;
  }

  onOutput(id: SessionId, callback: (data: Uint8Array) => void): Unsubscribe {
    this.#record("onOutput", id);
    const stream = this.#streams.get(id);
    if (!stream) throw new Error(`unknown session ${id}`);
    return stream.subscribe(callback);
  }

  onExit(callback: (exit: SessionExit) => void): Unsubscribe {
    this.#record("onExit");
    this.#exitListeners.add(callback);
    return () => {
      this.#exitListeners.delete(callback);
    };
  }

  async loadState(): Promise<string | null> {
    this.#record("loadState");
    return this.#state;
  }

  async saveState(content: string): Promise<void> {
    this.#record("saveState", content);
    this.#state = content;
  }

  /** Like the real one: copies the file, leaves the original, and fails when there is no file. */
  async quarantineState(): Promise<string> {
    this.#record("quarantineState");
    if (this.#state === null) throw new Error("there is no state file to quarantine");
    this.#quarantined.push(this.#state);
    return `state.broken-${this.#quarantined.length}.json`;
  }

  async loadScrollback(paneId: string): Promise<string | null> {
    this.#record("loadScrollback", paneId);
    this.#checkPaneId(paneId);
    return this.#scrollback.get(paneId) ?? null;
  }

  async saveScrollback(paneId: string, text: string): Promise<void> {
    this.#record("saveScrollback", paneId, text);
    this.#checkPaneId(paneId);
    if (encodeUtf8(text).length > MAX_SCROLLBACK_BYTES) {
      throw new Error(`the scrollback is too large; a snapshot is at most ${MAX_SCROLLBACK_BYTES}`);
    }
    if (this.#scrollbackFailure) throw this.#scrollbackFailure;
    this.putScrollback(paneId, text);
  }

  async listScrollback(): Promise<string[]> {
    this.#record("listScrollback");
    return [...this.#scrollback.keys()].filter(isScrollbackPaneId).sort();
  }

  async deleteScrollback(paneId: string): Promise<void> {
    this.#record("deleteScrollback", paneId);
    this.#checkPaneId(paneId);
    if (this.#scrollbackFailure) throw this.#scrollbackFailure;
    this.putScrollback(paneId, null);
  }

  /**
   * Puts the snapshot file of `paneId` in place with `text` (`null` removes it), as if somebody had
   * placed it by hand. Not a `Backend` call, so it is not recorded. A backend that keeps the files
   * somewhere else (the web one) overrides `putScrollback` to keep them there.
   */
  setScrollback(paneId: string, text: string | null): void {
    this.putScrollback(paneId, text);
  }

  /** Where the snapshot files are kept in this backend; the web one keeps them in the storage too. */
  protected putScrollback(paneId: string, text: string | null): void {
    if (text === null) this.#scrollback.delete(paneId);
    else this.#scrollback.set(paneId, text);
  }

  /** The snapshot files as they are now, by pane id. */
  get scrollbackFiles(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.#scrollback);
  }

  /** Makes `saveScrollback` and `deleteScrollback` reject with `error` (the disk refused); `undefined` undoes it. */
  setScrollbackFailure(error: Error | undefined): void {
    this.#scrollbackFailure = error;
  }

  #checkPaneId(paneId: string): void {
    if (!isScrollbackPaneId(paneId)) throw new Error(`'${paneId}' is not a valid pane id`);
  }

  async loadConfig(): Promise<string | null> {
    this.#record("loadConfig");
    return this.#config;
  }

  watchConfig(callback: (text: string | null) => void): Unsubscribe {
    this.#record("watchConfig");
    this.#configListeners.add(callback);
    return () => {
      this.#configListeners.delete(callback);
    };
  }

  /**
   * Replaces the text of `config.jsonc` (`null` removes the file), as if another program had
   * saved it, and tells everyone watching. A text equal to the current one tells nobody. Not a
   * `Backend` call, so it is not recorded.
   */
  setConfig(text: string | null): void {
    if (text === this.#config) return;
    this.#config = text;
    for (const listener of [...this.#configListeners]) listener(text);
  }

  /**
   * Writes the text of `config.jsonc` the way the app does, and tells everyone watching (the file
   * of the app is watched too, so its own save comes back as a change). Goes through `setConfig`,
   * so a backend that keeps the file somewhere else (the web one) keeps it there.
   */
  async saveConfig(text: string): Promise<void> {
    this.#record("saveConfig", text);
    if (this.#configSaveFailure) throw this.#configSaveFailure;
    this.setConfig(text);
  }

  /** Makes `saveConfig` reject with `error` (the disk refused); `undefined` undoes it. */
  setConfigSaveFailure(error: Error | undefined): void {
    this.#configSaveFailure = error;
  }

  /** Current text of the in-memory `config.jsonc`, `null` when there is none. */
  get configContent(): string | null {
    return this.#config;
  }

  async listUserThemes(): Promise<string[]> {
    this.#record("listUserThemes");
    // In the order of the file names, as the real one lists them (`mid-2.json` comes before `mid.json`).
    return [...this.#userThemes.entries()]
      .sort(([a], [b]) => (`${a}.json` < `${b}.json` ? -1 : 1))
      .map(([, text]) => text);
  }

  async saveUserTheme(id: string, text: string): Promise<void> {
    this.#record("saveUserTheme", id, text);
    if (!THEME_ID_PATTERN.test(id)) throw new Error(`'${id}' is not a valid theme id`);
    if (this.#userThemeSaveFailure) throw this.#userThemeSaveFailure;
    this.putUserTheme(id, text);
  }

  /**
   * Puts the theme file `themes/<id>.json` in place with `text` (`null` removes it), as if
   * somebody had placed it by hand. Not a `Backend` call, so it is not recorded. A backend that
   * keeps the files somewhere else (the web one) overrides this to keep them there.
   */
  setUserTheme(id: string, text: string | null): void {
    this.putUserTheme(id, text);
  }

  /** Where the theme files are kept in this backend; the web one keeps them in the storage too. */
  protected putUserTheme(id: string, text: string | null): void {
    if (text === null) this.#userThemes.delete(id);
    else this.#userThemes.set(id, text);
  }

  /** The theme files of the user as they are now, by theme id. */
  get userThemeFiles(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.#userThemes);
  }

  /** Makes `saveUserTheme` reject with `error` (the disk refused); `undefined` undoes it. */
  setUserThemeSaveFailure(error: Error | undefined): void {
    this.#userThemeSaveFailure = error;
  }

  async listMods(): Promise<ModFile[]> {
    this.#record("listMods");
    if (this.#modListFailure) throw this.#modListFailure;
    return this.#modList();
  }

  watchMods(callback: (files: ModFile[]) => void): Unsubscribe {
    this.#record("watchMods");
    this.#modListeners.add(callback);
    return () => {
      this.#modListeners.delete(callback);
    };
  }

  /**
   * Puts the mod file `mods/<name>` in place with `text` (`null` removes it), as a person with an
   * editor would, and tells everyone watching when the list of mods changed by it. Not a `Backend`
   * call, so it is not recorded. A backend that keeps the files somewhere else (the web one)
   * overrides `putMod` to keep them there.
   */
  setMod(name: string, text: string | null): void {
    const before = JSON.stringify(this.#modList());
    this.putMod(name, text);
    const files = this.#modList();
    if (JSON.stringify(files) === before) return;
    for (const listener of [...this.#modListeners]) listener(files.map((file) => ({ ...file })));
  }

  /** Where the mod files are kept in this backend; the web one keeps them in the storage too. */
  protected putMod(name: string, text: string | null): void {
    if (text === null) this.#mods.delete(name);
    else this.#mods.set(name, text);
  }

  /** The mod files as they are now, by file name (the ones the folder would not list included). */
  get modFiles(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.#mods);
  }

  /** Makes `listMods` reject with `error` (the folder cannot be read); `undefined` undoes it. */
  setModListFailure(error: Error | undefined): void {
    this.#modListFailure = error;
  }

  /** What the real folder lists: valid names, not too large, the first `MAX_MODS` by name. */
  #modList(): ModFile[] {
    return [...this.#mods.entries()]
      .filter(
        ([name, text]) =>
          isValidModFileName(name) && new TextEncoder().encode(text).length <= MAX_MOD_BYTES,
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_MODS)
      .map(([name, text]) => ({ name, text }));
  }

  async setWindowEffect(effect: WindowEffect, scheme: WindowScheme): Promise<WindowEffectReport> {
    this.#record("setWindowEffect", effect, scheme);
    if (effect === "none" || this.#windowEffects.has(effect)) {
      this.#appliedEffect = effect;
      return { requested: effect, applied: effect };
    }
    this.#appliedEffect = "none";
    return { requested: effect, applied: "none", reason: this.windowEffectReason(effect) };
  }

  /** Why this backend cannot paint `effect`; the web one says it is a browser. */
  protected windowEffectReason(effect: WindowEffect): string {
    return `${WINDOW_EFFECT_LABELS[effect]} is not available on this system.`;
  }

  /** The effect the window has now (`none` until `setWindowEffect` got one this system can paint). */
  get appliedWindowEffect(): WindowEffect {
    return this.#appliedEffect;
  }

  async readBackgroundImage(path: string): Promise<BackgroundImageFile> {
    this.#record("readBackgroundImage", path);
    const problem = backgroundImageProblem(path);
    if (problem !== undefined) throw new Error(problem);
    const bytes = this.#images.get(path);
    if (bytes === undefined) throw new Error(`The image ${path} was not found.`);
    if (bytes.length > MAX_BACKGROUND_BYTES) throw new Error("The image file is too large.");
    const mime = sniffImageMime(bytes);
    if (mime === undefined) throw new Error(`${path} is not a picture Noren can show.`);
    return { mime, bytes: bytes.slice() };
  }

  /**
   * Puts the picture file `path` in place with `bytes` (`null` removes it), as a person copying a
   * file would. Not a `Backend` call, so it is not recorded. A backend that keeps the files
   * somewhere else (the web one) overrides `putImage` to keep them there.
   */
  setImage(path: string, bytes: Uint8Array | null): void {
    this.putImage(path, bytes);
  }

  protected putImage(path: string, bytes: Uint8Array | null): void {
    if (bytes === null) this.#images.delete(path);
    else this.#images.set(path, bytes);
  }

  async listMonospaceFonts(): Promise<string[]> {
    this.#record("listMonospaceFonts");
    return fontNameList(this.#monospaceFonts);
  }

  /** Changes the monospaced families this fake computer has (as installing a font would). Not a `Backend` call. */
  setMonospaceFonts(names: readonly string[]): void {
    this.#monospaceFonts = names;
  }

  async readActionsFile(cwd: string): Promise<string | null> {
    this.#record("readActionsFile", cwd);
    return this.#actionsFiles.get(cwd) ?? null;
  }

  async runCommand(cwd: string, command: string): Promise<number> {
    this.#record("runCommand", cwd, command);
    this.#commands.push({ cwd, command });
    if (this.#commandFailure) throw this.#commandFailure;
    return this.#commandExitCode;
  }

  async gitInfo(cwd: string): Promise<GitInfo | null> {
    this.#record("gitInfo", cwd);
    return this.#repositoryAt(cwd);
  }

  /** The repository `cwd` is in (the folder that holds it or one below), or `null`. */
  #repositoryAt(cwd: string): GitInfo | null {
    if (!isAbsolutePath(cwd)) return null;
    for (
      let folder: string | undefined = cwd;
      folder !== undefined;
      folder = parentFolder(folder)
    ) {
      for (const [root, info] of this.#gitRepos) {
        if (sameFolder(root, folder)) return { ...info };
      }
      // A worktree made by `createWorktree` is a repository of its own, on its branch.
      for (const linked of this.#linkedWorktrees.values()) {
        const worktree = linked.find((candidate) => sameFolder(candidate.path, folder));
        if (worktree !== undefined) return { branch: worktree.branch, detached: false };
      }
    }
    return null;
  }

  async listWorktrees(cwd: string): Promise<Worktree[]> {
    this.#record("listWorktrees", cwd);
    const main = this.#mainWorktreeOf(cwd);
    if (main === undefined) throw new Error(`'${cwd}' is not inside a git repository`);
    return this.#worktreesOf(main);
  }

  async createWorktree(cwd: string, branch: string): Promise<Worktree> {
    this.#record("createWorktree", cwd, branch);
    const problem = branchProblem(branch);
    if (problem === "empty") throw new Error("the branch name is empty");
    if (problem === "dash") throw new Error("a branch name cannot start with '-'");
    if (problem !== undefined || /[\s~^:?*[\\]|\.\.|\.lock$|\/$|^\//.test(branch)) {
      throw new Error(`'${branch}' is not a valid branch name`);
    }
    const main = this.#mainWorktreeOf(cwd);
    if (main === undefined) throw new Error(`'${cwd}' is not inside a git repository`);
    const destination = worktreeDestination(main, branch);
    if (destination === undefined) throw new Error(`'${main}' has no folder next to it`);
    const worktrees = this.#worktreesOf(main);
    const holder = worktrees.find((worktree) => worktree.branch === branch);
    if (holder !== undefined) {
      throw new Error(`fatal: '${branch}' is already used by worktree at '${holder.path}'`);
    }
    if (worktrees.some((worktree) => sameFolder(worktree.path, destination))) {
      throw new Error(
        `the folder '${destination}' already exists, so the worktree was not created`,
      );
    }
    const linked = this.#linkedWorktrees.get(main) ?? [];
    linked.push({ path: destination, branch });
    this.#linkedWorktrees.set(main, linked);
    const created = this.#worktreesOf(main).find((worktree) => worktree.path === destination);
    if (created === undefined) throw new Error("the new worktree was not listed");
    return created;
  }

  async removeWorktree(cwd: string, path: string): Promise<void> {
    this.#record("removeWorktree", cwd, path);
    const main = this.#mainWorktreeOf(cwd);
    if (main === undefined) throw new Error(`'${cwd}' is not inside a git repository`);
    if (sameFolder(main, path)) {
      throw new Error(`'${path}' is the main worktree of the repository and cannot be removed`);
    }
    const linked = this.#linkedWorktrees.get(main) ?? [];
    const target = linked.find((worktree) => sameFolder(worktree.path, path));
    if (target === undefined) throw new Error(`'${path}' is not a worktree of this repository`);
    if ([...this.#dirtyWorktrees].some((dirty) => sameFolder(dirty, target.path))) {
      throw new Error(
        `fatal: '${target.path}' contains modified or untracked files, use --force to delete it`,
      );
    }
    this.#linkedWorktrees.set(
      main,
      linked.filter((worktree) => worktree !== target),
    );
  }

  /** The root of the main worktree of the fake repository `cwd` is in, or `undefined` outside one. */
  #mainWorktreeOf(cwd: string): string | undefined {
    if (!isAbsolutePath(cwd)) return undefined;
    for (
      let folder: string | undefined = cwd;
      folder !== undefined;
      folder = parentFolder(folder)
    ) {
      for (const [main, linked] of this.#linkedWorktrees) {
        if (linked.some((worktree) => sameFolder(worktree.path, folder))) return main;
      }
      for (const [root] of this.#gitRepos) {
        if (sameFolder(root, folder)) return root;
      }
    }
    return undefined;
  }

  #worktreesOf(main: string): Worktree[] {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const info = this.#gitRepos.get(main);
    return [
      {
        path: main,
        branch: info?.detached === true ? null : (info?.branch ?? null),
        head,
        detached: info?.detached === true,
        main: true,
        locked: false,
      },
      ...(this.#linkedWorktrees.get(main) ?? []).map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
        head,
        detached: false,
        main: false,
        locked: false,
      })),
    ];
  }

  /** Makes `removeWorktree` refuse this worktree, as git refuses one with changes; `false` cleans it. */
  setWorktreeDirty(path: string, dirty: boolean): void {
    for (const known of [...this.#dirtyWorktrees]) {
      if (sameFolder(known, path)) this.#dirtyWorktrees.delete(known);
    }
    if (dirty) this.#dirtyWorktrees.add(path);
  }

  /** Says that the shell of a session has this agent under it (`undefined`: none), for `scanAgents`. */
  setSessionAgent(id: SessionId, agentId: string | undefined): void {
    if (agentId === undefined) this.#sessionAgents.delete(id);
    else this.#sessionAgents.set(id, agentId);
  }

  async scanAgents(
    sessionIds: readonly SessionId[],
    catalog: readonly AgentEntry[],
  ): Promise<AgentHit[]> {
    this.#record(
      "scanAgents",
      [...sessionIds],
      catalog.map((entry) => entry.id),
    );
    const hits: AgentHit[] = [];
    for (const sessionId of sessionIds) {
      const agentId = this.#sessionAgents.get(sessionId);
      const session = this.#sessions.get(sessionId);
      if (agentId === undefined || !session?.alive) continue;
      if (catalog.some((entry) => entry.id === agentId)) hits.push({ sessionId, agentId });
    }
    return hits;
  }

  async notify(title: string, body: string): Promise<void> {
    this.#record("notify", title, body);
    if (this.#notifyFailure) throw this.#notifyFailure;
    this.#notifications.push({ title, body });
  }

  async isWindowFocused(): Promise<boolean> {
    this.#record("isWindowFocused");
    return this.#windowFocused;
  }

  async openExternal(url: string): Promise<void> {
    this.#record("openExternal", url);
    const problem = externalLinkProblem(url);
    if (problem !== undefined) throw new Error(problem);
    this.#openedLinks.push(url);
  }

  async openWindow(windowId: Id, spaceId: Id): Promise<void> {
    this.#record("openWindow", windowId, spaceId);
    if (!isWindowId(windowId)) throw new Error(`"${windowId}" is not a window id`);
    if (typeof spaceId !== "string" || spaceId.trim() === "") {
      throw new Error("a window needs the space it shows");
    }
    if (this.#windows.has(windowId)) throw new Error(`window ${windowId} is open already`);
    this.#windows.set(windowId, { spaceId, sessions: [] });
    this.#windowHost?.opened(windowId, spaceId);
  }

  async closeWindow(windowId: Id): Promise<void> {
    this.#record("closeWindow", windowId);
    if (this.#windows.delete(windowId)) this.#windowHost?.closed(windowId);
  }

  async moveTabToWindow(windowId: Id, sessionIds: readonly SessionId[]): Promise<void> {
    this.#record("moveTabToWindow", windowId, [...sessionIds]);
    const window = this.#windows.get(windowId);
    if (window === undefined) throw new Error(`window ${windowId} is not open`);
    // All or nothing here: the fake checks every session before it takes one.
    for (const id of sessionIds) this.#alive(id);
    for (const other of this.#windows.values()) {
      other.sessions = other.sessions.filter((id) => !sessionIds.includes(id));
    }
    window.sessions.push(...sessionIds);
    // The page that draws the window takes the output over, as the page of a native one does; a
    // window that refuses leaves the sessions where they were.
    try {
      await this.#windowHost?.take(windowId, sessionIds);
    } catch (error) {
      window.sessions = window.sessions.filter((id) => !sessionIds.includes(id));
      throw error;
    }
  }

  /**
   * Gives the object that plays the native windows in a page that draws them (`undefined` takes it
   * away): it hears of every window opened or closed and is asked to take the sessions of a tab
   * moved to one. Not a `Backend` call, so it is not recorded.
   */
  setWindowHost(host: FakeWindowHost | undefined): void {
    this.#windowHost = host;
  }

  onWindowClosed(callback: (windowId: Id) => void): Unsubscribe {
    this.#windowClosedListeners.add(callback);
    return () => {
      this.#windowClosedListeners.delete(callback);
    };
  }

  /**
   * The person closes the window `windowId` (its close button): it is gone, the sessions it had
   * keep running with no window, and whoever called `onWindowClosed` hears of it. Not a `Backend`
   * call, so it is not recorded; a window that is not open changes nothing.
   */
  closeWindowByPerson(windowId: Id): void {
    if (!this.#windows.delete(windowId)) return;
    this.#windowHost?.closed(windowId);
    for (const listener of [...this.#windowClosedListeners]) listener(windowId);
  }

  /** The windows that are open, in the order they were opened. */
  windows(): { id: Id; spaceId: Id; sessions: SessionId[] }[] {
    return [...this.#windows].map(([id, window]) => ({
      id,
      spaceId: window.spaceId,
      sessions: [...window.sessions],
    }));
  }

  /** The window that received the output of the session, `undefined` for one no window has. */
  windowOfSession(id: SessionId): Id | undefined {
    for (const [windowId, window] of this.#windows) {
      if (window.sessions.includes(id)) return windowId;
    }
    return undefined;
  }

  async openBrowserPane(paneId: Id, url: string, bounds: BrowserBounds): Promise<void> {
    this.#record("openBrowserPane", paneId, url, { ...bounds });
    if (!isBrowserPaneId(paneId)) throw new Error(`"${paneId}" is not a pane id`);
    const problem = browserUrlProblem(url) ?? browserBoundsProblem(bounds);
    if (problem !== undefined) throw new Error(problem);
    if (this.#browserPanes.has(paneId)) throw new Error(`pane ${paneId} has a web view already`);
    this.#browserPanes.set(paneId, { url, bounds: { ...bounds } });
  }

  async navigateBrowserPane(paneId: Id, url: string): Promise<void> {
    this.#record("navigateBrowserPane", paneId, url);
    const view = this.#browserView(paneId);
    const problem = browserUrlProblem(url);
    if (problem !== undefined) throw new Error(problem);
    view.url = url;
  }

  async setBrowserPaneBounds(paneId: Id, bounds: BrowserBounds): Promise<void> {
    this.#record("setBrowserPaneBounds", paneId, { ...bounds });
    const view = this.#browserView(paneId);
    const problem = browserBoundsProblem(bounds);
    if (problem !== undefined) throw new Error(problem);
    view.bounds = { ...bounds };
  }

  async closeBrowserPane(paneId: Id): Promise<void> {
    this.#record("closeBrowserPane", paneId);
    this.#browserPanes.delete(paneId);
  }

  async readFilePreview(path: string): Promise<FilePreview> {
    this.#record("readFilePreview", path);
    return previewOf(path, this.#files.get(path));
  }

  /**
   * Puts the file `path` in place with `content` (text is stored as UTF-8; `null` removes it), as a
   * person saving a file would. Not a `Backend` call, so it is not recorded. A backend that keeps
   * the files somewhere else (the web one) overrides `putFile` to keep them there.
   */
  setFile(path: string, content: Uint8Array | string | null): void {
    if (content === null) this.putFile(path, undefined);
    else this.putFile(path, typeof content === "string" ? encodeUtf8(content) : content);
  }

  async readGitDiff(cwd: string): Promise<GitDiff> {
    this.#record("readGitDiff", cwd);
    const kind = classifyPreviewPath(cwd);
    if (kind !== "ok") return { kind: "refused", reason: kind };
    // The diff is of the whole repository, whichever folder of it is asked about.
    for (
      let folder: string | undefined = cwd;
      folder !== undefined;
      folder = parentFolder(folder)
    ) {
      for (const [root, entry] of this.#gitDiffs) {
        if (!sameFolder(root, folder)) continue;
        return typeof entry === "string" ? { kind: "diff", text: entry } : { ...entry };
      }
    }
    return this.#repositoryAt(cwd) !== null
      ? { kind: "diff", text: "" }
      : { kind: "refused", reason: "not-a-repository" };
  }

  /**
   * Sets what `readGitDiff` answers for the repository at `folder`: the text of the diff, a refusal
   * to answer with, or `null` to take the entry away (the repository then has no changes, or is no
   * repository at all). Not a `Backend` call, so it is not recorded.
   */
  setGitDiff(folder: string, entry: string | GitDiffRefusal | null): void {
    this.putGitDiff(folder, entry);
  }

  /**
   * Where `setGitDiff` keeps the answer; a backend that keeps it somewhere else (the web one) overrides
   * this to keep it there too.
   */
  protected putGitDiff(folder: string, entry: string | GitDiffRefusal | null): void {
    for (const known of [...this.#gitDiffs.keys()]) {
      if (sameFolder(known, folder)) this.#gitDiffs.delete(known);
    }
    if (entry !== null) this.#gitDiffs.set(folder, entry);
  }

  /** Makes `path` a folder, which a preview refuses. Not a `Backend` call. */
  setDirectory(path: string): void {
    this.putFile(path, "directory");
  }

  /** What is at `path` on this fake computer now. */
  fileAt(path: string): PreviewEntry {
    return this.#files.get(path);
  }

  protected putFile(path: string, entry: Uint8Array | "directory" | undefined): void {
    if (entry === undefined) this.#files.delete(path);
    else this.#files.set(path, entry);
  }

  /** Where the web view of the pane is and what it shows; `undefined` when it has none. */
  browserPane(paneId: Id): FakeBrowserPane | undefined {
    const view = this.#browserPanes.get(paneId);
    return view && { url: view.url, bounds: { ...view.bounds } };
  }

  /** The ids of the panes that have a web view, in the order they were opened. */
  browserPaneIds(): Id[] {
    return [...this.#browserPanes.keys()];
  }

  #browserView(paneId: Id): FakeBrowserPane {
    const view = this.#browserPanes.get(paneId);
    if (view === undefined) throw new Error(`pane ${paneId} has no web view`);
    return view;
  }

  /** Every address `openExternal` accepted, in order. Nothing is opened. */
  get openedLinks(): readonly string[] {
    return this.#openedLinks;
  }

  /** Whether `isWindowFocused` answers true. The fake window starts with the focus. */
  setWindowFocused(focused: boolean): void {
    this.#windowFocused = focused;
  }

  /** Makes `notify` reject with `error` (the system refused); `undefined` undoes it. */
  setNotifyFailure(error: Error | undefined): void {
    this.#notifyFailure = error;
  }

  /** Every notification `notify` was given, in order. Nothing is shown to anyone. */
  get notifications(): readonly FakeNotification[] {
    return this.#notifications;
  }

  #record(method: FakeCallMethod, ...args: unknown[]): void {
    this.#calls.push({ method, args });
  }

  #alive(id: SessionId): FakeSession {
    const session = this.#sessions.get(id);
    if (!session?.alive) throw new Error(`unknown session ${id}`);
    return session;
  }

  /** The connection of a live session of an SSH profile; throws for any other session. */
  #liveLink(id: SessionId): SessionLink {
    const link = this.#links.get(id);
    if (link === undefined || !this.#sessions.get(id)?.alive) {
      throw new Error(`session ${id} has no connection to retry`);
    }
    return link;
  }

  #setLink(id: SessionId, link: Omit<SessionLink, "id">): void {
    const next: SessionLink = { id, ...link };
    this.#links.set(id, next);
    for (const listener of [...this.#linkListeners]) listener({ ...next });
  }

  #notifyExit(exit: SessionExit): void {
    for (const listener of [...this.#exitListeners]) listener(exit);
  }
}
