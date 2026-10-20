# Changelog

All notable changes to Noren are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Browser pane**: a pane that shows a web page, with an address bar, inside a split. Ctrl+click (Cmd+click on a Mac) on an `http` or `https` address in the output opens one beside the terminal; a click without Ctrl asks first, as before. The address bar refuses `file`, `javascript` and the rest with the reason; the page is saved with the tab and comes back after a restart. The web view is opened when the pane is first seen, follows the pane, steps out of sight under a dialog, in another tab or space or while another pane is zoomed, and is closed with the pane, the tab or the space.
- **Launch README and media**: `pnpm media` drives the web demo with a script (spaces, a tab dragged into a split, the palette, a theme change, Ask with the fake provider) and writes ten screenshots and a webm video to `docs/media/`; the README is the launch README, `docs/ROADMAP.md` is the public roadmap by version, and `pnpm readme:check` (part of `pnpm verify`) fails when a relative link or image of the README is missing.
- **Web demo**: `pnpm demo:build` builds a static copy of the interface into `dist-demo/` with a
  simulated shell, a script of example spaces, a group, a split and themes, and a strip that gives
  the download address; `pnpm e2e:demo` tests it; `pages.yml` deploys it by hand (`workflow_dispatch`).

## [0.1.0] - Unreleased

First MVP. Noren is a terminal organized like a modern browser. Windows is the first platform
(NSIS and MSI installers); the Linux build is an AppImage and a deb. The build is not signed and
has no automatic updater yet.

### Added

- **Terminal core**: real PTY sessions through `portable-pty` with batched reads, xterm.js with the
  WebGL renderer, shell profiles detected on the machine (PowerShell, cmd, bash, zsh and others),
  and a typed backend interface with a fake backend for tests.
- **Spaces, groups and tabs**: a workspace model with checked invariants; spaces with their own
  icon, color, theme and background image; a space wheel and git identity per space; groups, pinned
  tabs and favorites (a grid) with their origin and a "reset" action.
- **Sidebar**: a tree of spaces, groups and tabs with a second line of live metadata (folder, git
  branch, last command), unread marks and a bell, drag and drop between groups, spaces, pinned and
  favorites, and side, width, density and compact settings.
- **Layout modes**: sidebar or top tabs, switchable from settings and from the command palette.
- **Splits**: panes inside any tab, split by shortcut or by dragging, swap and detach panes, pane
  headers with zoom, and splits shown in the sidebar.
- **Command palette and shortcuts**: tabs, spaces, actions, profiles, recent folders and themes in
  one palette; a shortcut registry with a screen to review and rebind them; a most-recently-used
  switcher and a search across every tab.
- **Shell integration**: OSC parsing and integration scripts for PowerShell, bash, zsh and cmd for
  live folder, branch, last command and tab title; command marks; system notifications for
  finished commands in background tabs.
- **Project actions**: an `actions.json` in a project lists commands that run from the interface;
  `noren://` links open a folder in Noren (the installer registers the scheme).
- **Customization**: a commented `config.jsonc` with hot reload and a published JSON schema;
  a settings screen (appearance, shortcuts, notifications, terminal, profiles, auto-archive, AI);
  eight built-in themes, a theme per space, and import of color schemes and shell profiles from
  other terminals; user CSS mods; window material (Mica on Windows) and background images; fonts
  and terminal options.
- **Session life**: restore of tabs with scrollback after a restart, reopen closed tabs, auto-archive
  with a library that searches inside terminal content, peek at a tab without opening it, and a
  quick terminal window with a global shortcut that can be promoted to a normal tab.
- **Optional AI, local by default**: pluggable providers with keys kept in the system keychain,
  a preview of exactly what is sent (secrets redacted) before anything leaves the machine, an Ask
  panel, and explain-error and explain-command. Nothing runs without a user action.
- **Accessibility and languages**: the sidebar is an ARIA tree driven by the keyboard, visible
  focus rings, reduced motion, and no serious axe-core violation on the main screens; the interface
  speaks English and Brazilian Portuguese and follows the system language.

### Security

- Strict content security policy (no eval, no remote content), minimal Tauri capabilities per
  window, links open only as http(s) after a confirmation, and file names from mods, themes and
  backgrounds are checked against path escapes. See `docs/SECURITY_REVIEW.md`.

[Unreleased]: https://github.com/marllon/noren/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/marllon/noren/releases/tag/v0.1.0
