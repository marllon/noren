# r/commandline

> **Draft. Not posted.** Nothing here has been published. The repository is private and has no release yet, so every link is the placeholder `<REPO_URL>`; replace it, and re-check each claim against the README, before posting.

Check the subreddit rules on self-promotion and flair before posting.

## Title

I built a terminal app that organizes tabs like a browser: spaces, groups, pinned tabs, drag-to-split

## Body

I kept ending up with thirty tabs open and no way to find anything, so I made Noren: a desktop terminal with spaces (a workspace with its own tabs, theme and git identity), groups, pinned tabs and favorites, and splits you make by dragging a tab onto a pane.

Things that matter to people who live in a shell:

- It does not take your keys. The default preset leaves Ctrl+T, Ctrl+W and Ctrl+1..9 to the terminal; a browser-style preset is opt-in. Every action can be rebound.
- Shell integration for PowerShell, bash, zsh and cmd gives live folder, git branch, last command and exit code in the sidebar, plus notifications for commands that finish in a background tab.
- One palette for tabs of every space, actions, shell profiles and recent folders.
- Config is a commented `config.jsonc` with hot reload and a published schema.
- Optional AI that is off by default, shows what it will send, and never runs a command on its own.
- No account, no telemetry. MIT.

It is not a multiplexer: sessions end when the app closes today. A background daemon is planned.

Pre-alpha, Windows first. Repository: `<REPO_URL>`. What would you want from a terminal that is organized this way?
