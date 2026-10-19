import type {
  Backend,
  CreateSessionOptions,
  GitInfo,
  SessionExit,
  SessionId,
  ShellProfile,
  Unsubscribe,
} from "./backend";
import { ManualClock } from "./clock";
import type { Clock } from "./clock";
import { sameFolder } from "./deep-link";
import { OutputStream } from "./output-stream";
import { decodeUtf8, encodeUtf8 } from "./utf8";

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
 * - Ctrl+C interrupts `sleep`; other input typed while a command runs is dropped
 * - `.noren/actions.json` texts live in memory (`setActionsFile`); `runCommand` only records the
 *   command and answers the configured exit code
 * - `gitInfo` answers from fake repositories (`gitRepos`, `setGitRepo`): a folder is in the
 *   repository of the nearest folder above it (or itself) that has one
 *
 * Everything is synchronous: effects of `write` have been delivered when its promise resolves.
 */
export class FakeBackend implements Backend {
  readonly clock: Clock;
  readonly #profiles: ShellProfile[];
  readonly #host: string;
  readonly #home: string;
  readonly #sessions = new Map<SessionId, FakeSession>();
  readonly #streams = new Map<SessionId, OutputStream>();
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  readonly #calls: FakeCall[] = [];
  readonly #quarantined: string[] = [];
  readonly #actionsFiles = new Map<string, string>();
  readonly #commands: FakeCommandRun[] = [];
  readonly #gitRepos = new Map<string, GitInfo>();
  #commandExitCode: number;
  #commandFailure: Error | undefined;
  #state: string | null;
  #nextId = 1;

  constructor(options: FakeBackendOptions = {}) {
    this.#state = options.state ?? null;
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
    return {
      id,
      profileId: session.profileId,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: { ...session.env },
      alive: session.alive,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    };
  }

  async listProfiles(): Promise<ShellProfile[]> {
    this.#record("listProfiles");
    return this.#profiles.map((profile) => ({ ...profile }));
  }

  async createSession(options: CreateSessionOptions): Promise<SessionId> {
    this.#record("createSession", { ...options });
    const profile =
      options.profileId === undefined
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
    const session = new FakeSession(id, profile.id, options, {
      host: this.#host,
      home: this.#home,
      clock: this.clock,
      emit: (bytes) => stream.push(bytes),
      exited: (code) => this.#notifyExit({ id, code }),
    });
    this.#sessions.set(id, session);
    return id;
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
