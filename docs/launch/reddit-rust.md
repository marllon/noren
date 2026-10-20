# r/rust

> **Draft. Not posted.** Nothing here has been published. The repository is private and has no release yet, so every link is the placeholder `<REPO_URL>`; replace it, and re-check each claim against the README, before posting.

Check the subreddit rules and the current showcase conventions before posting.

## Title

Noren: a Tauri 2 terminal with a Tauri-free Rust core (portable-pty, config, persistence, git)

## Body

Noren is a terminal organized like a browser (spaces, groups, pinned tabs, splits, command palette). The part that may interest this subreddit is the structure.

- `crates/noren-core` is a library with no Tauri dependency: PTY sessions on `portable-pty`, shell profiles, config, persistence, git, scrollback, the AI provider layer and the keychain vault. The Tauri app in `apps/desktop/src-tauri` is a thin shell over it.
- The interface is React 19 with strict TypeScript, and xterm.js with WebGL for rendering. Pure TypeScript logic lives in a separate package with no DOM and no Tauri, so most behavior is tested without a window.
- Tests: `cargo test --workspace`, Vitest with fast-check, and Playwright against a fake backend. `cargo clippy -- -D warnings` and `cargo fmt --check` are part of one `pnpm verify` command.
- A license check runs over dependencies, and the Tauri capabilities are declared per window with a strict CSP; the review is in `docs/SECURITY_REVIEW.md`.

Pre-alpha, Windows first, MIT licensed. Repository: `<REPO_URL>`.

Questions I would like opinions on: keeping the core free of the runtime, and the plan to move sessions into a separate daemon process (`norend`) behind a local socket.
