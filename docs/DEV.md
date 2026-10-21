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

## Testing the SSH transport (Docker)

```sh
pnpm test:ssh
```

`pnpm verify` needs neither Docker nor `ssh`: the tests that talk to a real OpenSSH server are
`#[ignore]`. `pnpm test:ssh` (`scripts/test-ssh.mjs`) runs them: the transport of the core
(`crates/noren-core/tests/ssh_docker.rs`) and then a tab of an SSH profile of the app, through the same
calls the page makes (`apps/desktop/src-tauri/src/remote_docker.rs`: the profile, the folder and
environment of this machine kept out, the `ssh` process killed and the same shell answering, nothing
shown twice). Docker must be running; the `ssh` it uses is the one of the system (on Windows the OpenSSH of
`System32`), run without a window. The script builds an image from `scripts/ssh-test/Dockerfile` (a
Debian machine with sshd and a `norend` compiled for Linux from this workspace; the first build
downloads the base images, the Debian package of sshd and the Rust crates, so it needs the network,
and takes a minute or two on a fast machine), makes throwaway keys and known hosts files in a
temporary folder (nothing is written to `~/.ssh`), starts the container with its ssh port published
on `127.0.0.1` only, runs the ignored tests (a session is created, written to, read, the `ssh` process
is killed, the client reconnects and the same session, same id and same pid, answers; refused keys,
changed host keys and a missing `norend` are told apart; and the same through a profile) and then removes the container and its
volumes, every image of the run, the base images it had to pull (only those that were not on the
machine before) and the folder. It ends by checking that `docker ps -a` and `docker images` show
nothing of the run; exit code 0 means the test passed and nothing was left. `--keep-base-images` keeps
the pulled base images (for repeated runs while developing); `--sweep` removes what a run that was
killed hard left behind (every object carries the label `noren-ssh-test`). `node --test
scripts/test-ssh-lib.test.mjs` tests the pure part of the script. See
[DAEMON.md](DAEMON.md#the-remote-bridge-ssh).

## Building installers (Windows)

```sh
pnpm desktop:build
```

`scripts/desktop-build.mjs` builds the session daemon (`cargo build -p norend --release`), copies it to `apps/desktop/src-tauri/binaries/` (ignored by git) under the name Tauri looks for (`norend-<target triple>.exe`), and runs `tauri build` in release mode with the extra configuration `apps/desktop/src-tauri/tauri.bundle.conf.json`, which carries `norend` in the installers next to `noren` and names the hooks that stop a running one before the files are replaced. That file is separate from `tauri.conf.json` on purpose: the build script of Tauri requires the copy of `norend` for every build of the app, and `cargo build`, `clippy`, `test`, `pnpm verify` and `pnpm smoke` must not. Arguments after the command go to `tauri build` (`pnpm desktop:build --bundles msi`). It produces two installers on Windows, an NSIS `.exe` and an MSI (see [DAEMON.md](DAEMON.md#in-the-installers)).
The first run compiles the release profile (a few minutes); the Tauri bundler downloads NSIS and
one plugin DLL for the `.exe`, and the WiX 3 binaries for the `.msi`, from GitHub on first use;
later runs reuse them. The targets per platform are set in `bundle.targets`: `nsis` and `msi` in
`apps/desktop/src-tauri/tauri.windows.conf.json`, `appimage` and `deb` in `tauri.conf.json` (used
on Linux). There is no macOS target yet.

The installers are written under the Cargo target directory (`target/` at the repository root
unless `CARGO_TARGET_DIR` says otherwise), which is ignored by git; never commit them:

| Installer | Path                                                   | Size (0.1.0) |
| --------- | ------------------------------------------------------ | ------------ |
| NSIS      | `target/release/bundle/nsis/Noren_0.1.0_x64-setup.exe` | 3.57 MiB     |
| MSI       | `target/release/bundle/msi/Noren_0.1.0_x64_en-US.msi`  | 5.34 MiB     |

To see that `norend.exe` is in an installer without installing anything: `msiexec /a <the .msi> /qn TARGETDIR=<an absolute path of an empty folder>` unpacks the MSI (no registry, no shortcuts, the custom actions do not run) and `PFiles\Noren` holds `noren.exe` and `norend.exe` side by side; for the NSIS installer, `target/release/nsis/x64/installer.nsi` is the script it was built from (it lists `norend.exe` among the files and includes `installer/hooks.nsh`). `node --test scripts/desktop-build-lib.test.mjs` tests the small pure part of `scripts/desktop-build.mjs`.

The version is `0.1.0` and must stay in step in `package.json`, `apps/desktop/package.json`,
`packages/model/package.json`, `tauri.conf.json`, the workspace `Cargo.toml` and `Cargo.lock`. It
must be a plain `major.minor.patch`: the MSI format rejects pre-release suffixes such as `-dev`.
The builds are not signed, so Windows SmartScreen may warn on first run.

Install (NSIS): run the `.exe` (per-user, no administrator rights), or
`Noren_0.1.0_x64-setup.exe /S` for a silent install. The app goes to `%LOCALAPPDATA%\Noren` and appears in Start and in
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
fallback with its reason; a system that cannot paint it still passes. It then opens a browser pane
on a page served by the run itself on `127.0.0.1` (a free port, the standard library only) and
prints `SMOKE browser pane loaded <url>` once the web view reports the load, still with the window
hidden. It also takes that web view to no area and back, which is how the interface hides a pane
that is out of view, and checks that the view keeps its page (`SMOKE browser pane hidden at no area
and shown again`; see [ARCHITECTURE.md](ARCHITECTURE.md#the-browser-pane)). `pnpm smoke` also runs
`noren --smoke-quick` (the quick terminal) and `noren --smoke-window`, which makes a second window,
hidden like every window of a smoke run, and moves a running shell to it with the same session id
and the same process; both keep their state in a temp folder (see
[ARCHITECTURE.md](ARCHITECTURE.md#windows)).

Both paths were checked on disk: the WebView folder after an install, and `state.json` after a
release build saved a state (the folder does not exist until the first save). Deleting both folders
resets the app to a fresh install.

## Release workflow

`.github/workflows/release.yml` starts only when a maintainer pushes a tag `v*` (for example
`v0.1.0`); it has no other trigger. It runs on the self-hosted runner (`[self-hosted, linux, noren]`,
the only runner of this repository) and uses no sudo or apt: the toolchain, the Tauri system
libraries and the GitHub CLI (`gh`) are expected on the machine. There is no Windows or macOS job.

Steps of the single `linux` job:

1. Check that the tag is `v` plus the `version` in `tauri.conf.json`, so a tag cannot ship
   artifacts with another version in their names.
2. `pnpm install --frozen-lockfile`, then `pnpm desktop:build`, which builds the AppImage and the
   deb (`bundle.targets` in `tauri.conf.json`). The Tauri bundler downloads its AppImage tooling
   from GitHub on first use, so the runner needs outbound network for that.
3. `gh release create <tag> --draft` with both files attached. The release is always a draft:
   nothing is public until a maintainer reviews it and publishes it by hand on GitHub.

Cutting a release, in order:

1. Bump the version everywhere (see above) and move the `[Unreleased]` notes of `CHANGELOG.md` under
   the new version.
2. Run `pnpm verify`, `pnpm e2e` and `pnpm desktop:build` on the Windows machine; the NSIS and MSI
   installers come from this last step.
3. Push the tag. When the workflow finishes, open the draft release on GitHub, add the two Windows
   installers by hand, and publish.
4. Optionally make the winget, Scoop and AUR manifests from those same files with
   `pnpm packages:generate --deb <the deb>` and submit them by hand; see [PACKAGES.md](PACKAGES.md).
   The generator writes under `target/packages/<version>/` and submits nothing.

`pnpm workflows:check` validates every file in `.github/workflows` (YAML syntax, the runner label
`[self-hosted, linux, noren]` on every job, no sudo, apt or hosted runner label, the tag and draft
contract of `release.yml`, and that `pages.yml` starts only by `workflow_dispatch`).

## Web demo

`pnpm demo:build` builds a static copy of the interface into `dist-demo/` (gitignored), with
relative asset paths so it can be served from a sub-path. It is the web mode of the app (the same
`WebBackend` the e2e tests use, with a simulated shell: `echo`, `pwd`, `ls`, `cd`, `seq` and a few
more) with a strip that says the shell is simulated and gives the download address. On a first visit
(nothing saved in the browser) it opens on a script: three spaces with a theme each, a group, a
pinned tab and a tab split in two panes (`apps/desktop/src/demo/demo-script.ts`); a visitor who
comes back finds their own changes. Nothing in the demo reaches the network.

The demo code is selected by the build mode, not by the environment: `vite build --mode demo`
defines `import.meta.env.VITE_NOREN_DEMO` as `"1"` (`apps/desktop/vite.config.ts`), and the normal
build, which the e2e tests run on, drops that code. `pnpm e2e:demo` builds the demo and runs
`e2e/demo/*.demo.ts` with `e2e/playwright.demo.config.ts`, which serves `dist-demo/` with
`vite preview` on port 4781 (`NOREN_DEMO_PORT` changes it; `pnpm e2e` uses 4791).

`.github/workflows/pages.yml` builds the demo and deploys it with the official Pages actions. It
has no trigger but `workflow_dispatch`, so it never runs by itself, and GitHub Pages must be turned
on by hand in the repository settings before the first run.

## Security audits

Run them before a release and whenever a dependency changes; the results of the last review are in [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

- `pnpm audit --prod`: known vulnerabilities in the production npm dependencies.
- `cargo install cargo-audit --locked` once, then `cargo audit`: known vulnerabilities and unmaintained or unsound crates in `Cargo.lock`.
- `pnpm licenses:check`: licenses of the dependencies of both kinds.

## Game mode

While a game is open, a Windows watcher on the maintainer's machine keeps the file
`D:/Projetos/.modo-jogo` fresh. `scripts/game-mode.mjs` is the only reader of it: the signal is valid
if the file exists and was modified less than 60 s ago. The path can be changed with
`NOREN_MODO_JOGO_ARQUIVO` (the tests use a temporary file).

When the signal is valid as a command starts, Vitest uses at most 8 workers, Playwright 4 (both
configs) and cargo gets `CARGO_BUILD_JOBS=8` (`rust:check`, `licenses:check`, `desktop:build` and the
builds of `pnpm smoke`, through `scripts/game-run.mjs`, which starts the command without a shell). A
line such as `game mode: CARGO_BUILD_JOBS=8` goes to stderr. Without the signal nothing changes, and
CI never has the file.
