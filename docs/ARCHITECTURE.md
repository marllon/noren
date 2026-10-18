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
- **`Backend` interface** (in `packages/model`): `listProfiles`, `createSession`, `write`, `resize`, `kill`, `onOutput`, `onExit`, `loadState`, `saveState`, `loadConfig`, `watchConfig`, `gitInfo`, `ai.*`. There are two implementations: `TauriBackend` (the app) and `FakeBackend` (tests, end-to-end runs and the web demo). The interface never imports anything from the DOM or from Tauri.
- **Terminal output flow.** A PTY reader thread in Rust gathers bytes into batches (up to 64 KB or 8 ms) and sends them through a `tauri::ipc::Channel` with a binary payload (`ArrayBuffer`). The interface writes the `Uint8Array` straight into xterm. Input goes the other way: xterm's `onData` becomes `invoke('session_write')`.
- **Interface state.** Zustand wraps the pure reducer from `packages/model`; the operations do not know React exists.
- **Interface libraries.** `@xterm/xterm` and its addons (webgl, fit, search, web-links, unicode11, serialize), `cmdk` (command palette), `@dnd-kit` (drag and drop), `react-resizable-panels` (splits), `lucide-react` (icons). All are MIT or ISC.
- **Crates.** `portable-pty`, `serde` / `serde_json`, a JSONC parser, `notify` (config reload), `keyring`, `reqwest` (rustls), `tokio`, `window-vibrancy`, and the Tauri plugins (`global-shortcut`, `notification`, `dialog`, `opener`).
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

interface Space {
  id: Id;
  name: string;
  icon: string;
  color: string;
  themeId?: string;
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

- `state.json`: the `Workspace` above. Written atomically (temporary file plus rename), debounced by 500 ms, with a `version` field and migrations.
- `scrollback/<paneId>.txt`: a snapshot (xterm serialize addon) of the last 2,000 lines, only when the space allows it.
- `config.jsonc`: appearance (theme, density, sidebar position, compact mode, opacity, background), terminal (font, cursor, scrollback, paste), profiles (detected and user-defined, with `injectIntegration`), shortcuts, auto-archive, notifications, and AI (providers without keys; the key lives in the system keychain).
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

- **Theme API for mods.** CSS variables `--nr-bg`, `--nr-surface`, `--nr-text`, `--nr-muted`, `--nr-accent`, `--nr-border`, `--nr-radius`, `--nr-space-color`, and stable attributes `data-nr-part="sidebar|space-switcher|item|group|pinned|favorites|pane|pane-header|palette|ask-panel"` and `data-nr-state="active|unread|running|exited-error"`. Renaming any of these is a breaking API change and must be noted in the changelog.

## Quality and tests

| Layer           | Tool                                                    | What it covers                                                                                                                                        |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model (pure TS) | Vitest + fast-check                                     | Operations, invariants, state migrations, parsers (OSC, themes, importers, config)                                                                    |
| Interface       | Vitest + Testing Library (jsdom)                        | Isolated components where it is worth it                                                                                                              |
| Functional e2e  | Playwright in web mode with `FakeBackend`               | Flows: create a space, a group, a split, drag, palette, restore, archive, themes                                                                      |
| Visual e2e      | Playwright `toHaveScreenshot` (Windows only, `@visual`) | Key interface states in light, dark and compact themes                                                                                                |
| Rust            | `cargo test`                                            | PTY (spawn, write, read, resize, exit), profiles with a fake environment, config, atomic persistence, git, AI client against a local test HTTP server |
| Desktop         | `noren --smoke`                                         | The real app opens, creates a session of the default shell, runs `echo noren-smoke-ok`, checks the output and exits with 0                            |

Rules: no test reaches the external network; AI is always tested with a fake provider; a green `pnpm verify` is required for every code change.
