# Roadmap

This is the public plan for Noren, one summary per version. It lists intent, not dates or promises: the order can change as people use the app and tell us what matters. Noren is pre-alpha and there is no published release yet.

## v0.1: the first MVP

A terminal organized like a modern browser, Windows first.

- Real PTY sessions rendered with xterm.js (WebGL), shell profiles detected on the machine.
- Spaces (each with its own icon, color, theme and background), groups, pinned tabs and favorites.
- A sidebar tree with live metadata (folder, git branch, last command) and unread marks, or tabs on top.
- Splits inside any tab, by shortcut or by dragging a tab onto a pane.
- A command palette, a shortcut registry with a screen to rebind keys, and a recent-tab switcher.
- Shell integration for PowerShell, bash, zsh and cmd, notifications for finished commands.
- A commented `config.jsonc` with hot reload, eight built-in themes, user CSS mods.
- Session restore with scrollback, reopen closed tabs, a library with search inside terminal content, a quick terminal window.
- Optional AI, local by default: pluggable providers, keys in the system keychain, a preview of exactly what is sent, and nothing runs without a user action.
- Interface in English and Brazilian Portuguese; installers for Windows (NSIS and MSI) and Linux (AppImage and deb); a web demo.

Left for the launch itself: publishing the first release and the demo site.

## v0.2: agents

Command-line coding agents are becoming part of daily terminal work, so Noren learns to see them.

- Detect which agent runs in a tab, from the command line and the process tree, with an editable catalog.
- Show whether an agent is working, waiting for you or idle, with a color ring on the pane and a badge in the sidebar.
- An Agents view across all spaces, with a shortcut to the first one waiting for you.
- A "new worktree" action that creates a git worktree next to the repository and opens a tab in it.

## v0.3: persistent sessions

- A background daemon (`norend`) that owns the sessions, so closing the window does not end them and reopening reattaches.
- Layout and sessions restored after a machine restart, and agents resumed only if you turn that on.
- A remote profile that runs the daemon on a Linux machine through an SSH tunnel, with automatic reconnection.

## v0.4: panes beyond the terminal

- A browser pane inside a split, opened from a URL in the output.
- File previews (Markdown, images, text, JSON) in a pane or in a peek.
- A diff pane for the working directory, side by side.
- Several windows that share the same spaces.

## v0.5: an open benchmark for local models

- A public suite of 60 tasks (write a command, explain an error, summarize output) with automatic checks.
- A runner that measures accuracy, latency, speed and memory against local model servers.
- A screen with a scoreboard per model, a recommendation for the machine, and guided installation of recommended models.

## v0.6: automation

- A local socket API to create and list spaces, tabs and splits, send text and keys, read buffers and listen for events, protected by a local token.
- A `noren` command-line tool on top of that API, and a guide that teaches AI agents to use it.
- Routing rules in the config (by folder or command) and live groups fed by worktrees, SSH hosts and running containers.

## v0.7: extensions

- Sandboxed JavaScript plugins with a permission manifest and a versioned API.
- A gallery of themes and mods with hash checks, installable from the settings screen.
- Export and import of a space as a file, without secrets.

## v0.8: sync

- Sync of config, themes, mods and spaces through a git repository you own, or through a gist. Scrollback and keys are never synced.

## v1.0: polish

- A screen reader mode and a full accessibility review.
- Automatic updates with signature verification.
- Manifests for Windows and Linux package managers.
- Tighter performance goals (first prompt under 500 ms, 100 tabs under 800 MB) and an evaluation of a native renderer.

macOS support is not decided yet: Windows and Linux are the targets today.

## How to take part

Read [CONTRIBUTING.md](../CONTRIBUTING.md). The design of the app is in [ARCHITECTURE.md](ARCHITECTURE.md).
