# Good first issues

> **Draft. Not posted.** Nothing here has been opened as an issue. The repository is private and has no release yet, so links use the placeholder `<REPO_URL>`. Open these only when the repository is public, and re-read each one against the code first: they are starting points, not confirmed defects. Apply the label `good first issue` to each.

Every issue assumes the setup in `docs/DEV.md` and ends with `pnpm verify` passing. Paths are relative to the repository root.

## 1. Add a third example mod

**Context.** `examples/mods/` has three small CSS mods (accent-bar, dim-unfocused and tinted-sidebar), each with a header that lists the variables and `data-nr-part` hooks it uses. A fourth example would show the mod format to newcomers. The hooks are described in `docs/THEMING.md`.

**Files.** `examples/mods/accent-bar.css` (the format to copy), `docs/THEMING.md`, `apps/desktop/src/mod-styles.ts`.

**Done when.** A new `.css` file in `examples/mods/` has the same header, uses only documented variables and hooks, and is mentioned in `docs/THEMING.md`. `pnpm verify` passes.

## 2. Fix the demo panel that stays blank after joining tabs by drag

**Context.** In the web demo, a pane that is remounted after two tabs are joined by dragging stays blank, because the fake backend does not re-emit the output of a session already running. The demo script is in `apps/desktop/src/demo/demo-script.ts`; the fake backend is in `packages/model/src/fake-backend.ts`. Confirm the behavior first with `pnpm e2e:demo`.

**Files.** `packages/model/src/fake-backend.ts`, `apps/desktop/src/demo/demo-script.ts`, `e2e/demo/demo.demo.ts`.

**Done when.** After a drag-to-split in the demo, both panes show their earlier output, covered by a test in `packages/model/src/` (for example next to `packages/model/src/fake-backend-state.test.ts`).

## 3. Make the download address in the demo banner a link

**Context.** The strip at the top of the web demo shows where to download the app as plain text, because a security test forbids anchors and the CSP forbids forms. Find a way that keeps the guarantee (for example the same confirmation the terminal asks before opening a link), or document why it cannot be done.

**Files.** `apps/desktop/src/demo/DemoBanner.tsx`, `apps/desktop/src/LinkPrompt.tsx`, `apps/desktop/src/link-prompt.ts`, `e2e/demo/demo.demo.ts`.

**Done when.** The address can be opened from the banner only after the user confirms, only for `http` and `https`, and the existing security tests still pass unchanged.

## 4. Add a missing screen to the Portuguese interface check

**Context.** `e2e/i18n-screens.spec.ts` opens each screen in Brazilian Portuguese and fails on text left in English. Review the screens of the app against its list and add any that is missing. The dictionaries are `apps/desktop/src/i18n/en.ts` and `apps/desktop/src/i18n/pt-BR.ts`.

**Files.** `e2e/i18n-screens.spec.ts`, `apps/desktop/src/i18n/en.ts`, `apps/desktop/src/i18n/pt-BR.ts`.

**Done when.** Every dialog and panel reachable from the interface is covered by the spec, any English text it finds is translated in `apps/desktop/src/i18n/pt-BR.ts`, and `pnpm e2e` passes.

## 5. Translate the interface into a third language

**Context.** `docs/CONFIG.md` ends with "To add a language": add it to `LANGUAGES`, write its dictionary, add it to `DICTIONARIES`. `tsc` fails when a key is missing or extra, and a test checks the placeholders. Pick a language you speak.

**Files.** `apps/desktop/src/i18n/index.ts`, `apps/desktop/src/i18n/en.ts`, `apps/desktop/src/i18n/pt-BR.ts`, `apps/desktop/src/i18n/i18n.test.ts`, `packages/model/src/config.ts`, `docs/CONFIG.md`.

**Done when.** The language appears in the `language` setting and the settings screen, every key has a translation, `docs/config.schema.json` is regenerated, and `pnpm verify` and `pnpm e2e` pass.

## 6. Document how to write a shell integration for another shell

**Context.** `docs/SHELL_INTEGRATION.md` explains the escape sequences the app reads and the scripts for PowerShell, bash, zsh and cmd. A short "writing one for another shell" section would help people who use fish or nushell. The script names and the shell detection live in the Rust core.

**Files.** `docs/SHELL_INTEGRATION.md`, `crates/noren-core/src/integration.rs`, `apps/desktop/src/osc7.ts`.

**Done when.** The section lists the sequences a shell must print (`OSC 7`, `OSC 133` A, B, C, D, and `E` for the command line), with a short example, and every statement matches `crates/noren-core/src/integration.rs`. Docs only, so `pnpm format` and `pnpm verify` pass.

## 7. Add a color scheme importer test fixture

**Context.** Noren imports color schemes from other terminals through `packages/model/src/importers.ts`, with parsers per file format (`packages/model/src/import-json.ts`, `packages/model/src/import-keyvalue.ts`, `packages/model/src/import-plist.ts`) and shared samples in `packages/model/src/import-fixtures.ts`. Add one more real-world-shaped sample per format that exercises an edge case (missing keys, uppercase hex, alpha channel) and a test that shows what happens.

**Files.** `packages/model/src/import-fixtures.ts`, `packages/model/src/importers.test.ts`, `packages/model/src/importers.ts`.

**Done when.** The new samples have tests that pass, and any bug they reveal is fixed in the same change with its own test.

## 8. Pin down how the shortcuts screen filter matches chords

**Context.** The shortcuts screen is built from the registry in `apps/desktop/src/keybindings.ts`, and its search box uses `filterRows` in `apps/desktop/src/shortcuts-screen.ts`, which matches the title, the category and the chord as shown (typing "Shift+D" should find Split right). Read the existing tests and add the cases that are missing: a chord with a digit (`Alt+1`), a query with spaces or different case, and an action with no key.

**Files.** `apps/desktop/src/shortcuts-screen.ts`, `apps/desktop/src/shortcuts-screen.test.ts`, `docs/KEYBINDINGS.md`.

**Done when.** The new cases pass in `apps/desktop/src/shortcuts-screen.test.ts`; if one reveals a bug in `filterRows`, it is fixed in the same change. `pnpm verify` passes.

## 9. Add a built-in theme

**Context.** The eight built-in themes (`noren-dusk`, `noren-paper`, `noren-nightshade`, `noren-fjord`, `noren-midnight`, `noren-meadow`, `noren-dune`, `noren-oat`) are data in `packages/model/src/builtin-themes.ts`, described in `docs/THEMING.md`. Add one with a name that is not a third-party product and a palette that keeps text readable.

**Files.** `packages/model/src/builtin-themes.ts`, `packages/model/src/theme.test.ts` (it counts the themes and lists their ids), `docs/THEMING.md`, `README.md` (the count of themes).

**Done when.** The theme appears in the palette, has the same fields as the others, the test that lists the ids is updated, the docs and README count are updated, and `pnpm verify` passes.

## 10. Add a recipe page for project actions

**Context.** Project actions (per-repository buttons that run a command after the user confirms) are described in `docs/ACTIONS.md`, with the file format in `packages/model/src/actions-file.ts`. A page of three or four practical recipes (a build, a test watcher, a dev server group) would show what they are for.

**Files.** `docs/ACTIONS.md`, `packages/model/src/actions-file.ts`, `packages/model/src/actions-file.test.ts`.

**Done when.** Each recipe is valid against the file format, and a test parses the recipes (extract them into a fixture) so the docs cannot drift. `pnpm verify` passes.
