# Security review (NOR-F11-03)

Scope: the desktop app (`apps/desktop`), `crates/noren-core`, `packages/model` and the dependency trees, at the commit that adds this file. The reporting policy is in [SECURITY.md](../SECURITY.md); how the pieces fit is in [ARCHITECTURE.md](ARCHITECTURE.md#security).

**Threat model.** The page draws text that other programs wrote (terminal output, an AI answer, a CSS mod, a settings file, a `noren://` link). Anything in it can be hostile. The review asks, for each way that text could reach the machine, what stops it and where that is proved. Code that runs in the Rust process is trusted; the page is not trusted further than it needs to be.

**Result.** Seven items checked, five needed a change (all done), two were already sound. No known vulnerability in the production dependencies. Three low findings are open (148 to 150) and one older finding is closed (92).

| #   | Item                                    | Result                                                                       |
| --- | --------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Content Security Policy                 | was `null`; now strict, tested against the web build and the real app boot   |
| 2   | Tauri capabilities per window           | was `core:default` everywhere and every command open; now minimal per window |
| 3   | Opening links                           | was the library default (`window.open`, no question); now asks, http(s) only |
| 4   | Navigation of the web views             | no guard; now refuses anything that is not an app page                       |
| 5   | Path validation: mods, themes, etc.     | sound, with one gap fixed (device names as theme ids); tests added           |
| 6   | Import (profiles, color schemes, links) | sound; data only, preview before writing                                     |
| 7   | `pnpm audit --prod` and `cargo audit`   | 0 vulnerabilities; 8 Linux-only transitive warnings documented (finding 149) |

## 1. Content Security Policy

**Checked.** `tauri.conf.json` had `"csp": null` (no policy at all). What the page really needs was measured, not guessed: scripts and the stylesheet come from the app itself (`index.html:10` is the only script, a module with a `src`), the picture behind the window is a `blob:` address made from bytes held in memory (`background-image-store.ts:85`), the only network the page talks to is the IPC, there are no web fonts (the fonts are the system's), no workers, no frames, no media (the bell is a Web Audio oscillator, `bell.ts`).

**Policy** (`tauri.conf.json:24-40`):

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' blob:; font-src 'self'; connect-src ipc: http://ipc.localhost;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none';
worker-src 'none'; media-src 'none'; manifest-src 'none'
```

- No `unsafe-eval`, no `wasm-unsafe-eval`, no `unsafe-inline` for scripts, no wildcard, no `http(s):` host, no `data:`.
- **`style-src 'unsafe-inline'` is the one relaxation, and it is needed.** xterm.js 6 puts a `<style>` element inside every terminal (the colors of its scrollbar) and has no nonce option; every mod is a `<style>` element (`mod-styles.ts:30`). Proved by `e2e/csp.spec.ts:201`: without it the page raises `style-src-elem` violations on a plain start. Tauri adds nonces or hashes to `style-src` only for inline styles that exist in the HTML at build time (Tauri 2.12.4 `src/manager/mod.rs:79-100`), and there are none, so the keyword is not cancelled. What the relaxation allows is styling, not code, and the same policy stops a style from loading anything: `img-src`, `font-src` and `connect-src` do not name any remote host (test below). Finding 150 tracks removing it.
- **Zod** compiled parsers with `new Function` after probing for it, which the policy would report as a violation on every start. The probe is turned off with `z.config({ jitless: true })`, evaluated before any schema (`packages/model/src/zod-config.ts:9`, imported first at `index.ts:1`). Found by the e2e below: the first run under the policy reported `script-src eval`.

**Evidence.**

- `apps/desktop/src-tauri/src/capabilities.rs:180` (`the_content_security_policy_is_strict`) reads `tauri.conf.json` and fails on `unsafe-eval`, a wildcard, `data:`, `https:`, `unsafe-inline` outside `style-src`, or a loosened directive.
- `e2e/csp.spec.ts` serves the web build with the policy read from that same file: the app (terminal, palette, settings, a mod, a background picture) raises no violation (`:79`); what a mod tries to load (`@import`, `background-image`, `@font-face`, `cursor`) from `https://evil.example` is blocked by `img-src` and `font-src` and no request leaves the page (`:129`); a script element, an inline script, an iframe and a `fetch` from outside are refused (`:174`).
- `pnpm smoke` boots the real app (hidden window) with the policy: `app-ready`, the IPC round trips, the quick window and the deep link all work.

**Result.** Done. **Not verified (D19):** violations inside the real WebView2 window (the web build is the same page on Chromium, the engine is not the same), and whether the IPC uses the fast `http://ipc.localhost` path or Tauri's `postMessage` fallback (both work; `tauri.conf.json:30` follows the Tauri documentation for the Windows and the `ipc:` scheme for macOS and Linux). Nothing was opened to check it.

## 2. Tauri capabilities per window

**Checked.** Both windows had `core:default` (about thirty read permissions of the app, event, image, menu, path, resource, tray, webview and window sets). Worse, while a project defines no app manifest, **every window may call every app command**: the quick window, which only draws a terminal, could call `config_save`, `ai_set_key` or `project_command_run` (Tauri 2.12.4, `src/webview/mod.rs`, the check on `has_app_acl_manifest`: the ACL is applied to app commands only when the app declares them).

**Changes.**

- `build.rs:6-55` declares all 43 commands with `AppManifest`, so each gets a permission `allow-<command>` and a window may call only the ones its capability names. `main.rs:116-160` (`generate_handler!`) and the list are kept equal by `capabilities.rs:65`.
- `capabilities/default.json` (main window): the 43 command permissions and ten `core` ones: `event:allow-listen/unlisten/emit` (the page listens to and sends events), `path:allow-resolve-directory` (the home folder, `home.ts:11`), `window:allow-is-maximized/minimize/toggle-maximize/close/start-dragging` (the title bar, `TitleBar.tsx:23-70`) and `window:allow-internal-toggle-maximize` (the double click on the drag region, called by Tauri's own script, Tauri 2.12.4 `src/window/scripts/drag.js:103`). No `core:default`, no webview, menu, tray, image, resource or app permission.
- `capabilities/quick.json` (quick window): `session_create/write/resize/kill` (one shell), `link_open` (a confirmed link), the three event permissions and `window:allow-hide`. Nothing else: no settings, state, scrollback, AI, notification, profile or project command.
- The plugins used from Rust (notification, global shortcut, deep link, single instance) get no permission, so the page cannot call their commands (`main.rs:70-90`).
- `capabilities/window.json` (the windows besides the main one, `window-*`, NOR-F15-04a): `session_attach/write/resize` (the output of a session moved to the window, typing and resizing) and the three event permissions. Nothing of the state, the settings, the files, the AI, starting or ending a shell, or making a window: the main window owns the workspace and is the only one that writes `state.json`. The commands of the state and of the windows also refuse any label but `main` themselves (`windows::require_owner`), in case a capability is ever widened by mistake.
- No capability has `remote` or `webviews`, the one pattern in any of them is `window-*` (the label of the windows the app makes, which no web view of a pane can have, `capabilities.rs`), and only these three files exist.

**Evidence.** `capabilities.rs:76` (main: every command and exactly those ten core permissions), `:109` (quick: exactly nine permissions: five commands, three event ones and hide), `:132` (no `:default`, no `*`, no `remote`, two files), `security-config.test.ts` (the page imports only `core`, `event`, `path` and `window` of the Tauri API and invokes only commands the build script declares). `tauri-build` rejects a permission that does not exist, so a typo breaks the build. `pnpm smoke` runs a shell in the quick window and promotes it to the main window, both through the new permissions.

**Result.** Done. **Not verified (D19):** the title bar buttons, the double-click maximize and `homeDir` need a visible window (`TitleBar.tsx:23-70`, `home.ts:11`); their permissions come from the Tauri sources named above. Tauri's other injected scripts (`print`, devtools toggle, zoom hotkeys) are off in this app and are not granted.

## 3. Opening links

**Checked.** The terminal had `new WebLinksAddon()` with the default handler, which calls `window.open` on the first click, and no `linkHandler` for OSC 8 links (a program can declare a link whose visible text differs from its address; the default of xterm.js asks with a bare `confirm` and then calls `window.open`, `OscLinkProvider.ts:115-117`). Nothing else in the page opens an address: no `<a>`, no `window.open`, no `location` assignment (`security-config.test.ts` fails if one appears), and the Markdown of the Ask panel builds no links (`Markdown.tsx:9`, test with `javascript:` at `Markdown.test.tsx:68`).

**Changes.**

- A click on a plain address or on an OSC 8 link does not open anything: it lands in `link-prompt.ts:27` (`requestExternalLink`), which drops everything that is not `http` or `https` and otherwise shows the "Open link" dialog (`LinkPrompt.tsx:10`, in the main window `App.tsx:1888` and in the quick window `QuickApp.tsx:205`) with the address under the question. Hooks: `TerminalView.tsx:290` (`linkHandler`, `allowNonHttpProtocols: false`) and `:314` (the addon).
- A click with Ctrl held (Cmd on a Mac) is the one other way out of those hooks: `activateLink` in `TerminalView.tsx` hands the address to `onOpenLink`, and when the shell takes it (an address `browserUrlProblem` allows) a browser pane opens beside the terminal (NOR-F15-01b; the page of that pane has no command, see [ARCHITECTURE.md](ARCHITECTURE.md#the-browser-pane)). Otherwise it ends in `requestExternalLink` like any click. `security-config.test.ts` holds the shape of `activateLink`: the two hooks use it and nothing else leaves it.
- Only after the person confirms, `Backend.openExternal` calls the command `link_open` (`tauri-backend.ts:427`, `link.rs:18`), which checks the address again on the Rust side (`noren-core/src/link.rs:62`) and hands it to the system browser through `open::that_detached`. The rule: scheme `http` or `https` in any case; no blank, control character or backslash; a host; no user name or password (`https://good.example@evil.example` shows one host and opens another); at most 2048 bytes. The TypeScript copy of the rule (`external-link.ts:27`) is stricter on Unicode blanks only.
- No opener plugin is installed, so the page has no command that opens a file or a program. A new dependency was needed for the system call: `open` 5.4.4, MIT (reason in `Cargo.toml`).

**Evidence.** Rust: `link.rs` (noren-core) 7 tests (schemes `file:`, `javascript:`, `data:`, `noren:`, `ms-msdt:`, `ftp:`, `blob:`, drive paths; blanks, control characters, backslash; no host; user info; size; multibyte head without panic) and `link.rs` (desktop) 3 tests (a refused address never reaches the opener; an opener error is a sentence). Model: `external-link.test.ts` (the same table). E2E `e2e/links.spec.ts`: click asks and shows the address (`:52`), Open opens exactly that address, Cancel and Esc open nothing (`:68`), OSC 8 shows the real address, not the label (`:83`), OSC 8 to `file:`, `javascript:`, `noren:` and `ms-msdt:` is never offered (`:95`), no popup is ever created (`:110`).

**Result.** Done. **Not verified (D19):** the real `open::that_detached` call, which would open a browser (`link.rs:18`); the chain is tested with a stand-in opener.

## 4. Navigation of the web views

**Checked.** Nothing refused a web view that tried to navigate to another address (a link, a form, `location`). With the policy and the page code above this cannot happen today, so this is a second wall.

**Change.** `navigation.rs:14-35`, a plugin registered at `main.rs:75`, allows only `tauri://localhost`, `http(s)://tauri.localhost` and `about:blank`; anything else is refused and logged by scheme. 2 tests (`navigation.rs:45`, `:54`) include look-alike hosts (`tauri.localhost.evil.example`), `file:`, `data:`, `javascript:` and `blob:`.

**Windows (NOR-F15-04a).** The guard names the `window-<id>` labels (`navigation.rs`): they go to the pages of the app only, never to a web page the way the web view of a pane does. `noren --smoke-window` takes the page of a real second window to a web page (an address nobody listens on) and it stays; the same run has that page call thirteen commands that own the workspace and each is refused by the access control.

**Result.** Done. A `window.open` from the page never happens (checked in item 3), so the new-window request has nothing to answer; the main window is created from `tauri.conf.json`, where no new-window handler can be set. **Not verified (D19):** the guard in the real window (the hidden `pnpm smoke` run loads both pages through it).

## 5. Path validation

Every name the page or a file can supply that becomes a path was followed to the disk.

| Input                                            | Rule (Rust, then TypeScript)                                                                                                                                                                      | Result                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Mod file (`mods/<name>.css`)                     | `is_valid_mod_file_name` `mods.rs:90`, `isValidModFileName` `mods.ts:52`: ASCII word + `.css`, 64 chars, no device name; listing reads names from the folder only                                 | sound                                       |
| Theme id (`themes/<id>.json`)                    | `is_valid_theme_id` `themes.rs:77`, `THEME_ID_PATTERN` `theme.ts:18`; `save` checks before any write (`themes.rs:163`)                                                                            | **gap fixed**: `con`, `aux`, `nul` were ids |
| Scrollback id (`scrollback/<id>.txt`)            | `is_valid_pane_id` `scrollback.rs:80`, `file_of` `:117` in every method; `isScrollbackPaneId` `scrollback.ts:80`                                                                                  | sound                                       |
| Background picture                               | `path_problem` `background.rs:107`, `resolve` `:186`, `read` `:207`; `backgroundImageProblem` `background.ts:41`                                                                                  | sound                                       |
| `noren://` folder                                | `pathProblem` `deep-link.ts:43` (absolute, no `..`, no control character); `looks_like_link` `deeplink.rs:24` filters the arguments                                                               | sound                                       |
| `.noren/actions.json`, `git_info` (folder named) | the file name is fixed (`ACTIONS_FILE_PATH`), only read; git is read from the files, never run                                                                                                    | sound                                       |
| `state.json`, `config.jsonc`                     | fixed paths in the app folders, no name from the page                                                                                                                                             | sound                                       |
| File preview (`file_preview_read`)               | `path_refusal` `preview.rs`, `classifyPreviewPath` `file-preview.ts`: a full local path, no network or device path, no control character; regular files only                                      | sound (NOR-F15-02a)                         |
| git diff of a folder (`git_diff_read`)           | `path_refusal` `preview.rs`, `GitCli::diff` `git_diff.rs`: a full local path of a folder, git started with separate arguments, `--no-ext-diff --no-textconv`, `core.fsmonitor=false`, a 2 MiB cap | sound (NOR-F15-03)                          |

- **Gap, confirmed and fixed.** A theme id was any lower-case word, so `con`, `aux`, `nul`, `prn`, `com1` or `lpt1` were valid and `con.json` is the console device on Windows (mods and scrollback already refused device names). `is_valid_theme_id` and `THEME_ID_PATTERN` now refuse them; the JSON Schema of the settings file was regenerated (`docs/config.schema.json`). `con-dark`, `aux2` and `com10` stay valid (only the whole name is a device).
- **Background pictures** are the one place an absolute path outside the config folder is accepted on purpose (a picture can live anywhere). What keeps the rest of the disk closed: no URL scheme, no UNC path, no drive-relative path, no `..` in a relative path, a picture extension, a size limit, and the **content** must be a picture (magic bytes) or nothing is returned (`background.rs:207-232`). The page never receives a path: it gets bytes and makes a `blob:` address.
- **The file preview** (NOR-F15-02a) is the one command that returns the contents of a file whose full path the page names, whatever the file is. What keeps it from being a way to read the disk for a hostile page: it is read-only; the contents go into text nodes and an `<img>` over a `blob:` address, never to the network (the policy has no `connect-src` for it and `img-src` takes `blob:` only); the path has to be a full local path (a network or device path is refused before anything is opened, so a path in the output cannot make the machine reach another one); only regular files are opened (a pipe or a device would wait for ever); text is capped at 1 MiB and pictures at 10 MiB, with one byte read past the cap; and a file with a NUL byte is refused. The page is trusted with the path it asks for as far as it is trusted with the commands it can call at all; there is no scope of folders, as for the background picture, because the point is to preview what a program printed the path of. A path comes from `state.json` or (NOR-F15-02b) from a Ctrl+click of the person on a path in the output: the output is text a program printed, so the click is the person's choice, a hover reads nothing, a click without Ctrl does nothing, the path is resolved and checked by `previewPathProblem` before any pane is made, and the only thing the click can do is open a read-only preview pane (it never hands a path to another program).
- **The git diff** (NOR-F15-03) is the one command that starts a program (`git`) on a folder the page names, and the folder can be a repository somebody else made. What keeps it a read: the folder has to be a full local folder that exists (a network or device path is refused before git is started); `git` gets separate arguments, never a shell, stdin closed, no prompt and no window; the commands are `rev-parse`, `hash-object` and `diff`, none of which writes (the index is not refreshed on disk, and `GIT_OPTIONAL_LOCKS=0` is set); `--no-ext-diff` and `--no-textconv` stop the programs a repository's attributes name, and `core.fsmonitor=false` stops its file-system monitor hook (a test makes a repository name one and checks it does not run); the output is capped at 2 MiB, and at one byte more git is killed; the text goes into text nodes of a table, never into markup. What is not closed: only the settings named above are tried; any other setting of a repository that makes git run a program is not tried one by one, and git runs with no time limit (a hostile or slow repository can keep one read waiting).
- **Mods and themes follow links.** The folder listing uses `fs::metadata`, which follows a symbolic link (`mods.rs:257`, `themes.rs`), so a link in the mods folder to a file elsewhere is read as text. This is kept: people keep dotfiles in repositories and link them in, the folder is theirs, the text goes into a style element or a theme parser, and the policy stops it from leaving the page. Not a finding.
- **A mod cannot leave its layer** (`wrapModCss`, `mods.ts:127`, 240 hostile texts in the e2e of NOR-F8-04) and, with the policy, **cannot load anything remote** (item 1). This closes finding 92.

**Tests added.** `crates/noren-core/tests/path_safety.rs` (9 tests, real temporary folders): 30 hostile stems (`..`, `../x`, `a\b`, `/etc/passwd`, `C:\x`, `C:x`, UNC, NUL and newline, trailing space, `x:stream`, `%2e%2e`, device names) against mods, themes and scrollback, checking the answer and that the folder tree is unchanged (nothing written, created or read outside); background paths that climb or leave the computer; relative background paths staying under the base; an absolute path outside the base returning bytes only for a real picture. The same lists in TypeScript: `packages/model/src/path-safety.test.ts` (166 tests, including `noren://` links with `..`, relative folders and extra parameters). Theme device names in `themes.rs` (1 test).

## 6. Import

- **Shell profiles** (`profile-import.ts`) and **color schemes** (`scheme-import.ts`) read a file the person picked (the `File` object, no path), refuse more than 1 MB (`profile-import.ts:13`, `importers.ts:21`) and at most 200 profiles (`user-profile-schema.ts:21`), and write nothing and start nothing until the person has seen the plan (the program and arguments of each profile) and agreed (`commitProfileImport`, `profile-import.ts:126`, writes `config.jsonc` only). A profile's folder becomes a `cwd` that is used when the person opens it.
- **Settings file, themes, mods and scrollback** are read as data; a scrollback snapshot is cleaned before it is written back to a terminal (`scrollback.rs:1-6`).
- **Result.** Sound; no path from the file is opened by the import.

## 7. Dependency audits

**`pnpm audit --prod`** (npm registry, production dependencies): `No known vulnerabilities found`.

**`cargo audit`** 0.22.2, installed with `cargo install cargo-audit --locked` (Apache-2.0 OR MIT, a development tool, not a dependency of the project), 1338 advisories, 568 crates in `Cargo.lock`: **0 vulnerabilities, 8 warnings**, all in code that is not built on Windows or macOS (Linux only) and none reachable from the page:

| Advisory                                     | Crate (version)                                          | Pulled in by                                                                                 |
| -------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| RUSTSEC-2024-0370 unmaintained               | `proc-macro-error` 1.0.4                                 | `glib-macros` 0.18.5 → gtk3 bindings → `muda` → `tauri` (Linux)                              |
| RUSTSEC-2024-0429 unsound (`VariantStrIter`) | `glib` 0.18.5                                            | the same gtk3 bindings (Linux); the iterator is not used by Noren                            |
| RUSTSEC-2026-0371 unmaintained               | `zbus_names` 3.0.0 and 4.3.5                             | `zbus` 4.4.0 ← `keyring` 3.6.3 (`noren-core`, Linux Secret Service)                          |
| RUSTSEC-2026-0370 and -0372 unmaintained     | `zvariant` 4.2.0 and 5.15.1, `zvariant_derive` same pair | the same, and `zbus` 5.19.0 ← `notify-rust` ← `tauri-plugin-notification`, `single-instance` |

Nothing is ignored in an audit config: the warnings are listed in full in the report of the round and here. No fix is possible from this repository (they follow Tauri, the notification plugin and `keyring`); finding 149 tracks them. The new `open` crate and its dependencies (`is-wsl`, `is-docker`, `libc`) have no advisory. `pnpm licenses:check` is green with the new crate.

## Changes in this review

CSP (`tauri.conf.json`), app manifest and minimal capabilities (`build.rs`, `capabilities/*.json`), `link_open` and the link dialog, the navigation guard, device names refused as theme ids, `zod` without its code generator, `.gitignore` for the generated `permissions/autogenerated/`, and the tests above. One property test (`terminal-options.test.ts`) asserted that the output of `safeFontFamily` never contains the letters `url`, which fails for the legitimate font name `URl`; it now asserts that `url(` never appears (parentheses were already refused one line above).

## Findings

| #   | Severity | State  | Summary                                                                                                                                                                                                                                                                                                                      |
| --- | -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 92  | low      | closed | A mod could load a remote `url()`: closed by the policy (item 1, `e2e/csp.spec.ts:129`).                                                                                                                                                                                                                                     |
| 148 | low      | open   | `project_command_run` (`bridge.rs:952`) runs any command line the page sends in a folder it names; the Rust side does not check it against the `.noren/actions.json` of that folder or against the consent. It is no more power than `session_write` gives the page, but a check on the Rust side would make the claim true. |
| 149 | low      | open   | Eight `cargo audit` warnings, Linux only (item 7); follow upstream (Tauri, notification plugin, `keyring`) and re-run `cargo audit` before each release.                                                                                                                                                                     |
| 150 | low      | open   | `style-src` keeps `'unsafe-inline'` (item 1). Remove it when xterm.js can take a nonce, and by turning the mods into constructed stylesheets.                                                                                                                                                                                |

## Not verified (D19)

Nothing needed a visible window to be written, so these only could not be watched in one: the policy and the navigation guard in the real WebView2 window, the IPC transport it picks (`tauri.conf.json:30`), the title bar buttons and the double-click maximize (`TitleBar.tsx:23-70`, `capabilities/default.json`), `homeDir` (`home.ts:11`), and the real browser launch (`link.rs:18`). The hidden `pnpm smoke` runs prove that the page boots, that sessions, settings, themes, scrollback, fonts, the quick window and the deep link work under the policy, the manifest and both capabilities.
