# r/windows

> **Draft. Not posted.** Nothing here has been published. The repository is private and has no release yet, so every link is the placeholder `<REPO_URL>`; replace it, and re-check each claim against the README, before posting.

Check the subreddit rules first: many such communities restrict self-promotion or require a specific flair or thread. If the rules do not allow it, do not post.

## Title

A terminal for Windows with spaces, groups and pinned tabs, built on Tauri (pre-alpha, feedback wanted)

## Body

Noren is a terminal app I am building with Windows as the first-class platform. It installs with an NSIS installer or an MSI, and it detects the shells on your machine (Windows PowerShell, PowerShell 7, cmd and others).

What is different: tabs are organized like in a browser. Spaces with their own theme, groups, pinned tabs, favorites, splits by dragging a tab, and a command palette that finds any tab.

- Built on Tauri 2 and the system WebView2, not a bundled browser engine.
- Eight built-in themes, a theme per space, and import of color schemes from other terminals.
- Interface in English and Brazilian Portuguese.
- No account and no telemetry; optional AI is off until you set it up.

Honest caveats: it is pre-alpha, the installers are not code-signed yet, so SmartScreen may warn on first run, and sessions end when you close the app.

Repository: `<REPO_URL>`. If you try it, I most want to hear about shells or setups where it misbehaves.
