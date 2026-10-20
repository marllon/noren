# Show HN

> **Draft. Not posted.** Nothing here has been published. The repository is private and has no release yet, so every link is the placeholder `<REPO_URL>`; replace it, and re-check each claim against the README, before posting.

## Title

Show HN: Noren, a terminal organized like a browser (spaces, groups, pinned tabs, splits)

## URL

`<REPO_URL>`

## First comment

Hi HN. Noren is a desktop terminal that borrows the organization of a modern browser: spaces, groups, pinned tabs, splits you create by dragging a tab, a command palette and custom themes. It is pre-alpha and Windows comes first; Linux builds exist and macOS is not decided.

Why I built it: a terminal session grows into dozens of tabs (servers, builds, a scratch shell, one repository per project), and a flat row of tabs stops helping long before the work does.

What it does today:

- A space is a workspace with its own tabs, icon, color, theme, background and git identity.
- The sidebar is a tree of groups and tabs, with folder, git branch, last command and its exit code on a second line.
- Drag a tab onto the edge of a pane to split. A split is an item like any other: you can pin, group and restore it.
- One palette (Ctrl+Shift+P) for tabs of every space, actions, profiles, folders and themes.
- The default shortcut preset does not fight the shell: Ctrl+T, Ctrl+W and Ctrl+1..9 stay with the terminal.
- Optional AI, off until you configure a provider. Keys go to the system keychain, you see exactly what will be sent (secrets replaced by markers), and Noren never runs a command an AI suggested: you press Enter.
- No account and no telemetry.

Technical notes: Tauri 2 with a Rust core (portable-pty for sessions), React and strict TypeScript, xterm.js with WebGL for rendering. Not Electron. MIT licensed.

Limits you should know about: sessions end when the app closes (a background daemon is on the roadmap), builds are not code-signed yet, and there is a web demo with a simulated shell if you want to look without installing.

I would like feedback on the organization model above all: do spaces and groups map to how you work, or do they get in the way?

## Notes for the day

- Link the web demo only after it is deployed. If it is not, drop that sentence.
- Numbers on speed or memory: quote only what `docs/PERF.md` says, with its machine, or leave them out.
