/**
 * The backend contract: the terminal, the files of the app and the AI. It never imports DOM or
 * Tauri. The AI side is the `ai` member (`ai.providers`, `ai.configure`, `ai.setKey`,
 * `ai.listOllamaModels`, `ai.testConnection`); asking a question (`ai.*` streaming) joins it with
 * the Ask panel.
 */

import type { AgentEntry } from "./agents";
import type { AiBackend } from "./ai";
import type { BackgroundImageFile } from "./background";
import type { UserProfile } from "./user-profile-schema";
import type { WindowEffect, WindowEffectReport, WindowScheme } from "./window-effect";

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

/** The CLI agent found under the shell of a session. */
export interface AgentHit {
  sessionId: SessionId;
  /** The `id` of the catalog entry. */
  agentId: string;
}

/** A mod of the user: the name of its file in the `mods` folder (`dark-sidebar.css`) and its CSS. */
export interface ModFile {
  name: string;
  text: string;
}

export interface Backend {
  /** The AI providers: which ones there are, their keys, Ollama's models and the connection test. */
  readonly ai: AiBackend;
  /**
   * The shells a session can start: the ones found on the machine (the default one marked), then
   * the profiles of the user the backend was given (`setUserProfiles`), in their order.
   */
  listProfiles(): Promise<ShellProfile[]>;
  /**
   * Gives the backend the shell profiles of the user (`profiles` of `config.jsonc`), replacing the
   * ones it had; `listProfiles` then lists them after the ones found on the machine, and
   * `createSession` can start them (their program and arguments, and their `cwd` when the session
   * names none). Rejects, and keeps the profiles it had, when the list is not valid: a profile that
   * does not match `UserProfileSchema` (an empty program, for one), an id used twice, `default`, or
   * the id of a shell found on the machine (`profilesProblem` tells which).
   */
  setUserProfiles(profiles: readonly UserProfile[]): Promise<void>;
  /** Starts a shell. Output produced before `onOutput` is called is held for the first subscriber. */
  createSession(options: CreateSessionOptions): Promise<SessionId>;
  /**
   * Takes over the output of a live session that another window started (the quick terminal being
   * promoted): from then on `onOutput(id)` delivers its output here and the window that had it gets
   * none. The shell is the same process under the same id, nothing is restarted, and what it prints
   * while this is being asked is held for the first `onOutput` subscriber. Rejects when no live
   * session has the id (never started, or already ended).
   */
  attachSession(id: SessionId): Promise<void>;
  /**
   * Shows the quick terminal window if it is hidden (at the top of the screen, with the keyboard)
   * and hides it if it is showing, as its global shortcut does. Resolves with whether the window is
   * visible afterwards.
   */
  quickToggle(): Promise<boolean>;
  /**
   * Gives the quick terminal its global shortcut: `chord` as the shortcuts screen spells it
   * (`Ctrl+Backquote`), or `null` for none, replacing the one it had. Rejects with the reason, and
   * keeps the one it had, when the chord is not a shortcut the system can hold (no Ctrl or Alt, or
   * another program has it). Resolves without registering anything when the run is a smoke run.
   */
  setQuickShortcut(chord: string | null): Promise<void>;
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
   * The scrollback snapshot saved for the pane `paneId` (`scrollback/<paneId>.txt` next to
   * `state.json`), or `null` when the pane has none. The text is data from disk: cleaning it
   * (`cleanSnapshot`) before it reaches a terminal is the caller's job. Rejects when `paneId` is not
   * a pane id (`isScrollbackPaneId`: it becomes a file name), when the file is larger than
   * `MAX_SCROLLBACK_BYTES` or cannot be read.
   */
  loadScrollback(paneId: string): Promise<string | null>;
  /**
   * Replaces the snapshot of the pane `paneId` with `text` atomically, exactly as given, and creates
   * the folder when it is missing. Rejects, writing nothing, when `paneId` is not a pane id, when
   * `text` is longer than `MAX_SCROLLBACK_BYTES` bytes of UTF-8 or the file cannot be written.
   */
  saveScrollback(paneId: string, text: string): Promise<void>;
  /**
   * The ids of the panes that have a snapshot file, sorted: the files named `<id>.txt` with a valid
   * pane id (`isScrollbackPaneId`); anything else in the folder is ignored. No folder is an empty
   * list. The ids are for matching against the panes of the workspace (the boot removes the files
   * that no pane claims); they say nothing about what is in the files. Rejects when the folder
   * cannot be read.
   */
  listScrollback(): Promise<string[]>;
  /**
   * Removes the snapshot of the pane `paneId`. A pane that has none is not an error. Rejects when
   * `paneId` is not a pane id or the file cannot be removed.
   */
  deleteScrollback(paneId: string): Promise<void>;
  /**
   * Text of the settings file `config.jsonc`, or `null` when there is none yet. Parsing and
   * validation are the caller's job (`parseConfigText`). Rejects when the file cannot be read.
   */
  loadConfig(): Promise<string | null>;
  /**
   * Calls `callback` with the new text of `config.jsonc` (`null` when the file was removed) every
   * time it changes, whether the app or another program changed it. The text the file has when
   * the watching starts is not delivered; `loadConfig` has it. A change that leaves the text as it
   * was is not delivered. Stops when the returned function is called.
   */
  watchConfig(callback: (text: string | null) => void): Unsubscribe;
  /**
   * Replaces `config.jsonc` with `text` atomically: a crash never leaves half a file. Creates the
   * file (and its folder) when there is none. The text is written as given, comments and all;
   * editing it is the caller's job (`editConfigText`). Whoever called `watchConfig` hears the new
   * text like any other change. Rejects when the file cannot be written.
   */
  saveConfig(text: string): Promise<void>;
  /**
   * The text of every theme file of the user (`themes/*.json` next to `config.jsonc`), in the
   * order of the file names. The folder missing is no files; a file that is not text, is empty,
   * is not shaped like a JSON object or is too large is left out. Whether what is left is a
   * valid theme is the caller's job (`parseUserThemes`). Rejects when the folder cannot be read.
   */
  listUserThemes(): Promise<string[]>;
  /**
   * Writes the theme file `themes/<id>.json` atomically, replacing the file of that id, and
   * creates the folder when it is missing. `id` must be a theme id (`THEME_ID_PATTERN`): it
   * becomes a file name, so anything else rejects and writes nothing. `text` is written as given
   * (`serializeTheme`). Rejects when the file cannot be written.
   */
  saveUserTheme(id: string, text: string): Promise<void>;
  /**
   * The CSS files of the user (`mods/*.css` next to `config.jsonc`), in the order of the file
   * names. The folder missing is no files. A file is left out when its name is not a mod name
   * (`isValidModFileName`), when it is a folder, is not UTF-8 text or is larger than
   * `MAX_MOD_BYTES`; at most `MAX_MODS` are listed. Wrapping the text in its layer is the
   * caller's job (`wrapModCss`). Rejects when the folder cannot be read.
   */
  listMods(): Promise<ModFile[]>;
  /**
   * Calls `callback` with the whole list of mods (what `listMods` would answer) every time a file
   * of the folder is added, changed or removed, whether the app or another program did it. The
   * files there when the watching starts are not delivered; `listMods` has them. A change that
   * leaves the list as it was is not delivered. Stops when the returned function is called.
   */
  watchMods(callback: (files: ModFile[]) => void): Unsubscribe;
  /**
   * Asks the system to paint `effect` behind the window (`none` takes any effect away), and tells
   * what the window has afterwards. It never rejects because the system cannot paint the effect:
   * Mica before Windows 11, vibrancy outside macOS or a plain browser answer `applied: "none"` with
   * the `reason`, and the window stays opaque. Rejects only when the request itself cannot be made.
   * `scheme` is the look the effect is painted in: `dark` or `light` when the theme in force was
   * chosen (so the effect matches the theme, not the mode of the system), `system` when the theme
   * follows the system, which leaves the window following it too. Calling it again with the effect
   * and the scheme the window has changes nothing.
   */
  setWindowEffect(effect: WindowEffect, scheme: WindowScheme): Promise<WindowEffectReport>;
  /**
   * The picture file of a background: `path` is an absolute path or a path inside the config folder
   * of the app (`backgroundImageProblem` tells what is refused: web addresses, network paths, `..`,
   * anything that is not a picture extension). The bytes must really be a png, jpeg, webp, gif or
   * bmp picture and at most `MAX_BACKGROUND_BYTES` long. Rejects, with a sentence for a person,
   * when the path is refused, the file is not there or cannot be read, or is not a picture. It
   * never reaches for the network.
   */
  readBackgroundImage(path: string): Promise<BackgroundImageFile>;
  /**
   * The names of the font families installed on this computer that are monospaced, without
   * repeats, in alphabetical order (upper and lower case alike). A name is only a family name: one
   * that has a quote, a backslash, a semicolon or another sign a family name does not have is left
   * out (`fontFamilyProblem` tells what a name may hold), so the list is safe to show and to write
   * into the settings. It reads the fonts and writes nothing. A computer with none answers an
   * empty list; a browser, which cannot list the fonts of its visitor, answers the families the
   * terminal falls back to. Rejects only when the lookup itself fails.
   */
  listMonospaceFonts(): Promise<string[]>;
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
  /**
   * Which CLI agent runs under the shell of each of the sessions, from the process tree of the
   * machine: an entry of `catalog` whose executable (or, behind a runner such as `node` or
   * `npx`, whose package) is a descendant process of the shell. One answer per session that has
   * one, the agent nearest to the shell; a session that is gone, or has none, is left out. It only
   * reads the list of processes. Rejects when the catalog is refused (more than 64 agents, a blank
   * or repeated id) or the lookup fails.
   */
  scanAgents(sessionIds: readonly SessionId[], catalog: readonly AgentEntry[]): Promise<AgentHit[]>;
  /**
   * Shows a notification of the system with plain text (no markup). Resolves when it was handed to
   * the system; rejects when it could not be (for example the system refused). It never asks for
   * the user's attention in any other way.
   */
  notify(title: string, body: string): Promise<void>;
  /** Whether the window of the app has the keyboard focus of the system now. */
  isWindowFocused(): Promise<boolean>;
  /**
   * Opens a web address in the browser of the system. Only `http://` and `https://` addresses are
   * opened (`externalLinkProblem` says why one is not); the backend checks again whatever the
   * caller did, and rejects with that sentence. The page confirms with the person before calling.
   */
  openExternal(url: string): Promise<void>;
}
