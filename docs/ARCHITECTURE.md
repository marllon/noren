# Architecture

Noren (暖簾) is the curtain split into panels that hangs in the doorway of Japanese shops. It is the name and the metaphor of the product: a space divided into panels, each one leading somewhere.

## Principles

1. **Your way.** Sidebar on the left, on the right, hidden, or tabs on top; nested groups or a flat list; a theme per space; your own CSS. No layout is imposed.
2. **Windows is a first-class platform.** Developed and tested on Windows first (ConPTY, PowerShell, Git Bash, WSL, Mica). macOS and Linux are guaranteed by CI.
3. **Light.** Tauri 2, no Electron. Opens fast, uses little memory.
4. **Keyboard and mouse.** Everything has a shortcut, and everything also works with click and drag.
5. **Optional, safe AI.** Off until the user configures it; local (Ollama) by default; never runs a command on its own; shows what it is about to send.
6. **No account, no telemetry.** Everything is local. No data leaves the machine without an explicit user action.

## Layout of the repository

```
noren/
  apps/desktop/                 Tauri 2 app
    src/                        React 19 + TypeScript interface
    src-tauri/                  thin Rust layer: commands, events, window, menus, global shortcuts
  crates/noren-core/            Rust library without Tauri: PTY, profiles, config, persistence, git, AI client
  packages/model/               pure TypeScript: data model, operations, invariants, Backend interface, FakeBackend
  e2e/                          Playwright in web mode (FakeBackend)
  docs/                         ARCHITECTURE, THEMING, CONFIG, PERF (English)
  themes/                       built-in themes (JSON)
```

- **pnpm workspaces** (`apps/*`, `packages/*`) and a **Cargo workspace** (`crates/*`, `apps/desktop/src-tauri`) at the root.
- **`noren-core` does not depend on Tauri.** It is tested quickly with `cargo test -p noren-core` and is designed to later become a standalone daemon.
- **`Backend` interface** (in `packages/model`): `listProfiles`, `setUserProfiles`, `createSession`, `write`, `resize`, `kill`, `onOutput`, `onExit`, `loadState`, `saveState`, `quarantineState`, `loadScrollback`, `saveScrollback`, `deleteScrollback`, `loadConfig`, `saveConfig`, `watchConfig`, `listUserThemes`, `saveUserTheme`, `listMods`, `watchMods`, `setWindowEffect`, `readBackgroundImage`, `listMonospaceFonts`, `gitInfo`, `ai.*`. There are two implementations: `TauriBackend` (the app) and `FakeBackend` (tests, end-to-end runs and the web demo). The interface never imports anything from the DOM or from Tauri.
- **Terminal output flow.** A PTY reader thread in Rust gathers bytes into batches (up to 64 KB or 8 ms) and sends them through a `tauri::ipc::Channel` with a binary payload (`ArrayBuffer`). The interface writes the `Uint8Array` straight into xterm. Input goes the other way: xterm's `onData` becomes `invoke('session_write')`.
- **Interface state.** Zustand wraps the pure reducer from `packages/model`; the operations do not know React exists.
- **Interface libraries.** `@xterm/xterm` and its addons (webgl, fit, search, web-links, unicode11, serialize), `cmdk` (command palette), `@dnd-kit` (drag and drop), `react-resizable-panels` (splits), `lucide-react` (icons). All are MIT or ISC.
- **Crates.** `portable-pty`, `serde` / `serde_json`, a JSONC parser, `notify` (config reload), `keyring`, `reqwest` (rustls), `tokio`, `window-vibrancy`, `fontdb` (the monospaced fonts installed on the machine), and the Tauri plugins (`global-shortcut`, `notification`, `dialog`, `opener`).
- **App identifier:** `io.github.marllon.noren`. Binary: `noren`.

## Data model

Defined in TypeScript in `packages/model`.

```ts
type Id = string;

interface Workspace {
  // state saved in state.json
  version: 1;
  spaces: Space[];
  activeSpaceId: Id;
  favorites: Id[]; // item ids, global
  closed: ClosedItem[]; // stack, at most 50
  archive: ArchivedItem[];
}

interface ClosedItem {
  item: Item; // without sessions
  spaceId: Id;
  closedAt: number;
  place?: { list: "pinned" | "tree"; groupId?: Id; index: number }; // where it sat; absent in a state saved before this field
}

interface ArchivedItem {
  item: Item; // without sessions
  spaceId: Id;
  archivedAt: number;
  place?: { list: "pinned" | "tree"; groupId?: Id; index: number }; // the same slot a closed item keeps
}

interface Space {
  id: Id;
  name: string;
  icon: string;
  color: string;
  themeId?: string;
  background?: { image: string; opacity?: number; blur?: number }; // a picture file on this computer
  modIds: string[];
  defaults: {
    profileId?: string;
    cwd?: string;
    env: Record<string, string>;
    gitIdentity?: { name: string; email: string };
  };
  aiEnabled: boolean;
  saveScrollback: boolean;
  pinned: Id[]; // item ids, visual order
  tree: Node[]; // sidebar below the pinned items
  items: Record<Id, Item>; // every item of the space (pinned and in the tree)
}

type Node =
  | { kind: "item"; id: Id }
  | {
      kind: "group";
      id: Id;
      name: string;
      color: string;
      collapsed: boolean;
      children: Node[];
    }; // groups: up to 2 levels

interface Item {
  id: Id;
  title?: string;
  titleLocked: boolean;
  layout: LayoutNode; // 1 pane = a tab; 2 to 4 = a split
  focusedPaneId: Id;
  zoomedPaneId?: Id;
  origin?: { cwd: string; profileId: string; command?: string }; // to "reset" a pinned item
  lastActivityAt: number;
}

type LayoutNode =
  | { kind: "pane"; pane: Pane }
  | { kind: "split"; dir: "row" | "column"; sizes: number[]; children: LayoutNode[] };

interface Pane {
  id: Id;
  type: "terminal"; // 'browser' | 'preview' | 'agent' later
  sessionId?: Id;
  profileId: string;
  cwd?: string;
  status: "running" | "idle" | "exited";
  exitCode?: number;
  lastCommand?: { text?: string; exitCode?: number; durationMs?: number };
  unread: boolean;
  bell: boolean;
  scrollbackRef?: string; // file holding the scrollback snapshot
}
```

Invariants (checked with property-based tests): every pane belongs to exactly one item; every item appears exactly once (pinned or in the tree); groups nest at most 2 levels; a split has between 2 and `maxPanes` leaves and its `sizes` add up to 100; ids are unique; no orphan session remains after closing an item, a space or a pane.

## Files, configuration and themes

- `state.json`: the `Workspace` above. Written atomically (temporary file plus rename), debounced by 500 ms, with a `version` field and migrations. In `packages/model`, `serializeWorkspace` and `parseState` (version, migrations, shape check, `checkInvariants`) read and write the text, `StateWriter` does the debounce, and `restoreWorkspace` loads the file and starts one session per pane in its saved cwd. Sessions are never saved. A file that cannot be used (broken JSON, wrong shape, broken invariants, unknown or newer version) is copied by `quarantineState` and the default workspace takes its place.
- `scrollback/<paneId>.txt`: a snapshot (xterm serialize addon) of the last 2,000 lines, only when the space and the settings allow it (`terminal.saveScrollback`, see [CONFIG.md](CONFIG.md#saved-scrollback)). It sits in a folder next to `state.json`, and `Pane.scrollbackRef` in `state.json` says which panes have one.
  - **Saving.** `ScrollbackSaver` (`apps/desktop/src/scrollback-saver.ts`) writes the panes that printed since their last snapshot every 60 seconds, on an injected `Clock` (the tests move it by hand; web mode uses the clock of the fake shell), and once more when the window closes. In the app, closing is held by the Rust side (`apps/desktop/src-tauri/src/lifecycle.rs`): once the page has said it listens (`app_close_listening`), a request to close keeps the window, tells the page with the `close-requested` event, and destroys the window when the page answers `app_close_ready` or after 4 seconds; the page (`close-handler.ts`) starts the snapshots and flushes the state, and answers when they are written or after 2 seconds. A page that never said it listens, or a second request while one is held, closes at once, as before. A call made from `beforeunload` while the window is torn down may never leave the page, so the page also starts the saves on `beforeunload` and `pagehide`, which is what web mode and a reload have; the snapshots are started before the state is flushed, so the notes they make on the panes are in the state written then. A pane is saved only if `savesScrollback(setting, space)` says so; when it says no, nothing is written and a file saved before is removed. The text is what the serialize addon makes of the normal screen, passed through `cleanSnapshot` (see below) and limited to 2,000 lines and 4 MiB. Saves of one pane never overlap.
  - **The folder.** `crates/noren-core/src/scrollback.rs` (`ScrollbackStore`) keeps text and does not look inside it. The id of the pane becomes a file name, so it must be ASCII letters, digits, `-` and `_` (at most 64, not a Windows device name): a path is refused before the disk is touched, by `load`, `save` and `delete` alike. The write is atomic (the same temporary-file-and-rename path as `state.json`), the size is limited in both directions, and reading or deleting never creates the folder. The Tauri commands are `scrollback_load`, `scrollback_save` and `scrollback_delete`; the smoke run can read and never writes or removes there.
  - **Restoring.** At start, after the shells are restarted in their saved folders, `scrollback-restore.ts` reads the snapshot of each pane that records one and builds the text that shows it again: the saved lines dimmed (SGR 2, put back after every color so a reset in the old text does not end it), then the line `session restored <date and time>`. `TerminalView` writes that text to its xterm before it subscribes to the output of the new session, so it sits above everything the new shell prints.
  - **Closed tabs.** Closing a tab (the tab, its last pane, or its space) pushes it on `Workspace.closed` (50 at most, the oldest drops off) with its `place`: the list it was in (pinned or tree), the group that held it and its position, which `item/close` reads from the space before the item leaves. `state.json` validates `place` and a file without it still loads. `item/reopen` puts the item back in its space, in the same list, group and position (clamped to what the list holds now); a group that is gone, or an entry without a place, sends it to the end of the tree of its space, and a space that is gone to the end of the tree of the active space. The pane comes back clean (no session, the exit code and command of the old shell forgotten), with the same id, profile and folder. The snapshot follows the stack. `startScrollback` watches the workspace (`closed-scrollback.ts`, `closedChanges`): for the panes of the entries that joined the stack it asks their terminals for the lines while they are still alive (before the render that unmounts them) and writes them with `ScrollbackSaver.saveNow` as the action ends, under the same rules as the saves of every minute (`savesScrollback`: the setting of the app and of the space of the tab; an older file is kept when the terminal has nothing to say and removed when the rules say never); the note `pane/set-scrollback` reaches the panes of a closed entry. A pane with a file that is no longer anywhere in the workspace (open, closed or archived) because its tab fell off the stack of 50, its split pane was closed or a reset replaced it, has its file removed (`ScrollbackSaver.discard`). Reopening (`reopen-closed.ts`, `reopenClosed`) reads the snapshots of the entry the same way the start of the app does (`loadScrollbackForItem`), hands the dimmed text and the `session restored` line to the terminals that mount, and only then dispatches `item/reopen` and activates the space; the shell is new, in the folder and profile of the pane. Two reopens in a row are queued, each taking the newest entry left. A setting that has since turned saving off shows nothing and removes the file.
  - **Auto-archive and the library.** An idle open tab goes to `Workspace.archive` (`item/archive`, which keeps its `place` and drops its sessions like `item/close`, without the limit of 50), comes back with `archive/restore` (the same placement rules as `item/reopen`, which share their code in the reducer), and `archive/delete` and `closed/delete` forget an entry for good. `idleItems` (`packages/model/src/archive.ts`) is the pure rule: not pinned, not a favorite, not the tab on screen, no pane with a command running (`runningCommand`, set by OSC 133;C and cleared by 133;D) or `status: "running"`, nothing unread, and no sign of life for `archive.afterHours`. `AutoArchiver` (`apps/desktop/src/auto-archiver.ts`) asks every minute on an injected `Clock`: it keeps the last sign of life of each tab in memory (a pane's output, noted from the terminal; the tab on screen counts as alive at every check), with the moment the app opened as the floor, and dispatches `item/archive` for the idle ones. `Item.lastActivityAt` is not moved by activity (it says when the tab was made, restored or reset), so nothing is written to `state.json` for it. The scrollback files follow the lists with the same subscription as the closed stack (`closedChanges` reads the entries that joined the closed stack or the archive, the panes that left every list): a tab that is archived has its snapshot written as it leaves, and one that is deleted from the library has its files removed. `Library.tsx` lists both with the pure `library-entries.ts` and restores through `reopenClosed({ from: "archive" })`. In web mode the clock of the checks is the one of the fake shell plus the real time (`archiveClock`), so a test that advances it by hours finds every tab hours older. See [LIBRARY.md](LIBRARY.md).
  - **The snapshot is untrusted.** It is a file that another program could have changed, and a terminal obeys what it is written. `cleanSnapshot` (`packages/model/src/scrollback.ts`) keeps only printable text, tabs, line breaks and SGR color/style sequences, and runs on the way out and on the way in. Everything else is dropped whole: OSC (title, clipboard, notifications), DCS/APC/PM strings, every CSI that is not a color (modes, the alternate screen, mouse tracking, cursor moves, requests that make the terminal answer), single escapes, every control character and the eight-bit controls. The one CSI it uses is the move to the right the serializer writes over empty cells, which becomes blanks.
- `config.jsonc`: appearance (theme, density, sidebar position, compact mode, opacity, background), terminal (font, cursor, scrollback, paste), profiles (detected and user-defined, with `injectIntegration`), shortcuts, auto-archive, notifications, and AI (providers without keys; the key lives in the system keychain). JSON with comments and trailing commas, in the app config folder. The schema is zod, in `packages/model/src/config.ts`, with `docs/config.schema.json` generated from it (`pnpm --filter @noren/model config:schema`; a test fails when it is out of date). `noren-core` reads, writes atomically and watches the file (`notify`); the interface reads it with `Backend.loadConfig`, follows it with `Backend.watchConfig`, applies a valid text at once and, for an invalid one, keeps the last valid settings and shows a notice with the line. The settings screen writes it with `Backend.saveConfig`, after `editConfigText` changed only the settings that differ in the text read a moment before, so the comments of the file stay. See [CONFIG.md](CONFIG.md).
- Theme (`themes/*.json`):

```json
{
  "id": "noren-dusk",
  "name": "Noren Dusk",
  "kind": "dark",
  "ui": {
    "bg": "#14161b",
    "surface": "#1b1e25",
    "text": "#e6e6e6",
    "muted": "#9aa0aa",
    "accent": "#e07a5f",
    "border": "#2a2e37",
    "radius": 10,
    "blur": 18,
    "opacity": 0.92
  },
  "terminal": {
    "foreground": "#e6e6e6",
    "background": "#14161b",
    "cursor": "#e07a5f",
    "selection": "#e07a5f55",
    "ansi": [
      "#1b1e25",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#dcdfe4",
      "#5c6370",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#ffffff"
    ]
  },
  "font": {
    "family": "Cascadia Code, JetBrains Mono, monospace",
    "size": 13,
    "lineHeight": 1.2,
    "ligatures": true
  },
  "background": { "image": null, "opacity": 0.15 }
}
```

- **Theme API for mods.** CSS variables `--nr-bg`, `--nr-surface`, `--nr-text`, `--nr-muted`, `--nr-accent`, `--nr-border`, `--nr-radius`, `--nr-space-color`, and attributes `data-nr-part` (the part: `sidebar`, `space-switcher`, `item`, `group`, `favorites`, `pane`, `pane-header`, `palette`, ...) and `data-nr-state` (its state: `active`, `expanded`/`collapsed`, ...). The tables of what exists today are in [THEMING.md](THEMING.md#the-theme-api), and a test holds them to the source. Renaming any of these is a breaking API change and must be noted in the release notes.
- **The window.** The main window is created transparent (`tauri.conf.json`), so an effect can show through the page; the page paints it opaque unless the opacity says otherwise. `Backend.setWindowEffect(effect, scheme)` asks the system for Mica, Acrylic or vibrancy, painted dark or light like the theme that was chosen (`system` while the theme follows the system), and answers what the window has: a system that cannot paint it answers `none` with the reason and the window stays opaque (the rule is `apply_effect` in `noren-core`, the native calls are `window-vibrancy` in `apps/desktop/src-tauri/src/window_effect.rs`). `appearance.window.opacity` reaches the page as `--nr-opacity`. A background picture comes from the theme, the settings or the space; `Backend.readBackgroundImage(path)` reads a local picture file (the path, the size and the first bytes are checked in `noren-core`, nothing is fetched) and the page shows the bytes from memory. See [THEMING.md](THEMING.md#the-window-effect-opacity-and-background).
- **Terminal options.** `terminal` in `config.jsonc` (font, cursor, scrollback, bell; see [CONFIG.md](CONFIG.md#the-terminal)) is read through `terminalOptionsOf` in `packages/model`, so the defaults are the values `TerminalView` used to hard-code. A terminal that is running takes a changed file, and the zoom of the font (Ctrl+= / Ctrl+- / Ctrl+0, kept in memory and never written), by changing the options of its xterm: its session is not touched. The font names are untrusted text and only names get through (`parseFontFamilies`). `Backend.listMonospaceFonts` comes from `noren-core` (`fonts.rs`, `fontdb`); the Tauri command is `fonts_list_monospace`.
- **Mods.** CSS files of the user in the `mods/` folder next to `config.jsonc`, turned on for every space (`mods` in `config.jsonc`) or for one (`modIds` of the space in `state.json`, the `space/set-mods` action). The interface reads the folder through `Backend.listMods` and follows it with `Backend.watchMods` (`noren-core` watches the folder with `notify`), and puts each mod in a `<style data-nr-mod>` wrapped in `@layer mods`. The stylesheet of the app is in the layers `vendor` and `base` (`app.css`), declared before `mods`, so a mod wins over the style of the app with a plain selector. See [THEMING.md](THEMING.md#mods-your-own-css).

## Quality and tests

| Layer           | Tool                                                    | What it covers                                                                                                                                                 |
| --------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model (pure TS) | Vitest + fast-check                                     | Operations, invariants, state migrations, parsers (OSC, themes, importers, config)                                                                             |
| Interface       | Vitest + Testing Library (jsdom)                        | Isolated components where it is worth it                                                                                                                       |
| Functional e2e  | Playwright in web mode with `FakeBackend`               | Flows: create a space, a group, a split, drag, palette, restore, archive, themes                                                                               |
| Visual e2e      | Playwright `toHaveScreenshot` (Windows only, `@visual`) | Key interface states in light, dark and compact themes                                                                                                         |
| Rust            | `cargo test`                                            | PTY (spawn, write, read, resize, exit), profiles with a fake environment, config, atomic persistence, git, AI client against a local test HTTP server          |
| Desktop         | `noren --smoke`                                         | The real app opens, runs `echo noren-smoke-ok` in the default shell, gives the hidden window Mica, saves and reads a snapshot in the temp folder, exits with 0 |

Rules: no test reaches the external network; AI is always tested with a fake provider; a green `pnpm verify` is required for every code change.
