/**
 * Terminal side of the backend contract. It never imports DOM or Tauri.
 *
 * Config and AI methods (`loadConfig`, `watchConfig`, `ai.*`) join this interface in the tasks of
 * their own phases.
 */

/** Function returned by every subscription: calling it stops the delivery. */
export type Unsubscribe = () => void;

/** Numeric id of a terminal session, as issued by the backend. */
export type SessionId = number;

/** A shell the backend can start. */
export interface ShellProfile {
  id: string;
  name: string;
  /** True for the profile used when `createSession` gets no `profileId`. */
  default: boolean;
}

export interface CreateSessionOptions {
  /** Defaults to the profile marked `default`. */
  profileId?: string;
  cols: number;
  rows: number;
  /** Starting directory. */
  cwd?: string;
  /** Extra environment variables for the shell. */
  env?: Record<string, string>;
}

/** How a session ended. */
export interface SessionExit {
  id: SessionId;
  code: number;
  /** Name of the terminating signal, when the shell was killed by one. */
  signal?: string;
}

/** What `HEAD` of the git repository a folder is in points at. */
export interface GitInfo {
  /** The branch, or the first 7 characters of the commit when `HEAD` is detached. */
  branch: string;
  /** `HEAD` holds a commit and no branch. */
  detached: boolean;
}

export interface Backend {
  listProfiles(): Promise<ShellProfile[]>;
  /** Starts a shell. Output produced before `onOutput` is called is held for the first subscriber. */
  createSession(options: CreateSessionOptions): Promise<SessionId>;
  /** Sends keyboard input (text) or raw bytes (for example a paste) to the shell. */
  write(id: SessionId, data: string | Uint8Array): Promise<void>;
  resize(id: SessionId, cols: number, rows: number): Promise<void>;
  /** Ends the session if it is still running and releases its id. */
  kill(id: SessionId): Promise<void>;
  /** Raw terminal output (escape sequences included) of one session, in order. */
  onOutput(id: SessionId, callback: (data: Uint8Array) => void): Unsubscribe;
  /** Called once per session that ends, whether on its own or through `kill`. */
  onExit(callback: (exit: SessionExit) => void): Unsubscribe;
  /** Text of the saved `state.json`, or `null` when there is none yet. Parsing is the caller's job. */
  loadState(): Promise<string | null>;
  /** Replaces `state.json` with `content` atomically: a crash never leaves half a file. */
  saveState(content: string): Promise<void>;
  /** Keeps a copy of the current `state.json` as `state.broken-<date>.json` and returns its path. */
  quarantineState(): Promise<string>;
  /**
   * Text of `.noren/actions.json` inside the folder `cwd`, or `null` when the folder has no such
   * file. Rejects for any other failure (a folder where the file should be, no permission).
   * Parsing is the caller's job (`parseActionsFile`).
   */
  readActionsFile(cwd: string): Promise<string | null>;
  /**
   * Runs a command line through the system shell in the folder `cwd`, in a short process with no
   * terminal and no window, and resolves with its exit code when it ends. Rejects when it cannot
   * start, when `cwd` is not a folder, and when it outlives the backend's time limit (it is killed).
   */
  runCommand(cwd: string, command: string): Promise<number>;
  /**
   * The branch of the git repository the folder `cwd` is in (the repository of the nearest folder
   * above it that has one), or `null` when it is in none or is not an absolute path. It reads the
   * files of the repository and never runs `git`; a linked worktree and a detached `HEAD` work.
   * Rejects only when the lookup itself fails.
   */
  gitInfo(cwd: string): Promise<GitInfo | null>;
}
