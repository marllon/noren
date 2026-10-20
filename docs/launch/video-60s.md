# 60-second video script

> **Draft. Not posted.** Nothing here has been published. The repository is private and has no release yet, so every link is the placeholder `<REPO_URL>`; replace it, and re-check each claim against the README, before posting.

A screen recording of about 60 seconds, with captions or a voice-over. Footage comes from the web demo, where the shell is simulated, so say so in the description. The stills named below are in `docs/media/`; `pnpm media` rewrites them and `noren-demo.webm` from one script, so the scenes can be re-recorded. Do not add numbers (speed, memory, stars, users) that are not in `docs/PERF.md`.

| Time      | Scene (reference)                               | On screen                                                                   | Caption or voice-over                                                              |
| --------- | ----------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 0:00-0:06 | `01-overview.png`                               | The whole window: sidebar with spaces, groups and tabs, a tab split in two. | "Terminals grow into dozens of tabs. Noren organizes them like a browser."         |
| 0:06-0:16 | `02-space-docs.png`, `03-space-lab.png`         | Click the second space in the bar at the bottom; the whole window changes.  | "Spaces. Each has its own tabs, theme and color. Ctrl+Alt+1 to 9 to switch."       |
| 0:16-0:26 | `04-drag-to-split.png`, `05-split.png`          | Drag a tab from the sidebar to the right edge of a pane; the split appears. | "Drag a tab onto a pane to split it. A split is a normal item: pin it, group it."  |
| 0:26-0:36 | `06-palette.png`                                | Press Ctrl+Shift+P, type a few letters; the list narrows, shortcuts show.   | "One palette for tabs, actions, profiles, folders and themes."                     |
| 0:36-0:44 | `07-theme-preview.png`, `08-theme-switched.png` | Arrow down the themes: the window previews each. Press Enter on one.        | "Preview a theme on the whole window before you pick it."                          |
| 0:44-0:54 | `09-ask-preview.png`, `10-ask-answer.png`       | Open Ask (Ctrl+Shift+A), show the preview of what is sent, then the answer. | "Optional AI. You see what is sent, and it never runs a command: you press Enter." |
| 0:54-1:00 | `01-overview.png`                               | Back to the full window, then a title card with the repository link.        | "Noren. Pre-alpha, Windows first, MIT. <REPO_URL>"                                 |

## Notes

- Keep it under 60 seconds: cut the theme scene first if it runs long.
- Add a line in the video description: "Recorded on the web demo; the shell is simulated."
