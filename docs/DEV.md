# Development setup

This guide gets a contributor from a clean machine to a green `pnpm verify`.

## Tested environment

Versions found on the reference machine (Windows 11, Git Bash) when this guide was written:

| Tool     | Version                                  | Minimum / note                                      |
| -------- | ---------------------------------------- | --------------------------------------------------- |
| Node.js  | 24.2.0                                   | >= 24 (`engines.node` in `package.json`)            |
| corepack | 0.33.0                                   | ships with Node; manages pnpm                       |
| pnpm     | 10.28.2                                  | pinned by `packageManager` in `package.json`        |
| git      | 2.55.0.windows.3                         | any recent version                                  |
| rustc    | 1.99.1 (58cf8f9c3 2026-10-13)            | stable; host `x86_64-pc-windows-msvc` on Windows    |
| cargo    | 1.99.1 (5f94df478 2026-08-27)            | ships with rustc                                    |
| MSVC     | linker found; a temporary crate built OK | VS 2022 Build Tools, "Desktop development with C++" |

Environment check performed: `cargo new` in a temporary folder outside the repository followed by
`cargo build` succeeded (the MSVC linker works), and the folder was deleted afterwards.

The Playwright Chromium browser is not installed yet. It is installed in NOR-F1-05, when the
`e2e/` project exists: `pnpm exec playwright install chromium`.

## Windows

1. Install Node.js 24 or newer (for example `winget install --id OpenJS.NodeJS -e`).
2. Enable corepack so the pinned pnpm is used: `corepack enable`.
3. Install git (`winget install --id Git.Git -e`).
4. Install Rust with the MSVC toolchain: `winget install --id Rustlang.Rustup -e`, then open a new
   terminal and run `rustup default stable`. Confirm with `rustc -vV` that the host is
   `x86_64-pc-windows-msvc`.
5. Install Visual Studio 2022 Build Tools with the "Desktop development with C++" workload
   (`winget install --id Microsoft.VisualStudio.2022.BuildTools -e`, then add the workload in the
   installer). WebView2 ships with Windows 11; on Windows 10 install the Evergreen runtime.

## macOS

1. Install the Xcode command line tools: `xcode-select --install`.
2. Install Node.js 24 or newer (for example `brew install node@24`), then `corepack enable`.
3. Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then
   `rustup default stable`.

## Linux (Debian / Ubuntu)

1. Install the Tauri 2 system dependencies:

   ```sh
   sudo apt update
   sudo apt install -y build-essential curl wget file libxdo-dev libssl-dev \
     libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
   ```

2. Install Node.js 24 or newer (for example from NodeSource or with `nvm`), then
   `corepack enable`.
3. Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then
   `rustup default stable`.

## Working on the repository

```sh
corepack enable
pnpm install
pnpm verify
```

`pnpm verify` runs, in order: `pnpm typecheck`, `pnpm lint` (ESLint), `pnpm format:check`
(Prettier) and `pnpm test` (Vitest). Later tasks add the Rust checks to it.

Other scripts: `pnpm format` rewrites files with Prettier; `pnpm lint` and `pnpm typecheck` can be
run alone; `pnpm --filter @noren/model config:schema` regenerates `docs/config.schema.json` after the settings schema in
`packages/model/src/config.ts` changes (a test fails until you do).

Tips:

- Vitest does not type-check. Always run `pnpm typecheck` as well (`pnpm verify` does).
- After adding imports, run `pnpm exec eslint --fix .` and then `pnpm format`.
- Never run a dev server as part of an automated step; tests that need a server start and stop it
  themselves.

## Daily-use build (Windows)

```sh
pnpm desktop:build
```

This runs `tauri build` in release mode and produces one NSIS installer. The first run compiles
the release profile (a few minutes) and the Tauri bundler downloads NSIS and one plugin DLL from
GitHub; later runs reuse them. The target is set for Windows only in
`apps/desktop/src-tauri/tauri.windows.conf.json` (no MSI).

The installer is written to `target/release/bundle/nsis/Noren_0.0.1-dev_x64-setup.exe` (about
2.1 MiB). `target/` is ignored by git; never commit it. The version is `0.0.1-dev`
(`package.json`, `apps/desktop/package.json`, `tauri.conf.json` and the workspace `Cargo.toml`
must stay in step). The build is not signed, so Windows SmartScreen may warn on first run.

Install: run the `.exe` (per-user, no administrator rights), or `Noren_0.0.1-dev_x64-setup.exe /S`
for a silent install. The app goes to `%LOCALAPPDATA%\Noren` and appears in Start and in
Settings > Apps.

Uninstall: Settings > Apps > Noren, or `%LOCALAPPDATA%\Noren\uninstall.exe` (`/S` for silent).
The interactive uninstaller offers to delete the app data; the silent one keeps it.

Where data lives (identifier `io.github.marllon.noren`):

| What                                                                                      | Where                                               |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Workspace state (`state.json`: spaces, groups, tabs, layout), created on the first save   | `%APPDATA%\io.github.marllon.noren\`                |
| Interface preferences (theme, layout, pane headers), kept in the WebView's `localStorage` | `%LOCALAPPDATA%\io.github.marllon.noren\EBWebView\` |

`noren://` links: the installer registers the scheme for the current user (`Software\Classes\noren`)
and the uninstaller removes it; a debug or `target/` build registers nothing (see
[DEEP_LINKS.md](DEEP_LINKS.md)). `pnpm smoke` runs `noren --smoke` and then
`noren --smoke-deeplink <link>`, both with a hidden window; the second keeps its state in a temp
folder, never in the real `state.json`. The first also gives the hidden window Mica (vibrancy on
macOS) and prints what the system answered, `SMOKE window effect mica applied` or the opaque
fallback with its reason; a system that cannot paint it still passes.

Both paths were checked on disk: the WebView folder after an install, and `state.json` after a
release build saved a state (the folder does not exist until the first save). Deleting both folders
resets the app to a fresh install.

## Security audits

Run them before a release and whenever a dependency changes; the results of the last review are in [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

- `pnpm audit --prod`: known vulnerabilities in the production npm dependencies.
- `cargo install cargo-audit --locked` once, then `cargo audit`: known vulnerabilities and unmaintained or unsound crates in `Cargo.lock`.
- `pnpm licenses:check`: licenses of the dependencies of both kinds.
