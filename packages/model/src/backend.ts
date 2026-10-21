/**
 * The backend contract: the terminal, the files of the app and the AI. It never imports DOM or
 * Tauri. The AI side is the `ai` member (`ai.providers`, `ai.configure`, `ai.setKey`,
 * `ai.listOllamaModels`, `ai.testConnection`); asking a question (`ai.*` streaming) joins it with
 * the Ask panel.
 */

import type { AgentEntry } from "./agents";
import type { AiBackend } from "./ai";
import type { BackgroundImageFile } from "./background";
import type { BenchHardware } from "./bench-models";
import type { BrowserBounds } from "./browser";
import type { PluginFolder } from "./plugins-load";
import type { FilePreview } from "./file-preview";
import type { GalleryIndex, InstalledGalleryItem } from "./gallery";
import type {
  SyncPullResult,
  SyncPushResult,
  SyncSpaceFolder,
  SyncSpaceLink,
  SyncSpaceWrite,
  SyncStatus,
} from "./sync";
import type { GitDiff } from "./git-diff";
import type { Id } from "./types";
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
  /**
   * `"ssh"` for a profile whose shell lives in a `norend` on another machine (its connection can
   * drop and come back, see `onSessionLink`); absent for a shell on this machine.
   */
  kind?: "ssh";
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
  /**
   * The pane the shell is for. A shell that has a pane outlives the app when the settings keep
   * sessions (`sessions.keepOnClose`): the next start gives the pane the same shell back
   * (`reattachSession`). A shell with none, such as the one in the quick window, ends with the app.
   */
  paneId?: string;
}

/** What `Backend.attachSession` can be asked besides taking the output over. */
export interface AttachSessionOptions {
  /** Deliver what the session printed before, ahead of what it prints next (see `attachSession`). */
  replay?: boolean;
}

/** What `Backend.openBrowserPane` can be asked besides the pane, the address and the place. */
export interface BrowserOpenOptions {
  /** The window besides the main one the web view is a child of (see `openBrowserPane`). */
  windowId?: Id;
}

/** How a session ended. */
export interface SessionExit {
  id: SessionId;
  code: number;
  /** Name of the terminating signal, when the shell was killed by one. */
  signal?: string;
}

/** Where the connection of a session to its shell stands: see `SessionLink`. */
export type SessionLinkState = "connected" | "reconnecting" | "failed";

/**
 * A change in the connection between the window and the shell of a session whose profile is an SSH
 * one (`ShellProfile.kind`). The shell itself lives on the other machine and is not touched by a
 * break: the connection is made again, and the session goes on where it was. A session of a shell on
 * this machine never has one. A session starts connected; this is told only when that changes.
 */
export interface SessionLink {
  id: SessionId;
  state: SessionLinkState;
  /** `reconnecting`: which attempt this is, counted from 1... */
  attempt?: number;
  /** ...of how many in all; after the last one the state is `failed`. */
  maxAttempts?: number;
  /** `reconnecting`: milliseconds until the attempt starts. */
  retryInMs?: number;
  /**
   * `reconnecting` and `failed`: why the connection broke or the attempt failed, in a sentence for
   * a person (the words of `ssh`, such as a refused key or a host key that changed).
   */
  reason?: string;
}

/** What `HEAD` of the git repository a folder is in points at. */
export interface GitInfo {
  /** The branch, or the first 7 characters of the commit when `HEAD` is detached. */
  branch: string;
  /** `HEAD` holds a commit and no branch. */
  detached: boolean;
}

/** One worktree of a git repository. */
export interface Worktree {
  /** The folder of the worktree, in the form of the system. */
  path: string;
  /** The branch checked out; `null` when `HEAD` is detached. */
  branch: string | null;
  /** The commit `HEAD` points at. */
  head: string | null;
  detached: boolean;
  /** The main worktree: the repository itself, which is never removed. */
  main: boolean;
  locked: boolean;
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

/** A bench result on disk: the name of its file in `bench-results` (`2026-10-20-140509.json`) and its JSON text. */
export interface BenchResultFile {
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
   * session has the id (never started, or already ended). A session taken over this way has no pane
   * (see `CreateSessionOptions.paneId`), so it does not outlive the app.
   *
   * With `options.replay` the terminal that is about to be drawn for the session is not an empty one
   * that has seen nothing (a window that just got the tab, the main window getting it back): what
   * the session printed before, as far back as its host keeps it (the session daemon keeps a
   * megabyte), is delivered to the first `onOutput` subscriber before anything the shell prints
   * from then on, with nothing missing and nothing repeated. A host that keeps nothing (the shells
   * that run inside the app, a shell on another machine) delivers only what comes next, as without
   * the option.
   */
  attachSession(id: SessionId, options?: AttachSessionOptions): Promise<void>;
  /**
   * Gives the pane `paneId` the shell it had before the app was closed, when the settings keep
   * sessions and the session daemon still holds it: from then on `onOutput(id)` delivers what the
   * shell printed meanwhile, then everything it prints, and the shell is the same process under the
   * same id (nothing is restarted). Resolves with that id, or with `undefined` when the pane has no
   * shell to come back to (the caller starts a new one with `createSession`). Never rejects for
   * that reason.
   */
  reattachSession(paneId: string): Promise<SessionId | undefined>;
  /**
   * Tells the backend whether the shells of the panes outlive the app (`sessions.keepOnClose` of the
   * settings): when the app closes, `true` leaves them running for the next start and `false` ends
   * them. Until it is called the backend ends them, as it always did. Rejects when the backend
   * cannot take the setting.
   */
  setKeepSessions(keep: boolean): Promise<void>;
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
  /**
   * Called every time the connection of a session of an SSH profile changes (it broke and the
   * backend is trying again, it came back, or it gave up). Never called for a shell on this machine.
   * Stops when the returned function is called.
   */
  onSessionLink(callback: (link: SessionLink) => void): Unsubscribe;
  /**
   * Asks the connection of the session to try again now: it stops waiting between two attempts, or,
   * after it gave up (`failed`), starts the attempts over. The new state arrives through
   * `onSessionLink`. Nothing happens when the connection is up. Rejects when the id is not a
   * session of an SSH profile that is still held.
   */
  retrySession(id: SessionId): Promise<void>;
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
   * Writes the result of a bench run, the JSON of a `BenchRun`, to `bench-results/<name>.json` in
   * the data folder of the app, atomically, and resolves with the name of the file. The caller does
   * not name the file: it is `<YYYY-MM-DD-HHmmss>.json` from the `startedAt` of the run (UTC), and
   * `<...>-2.json`, `-3`, ... when that second already has a file, so a result is never replaced.
   * Rejects, writing nothing, when `text` is not a JSON object with an ISO 8601 `startedAt` in UTC,
   * is larger than `MAX_BENCH_RESULT_BYTES` or cannot be written. Whether it is a valid run is the
   * caller's job (`saveBenchRun` checks it with `benchRunSchema` first).
   */
  saveBenchResult(text: string): Promise<string>;
  /**
   * The saved bench results, newest first (by start time, then by the number in the second): at
   * most `MAX_BENCH_RESULTS`. The folder missing is no files. A file is left out when its name is
   * not one `saveBenchResult` writes, when it is a folder, is not UTF-8 text, is not shaped like a
   * JSON object or is larger than `MAX_BENCH_RESULT_BYTES`. Whether what is left is a valid run is
   * the caller's job (`loadBenchRuns`). Rejects when the folder cannot be read.
   */
  listBenchResults(): Promise<BenchResultFile[]>;
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
   * The folders of the plugins of the user (`plugins/<folder>/` next to `config.jsonc`), in the
   * order of the folder names: for each, the text of `plugin.json` and of the file its `main`
   * names, or a short sentence about why the folder could not be read as a plugin (no
   * `plugin.json`, a `main` that is absolute, uses `..` or leaves the folder by a link, is missing,
   * is larger than 256 KiB or is not UTF-8 text). Files and folders whose name starts with a dot
   * are left out; at most 50 folders are listed. The folder missing is no plugins and is never
   * made. Whether the text is a valid manifest is the caller's job (`checkPluginFolders`). Rejects
   * when the folder cannot be read.
   */
  listPlugins(): Promise<PluginFolder[]>;
  /**
   * The index of the gallery (`GALLERY_INDEX_URL` in `noren-core`), downloaded over https with a
   * deadline and a ceiling on its size and already checked against `galleryIndexSchema`. Rejects
   * with a sentence for the person when the gallery cannot be reached, answers with an error, is
   * too large or is not an index.
   */
  galleryIndex(): Promise<GalleryIndex>;
  /**
   * What the app installed from the gallery (`gallery.json` next to `config.jsonc`): the id, kind,
   * version and sha256 of each item, in the order they were first installed. Nothing installed, or
   * no record, is an empty list. Pairs with `galleryIndex` in `compareWithInstalled`.
   */
  galleryInstalled(): Promise<InstalledGalleryItem[]>;
  /**
   * Installs (or updates) the item `id` of the gallery: reads the index again, downloads the file
   * at the address the index gives, refuses it unless its sha256 is the one the index declares
   * (and it fits the size the index declares), and then puts it in place: a theme as
   * `themes/<id>.json`, a mod as `mods/<id>.css`. Records the item as installed and answers the
   * record. When anything fails, including a hash that does not match, nothing is written.
   */
  galleryInstall(id: string): Promise<InstalledGalleryItem>;
  /**
   * Where the sync of the settings through git stands (`noren-core::sync`), with no network: the
   * remote and branch of the clone kept next to `config.jsonc`, the files of the config folder a
   * push would carry (`config.jsonc`, `themes/`, `mods/` and `spaces/*.noren-space.json`, nothing
   * else), and how many commits the clone is ahead of and behind the remote as of the last fetch.
   * Not connected yet is `connected: false`. Rejects only when git cannot be run.
   */
  syncStatus(): Promise<SyncStatus>;
  /**
   * Connects to the git remote `remote`: checks the address (`syncRemoteProblem`) and clones it into
   * the clone folder, or points an existing clone at it. Copies nothing into the config folder.
   * Rejects with a sentence for the person when the address is refused, git is not installed or the
   * remote cannot be cloned.
   */
  syncConnect(remote: string): Promise<SyncStatus>;
  /**
   * Brings the remote into the config folder. The local files are committed into the clone first
   * and the remote is merged; on a conflict the merge is aborted, nothing in the config folder
   * changes and the paths in conflict come back (`kind: "conflict"`). Only a clean merge writes the
   * files it added or changed (`kind: "updated"`). Nothing is deleted. Rejects when no remote is
   * connected or git fails.
   */
  syncPull(): Promise<SyncPullResult>;
  /**
   * Commits the changed files of the config folder that may travel and pushes them. Rejects with
   * "pull first" when the remote has commits this computer lacks, when no remote is connected, or
   * when git fails.
   */
  syncPush(): Promise<SyncPushResult>;
  /**
   * The space files of the config folder (`spaces/<name>.noren-space.json`, NOR-F19-01c): each
   * with the hash of its bytes and the space the local record ties it to (`linked`, `null` for a
   * file nobody has made a space from here yet), and the names the clone of the sync holds (what the
   * remote had when it was last pulled or pushed). Only names of the closed list are listed, and a
   * file over the ceiling is left out. Works without a remote. Rejects when the record cannot be read.
   */
  syncSpaceFiles(): Promise<SyncSpaceFolder>;
  /**
   * The text of one space file by its bare name (`Work.noren-space.json`). Rejects for a name off
   * the closed list, a file that is missing or over the ceiling.
   */
  syncReadSpaceFile(name: string): Promise<string>;
  /**
   * Writes space files into the config folder and ties each to the space it is made from, with the
   * hash of what was written. Every name, size and id is checked first: one refusal writes nothing,
   * and rejects with a sentence. A file that holds the same text is not touched. The record is
   * local to this computer and is never sent by a push.
   */
  syncWriteSpaceFiles(files: readonly SyncSpaceWrite[]): Promise<void>;
  /**
   * Ties space files already in the folder (a pull brought them) to the spaces made from them, with
   * the hash of the files as they are now, so the next pull knows it has seen them.
   */
  syncLinkSpaceFiles(links: readonly SyncSpaceLink[]): Promise<void>;
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
   * The memory of this computer, in the form `recommendedBenchModels` takes: the total RAM and the
   * video memory in bytes, `vramBytes` being `null` when it is not known (no NVIDIA card or no
   * `nvidia-smi`, a card of another make, an answer that makes no sense). Both are whole numbers
   * above 0 that a JavaScript number holds exactly; a VRAM that is not is `null`. `null` when
   * the RAM is not known (a browser, which cannot ask its visitor's computer for it, answers
   * `null`). It only reads: nothing is written, installed or sent anywhere. Rejects only when
   * the lookup itself fails.
   */
  readHardware(): Promise<BenchHardware | null>;
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
   * The git worktrees of the repository the folder `cwd` is in, the main one first. Runs `git`.
   * Rejects with a sentence when git is not installed or `cwd` is in no repository.
   */
  listWorktrees(cwd: string): Promise<Worktree[]>;
  /**
   * Adds a worktree on `branch` next to the repository `cwd` is in, in
   * `<parent>/<repository>-<branch with / as ->`, and resolves with it. The branch is created from
   * the `HEAD` of `cwd` when it does not exist and used as it is when it does. Rejects with the
   * reason when the name is empty, starts with `-` or is not a branch name git accepts, when the
   * folder exists, or when git refuses (a branch checked out in another worktree).
   */
  createWorktree(cwd: string, branch: string): Promise<Worktree>;
  /**
   * Removes the worktree at `path` of the repository `cwd` is in. Never forced: a worktree with
   * changes rejects with the message of git, and the main worktree cannot be removed. The branch
   * is kept.
   */
  removeWorktree(cwd: string, path: string): Promise<void>;
  /**
   * The hosts the `Host` lines of the `~/.ssh/config` of the user name, in order, each once. A name
   * with a wildcard or with anything that is not safe to type as `ssh <host>` is left out;
   * `Include` and `Match` are not followed. No file is an empty list. Rejects with a sentence when
   * the file cannot be read.
   */
  listSshHosts(): Promise<string[]>;
  /**
   * The names of the running containers (`docker ps`), in order, each once. A name that is not safe
   * to type into a shell as `docker exec -it <name> sh` is left out. Rejects with a sentence when
   * Docker is not installed (`docker not found`), fails or does not answer in time.
   */
  listDockerContainers(): Promise<string[]>;
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
   * Opens the native window `windowId` of the app, showing the space `spaceId` (an `AppWindow` of
   * the workspace). The window is made, loads the page of the app and listens for the tabs that are
   * moved to it (`moveTabToWindow`); it is shown unless the run is a smoke run, which keeps every
   * window hidden. The window does not load or save the state: the main window owns it, and is the
   * only one that writes `state.json` (a window gets no `loadState`, `saveState` or
   * `quarantineState`). Resolves when the window exists, not when its page is up. Rejects, opening
   * nothing, when `windowId` is not a window id (`isWindowId`: it becomes the label of the native
   * window), when `spaceId` is blank or when the window is open already.
   */
  openWindow(windowId: Id, spaceId: Id): Promise<void>;
  /**
   * Closes the window `windowId`. The sessions it was showing are not ended: they are still the same
   * processes, with nowhere to send their output until a page takes them over again
   * (`attachSession`). A window that is not open is not an error. It does not call `onWindowClosed`
   * (the caller asked for it).
   */
  closeWindow(windowId: Id): Promise<void>;
  /**
   * Moves the tab whose shells are `sessionIds` to the window `windowId`: from then on the output
   * of each session goes to the page of that window and no longer to the page that had it. Every
   * session is the same process under the same id, nothing is restarted, and what a shell prints
   * while this is being done is held and reaches the new page in order. Resolves when the page of
   * the window has taken all of them over; a tab with no shell (a browser, preview or diff pane
   * only) has nothing to take and resolves at once. Rejects, changing nothing for the sessions
   * not yet taken, when the window is not open, when its page is not up within a few seconds, when
   * a session is not a live one or when the page refuses. The caller keeps the state: moving the
   * tab in the workspace (`window/move-item`) is its job.
   */
  moveTabToWindow(windowId: Id, sessionIds: readonly SessionId[]): Promise<void>;
  /**
   * Called when a window opened with `openWindow` is closed by the person (its close button), not
   * by `closeWindow`. The sessions it was showing keep running with nowhere to send their output;
   * taking the tabs back is the caller's job. Stops when the returned function is called.
   */
  onWindowClosed(callback: (windowId: Id) => void): Unsubscribe;
  /**
   * Opens a web address in the browser of the system. Only `http://` and `https://` addresses are
   * opened (`externalLinkProblem` says why one is not); the backend checks again whatever the
   * caller did, and rejects with that sentence. The page confirms with the person before calling.
   */
  openExternal(url: string): Promise<void>;
  /**
   * Opens the web view of the browser pane `paneId` at `bounds` (CSS pixels from the top left
   * corner of the page of the window) showing `url`, laid over the window like a child of it. The
   * page in it is someone else's: it can reach nothing of the app, no command and no event, and it
   * can only go to `http://` and `https://` addresses (`browserUrlProblem`). Rejects, opening
   * nothing, when `paneId` is not a pane id (`isBrowserPaneId`: it becomes the name of the web
   * view), when the address or the bounds are refused (`browserUrlProblem`, `browserBoundsProblem`)
   * or when the pane already has a web view. Resolves when the web view exists, not when the page
   * has loaded.
   *
   * The web view is a child of the main window, or of the window `options.windowId` (one opened
   * with `openWindow`, and still open) when that is given: the page of a window besides the main
   * one cannot call this, so the main window opens the web view for it with the bounds the page
   * of the window measured. The bounds are then from the top left corner of the page of that
   * window. Rejects, opening nothing, when that window is not open. The other three calls find the
   * web view by the pane and are the same whichever window it is a child of. A web view goes away
   * with its window: closing the window (`closeWindow`, or the person) closes it too.
   */
  openBrowserPane(
    paneId: Id,
    url: string,
    bounds: BrowserBounds,
    options?: BrowserOpenOptions,
  ): Promise<void>;
  /**
   * Takes the web view of the pane `paneId` to `url`. Rejects when the pane has no web view or the
   * address is refused (`browserUrlProblem`); the web view stays where it was.
   */
  navigateBrowserPane(paneId: Id, url: string): Promise<void>;
  /**
   * Moves and resizes the web view of the pane `paneId`. Rejects when the pane has no web view or
   * the bounds are refused (`browserBoundsProblem`).
   */
  setBrowserPaneBounds(paneId: Id, bounds: BrowserBounds): Promise<void>;
  /** Closes the web view of the pane `paneId`. A pane with none is not an error. */
  closeBrowserPane(paneId: Id): Promise<void>;
  /**
   * Reads the file at `path` for a preview pane: markdown, JSON or plain text as text (at most
   * `MAX_PREVIEW_TEXT_BYTES`), or a png, jpeg, gif or webp picture as bytes (at most
   * `MAX_PREVIEW_IMAGE_BYTES`; the first bytes decide, not the name). A file that cannot be shown
   * is not an error: the answer is `{ kind: "refused", reason }` (`PREVIEW_REFUSALS`: a path that is
   * not a full local path, a folder, nothing there, a binary file, too large, unreadable), so the
   * pane can say why. The call rejects only when the shell itself fails. Nothing is fetched from the
   * network and nothing is written.
   */
  readFilePreview(path: string): Promise<FilePreview>;
  /**
   * Reads the git diff of the folder `cwd` for a diff pane: what the working tree and the index
   * hold against `HEAD` (against the empty tree when the repository has no commit yet), as the text
   * `git diff` prints, empty when nothing changed (`parseGitDiff` reads it). The folder may be any
   * folder inside the repository; the diff is always of the whole repository. Files git does not
   * track are not in it. A folder that cannot be read is not an error: the answer is
   * `{ kind: "refused", reason }` (`GIT_DIFF_REFUSALS`: a folder that is not a full local path,
   * missing, in no repository, git not installed, a diff over `MAX_GIT_DIFF_BYTES`, git refusing),
   * so the pane can say why. The call rejects only when the shell itself fails. Nothing is written
   * (the index is not refreshed on disk), no program from the repository's own settings runs, and
   * nothing is fetched from the network.
   */
  readGitDiff(cwd: string): Promise<GitDiff>;
}
