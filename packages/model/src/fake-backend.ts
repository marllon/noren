import type {
  Backend,
  CreateSessionOptions,
  GitInfo,
  ModFile,
  SessionExit,
  SessionId,
  ShellProfile,
  Unsubscribe,
} from "./backend";
import { MAX_BACKGROUND_BYTES, backgroundImageProblem, sniffImageMime } from "./background";
import type { BackgroundImageFile } from "./background";
import { ManualClock } from "./clock";
import type { Clock } from "./clock";
import { sameFolder } from "./deep-link";
import { MAX_MOD_BYTES, MAX_MODS, isValidModFileName } from "./mods";
import { OutputStream } from "./output-stream";
import { MAX_SCROLLBACK_BYTES, isScrollbackPaneId } from "./scrollback";
import { fontNameList } from "./terminal-options";
import { THEME_ID_PATTERN } from "./theme";
import { profilesProblem } from "./user-profile-schema";
import type { UserProfile } from "./user-profile-schema";
import { decodeUtf8, encodeUtf8 } from "./utf8";
import { WINDOW_EFFECT_LABELS } from "./window-effect";
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

/** One recorded call to a `Backend` method. Callbacks are not recorded. */
export interface FakeCall {
  readonly method: keyof Backend;
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
  /** The monospaced font families this fake computer has. Defaults to the ones the terminal falls back to. */
  monospaceFonts?: readonly string[];
}

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
}

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
 * - `notify` only records the notification (`notifications`) and `isWindowFocused` answers what
 *   `setWindowFocused` said (focused at first): no notification is ever shown
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
 *
 * Everything is synchronous: effects of `write` have been delivered when its promise resolves.
 */
export class FakeBackend implements Backend {
  readonly clock: Clock;
  readonly #profiles: ShellProfile[];
  #userProfiles: UserProfile[] = [];
  readonly #host: string;
  readonly #home: string;
  readonly #sessions = new Map<SessionId, FakeSession>();
  readonly #streams = new Map<SessionId, OutputStream>();
  /** What the sessions of the profiles of the user were asked to run. */
  readonly #launched = new Map<SessionId, { program: string; args: string[] }>();
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  readonly #calls: FakeCall[] = [];
  readonly #quarantined: string[] = [];
  readonly #actionsFiles = new Map<string, string>();
  readonly #commands: FakeCommandRun[] = [];
  readonly #gitRepos = new Map<string, GitInfo>();
  readonly #notifications: FakeNotification[] = [];
  readonly #configListeners = new Set<(text: string | null) => void>();
  readonly #userThemes = new Map<string, string>();
  readonly #mods = new Map<string, string>();
  readonly #scrollback = new Map<string, string>();
  readonly #modListeners = new Set<(files: ModFile[]) => void>();
  readonly #windowEffects: Set<WindowEffect>;
  #appliedEffect: WindowEffect = "none";
  readonly #images = new Map<string, Uint8Array>();
  #monospaceFonts: readonly string[];
  #modListFailure: Error | undefined;
  #scrollbackFailure: Error | undefined;
  #userThemeSaveFailure: Error | undefined;
  #config: string | null;
  #configSaveFailure: Error | undefined;
  #windowFocused = true;
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
    this.#monospaceFonts = options.monospaceFonts ?? DEFAULT_MONOSPACE_FONTS;
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

  /** The calls to one method. */
  callsTo(method: keyof Backend): FakeCall[] {
    return this.#calls.filter((call) => call.method === method);
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
    // A profile of the user starts in its own folder unless the session names one.
    const started: CreateSessionOptions =
      user?.cwd !== undefined && options.cwd === undefined
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
    if (user !== undefined)
      this.#launched.set(id, { program: user.program, args: user.args ?? [] });
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
    if (!isAbsolutePath(cwd)) return null;
    for (
      let folder: string | undefined = cwd;
      folder !== undefined;
      folder = parentFolder(folder)
    ) {
      for (const [root, info] of this.#gitRepos) {
        if (sameFolder(root, folder)) return { ...info };
      }
    }
    return null;
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

  #record(method: keyof Backend, ...args: unknown[]): void {
    this.#calls.push({ method, args });
  }

  #alive(id: SessionId): FakeSession {
    const session = this.#sessions.get(id);
    if (!session?.alive) throw new Error(`unknown session ${id}`);
    return session;
  }

  #notifyExit(exit: SessionExit): void {
    for (const listener of [...this.#exitListeners]) listener(exit);
  }
}
