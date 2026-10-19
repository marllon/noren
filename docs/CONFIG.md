# The settings file

Noren keeps its settings in one text file, `config.jsonc`. It is JSON that allows comments (`//` and `/* */`) and a comma after the last item, so it can be edited by hand and annotated. Nothing is stored anywhere else that you need to know about: this file is the place to look. You can edit it with any editor, or change the same settings in the settings screen of Noren, which writes this file and leaves your comments where they are.

## Where it is

| System  | Path                                                                 |
| ------- | -------------------------------------------------------------------- |
| Windows | `%APPDATA%\io.github.marllon.noren\config.jsonc`                     |
| macOS   | `~/Library/Application Support/io.github.marllon.noren/config.jsonc` |
| Linux   | `~/.config/io.github.marllon.noren/config.jsonc`                     |

It is the config folder of the app (Tauri `app_config_dir`), next to `state.json` on Windows. The file does not exist until something is saved: Noren creates it (and its folder) the first time you save the settings screen, import profiles or drag the sidebar handle, with only the settings you changed. Without it every setting has its default.

## The settings screen

The **Settings** button (the gear in the title bar), or **Open settings** in the command palette (`Ctrl+Shift+P`, then `>`), opens the screen. It has four sections:

- **Appearance**: the side of the sidebar and its width, where the tabs are (the sidebar or a bar on top), density, compact mode, keeping the sidebar open, and the pane headers.
- **Shortcuts**: which preset is in force (safe or browser), and a button that opens the screen to see and record the keys of every action (see [KEYBINDINGS.md](KEYBINDINGS.md)).
- **Notifications**: system notifications on or off, and how many seconds a command runs before it notifies when it ends out of sight.
- **Import**: **Import color scheme...** (the same as the palette action: a theme from a color scheme file, see [THEMING.md](THEMING.md)) and **Import profiles...** (the shell profiles of another program's settings file, see [Profiles](#profiles)). Unlike the other sections these act at once and are not part of the draft: a color scheme is added as soon as the file is read, and profiles are added when you confirm the preview. What happened is told under the buttons.

What you change is a draft until you press **Save** (Enter in a box saves too; **Cancel** or Esc drops it). Save writes **only the settings you changed**: a setting you put back where it was is not written, the rest of the file stays exactly as it was, with every comment, blank line and trailing comma in place, and a new setting is added where the list below puts it. The change shows at once in the window, with no restart and no reload, because the window follows the file. A number outside its range is refused where you type it.

If the file has a problem of its own (see below), Save is off and the screen says where the problem is: Noren does not edit a file it could not read. Fix the file, or delete it, and the screen saves again. If the disk refuses the write, the screen stays open with the reason and your draft.

The layout modes of the Appearance section can also be switched from the command palette without opening the screen (_Switch sidebar side_, _Widen sidebar_, _Narrow sidebar_, _Switch density_, _Toggle compact mode_, _Toggle keep sidebar open_, _Toggle tabs on top_; see [KEYBINDINGS.md](KEYBINDINGS.md)). Each writes only its own setting, the same way Save does, and shows a notice if it cannot (the file has a problem, or the disk refused).

Dragging the handle on the edge of the sidebar (or pressing the arrow keys on it) saves `appearance.sidebar.width` the same way, when you let go. The handle does nothing while the file has a problem.

## Reload without a restart

Noren watches the folder of the file (and creates that folder, empty, when it is missing, so a file created later is seen too). When you save it, from an editor, a script or the settings screen, the new settings apply at once, with no restart and no reload of the window: move `appearance.sidebar.position` to `"right"` and the sidebar moves.

If the saved text has a problem (it is not JSON, a value is of the wrong kind or out of its range, a setting does not exist), **nothing changes**: Noren keeps the last valid settings and shows a notice in the corner that names the first problem with its line, for example:

```
The settings file has a problem, so the last valid settings stay in use.
config.jsonc, line 3, column 19: appearance.sidebar.position: Invalid option: expected one of "left"|"right"
```

The notice does not block anything; close it with its button. It goes away by itself when the file is valid again. A file that is wrong when the app starts means the defaults until it is fixed. Deleting the file puts the defaults back.

A setting that is missing is "not set here": it has its default. The file is the only place a setting lives, so a setting you take out of the file is back at its default.

## Settings

Every setting is optional. Unknown settings are an error, so a typo does not go unnoticed. The editor can complete and check the file with the schema: add `"$schema": "./config.schema.json"` (the schema is [config.schema.json](config.schema.json) in this folder of the repository).

```jsonc
{
  "appearance": {
    "theme": "system", // a theme id such as "noren-dusk"; "system" or no value follows the system
    "sidebar": {
      "position": "left", // "left" | "right"
      "width": 200, // whole pixels, 180 to 480
      "compact": false, // the sidebar hides and shows when the pointer touches the edge
      "keepOpen": false, // in compact mode, keeps it open
    },
    "density": "comfortable", // "comfortable" | "compact"
    "tabs": "sidebar", // "sidebar" | "top"
    "paneHeaders": false, // a header on every pane
  },
  "profiles": [], // shells of your own, see Profiles below
  "keybindings": {
    "preset": "safe", // "safe" | "browser"
  },
  "notifications": {
    "enabled": true, // false: never ask the system for a notification
    "longCommandSeconds": 30, // a longer command that ends out of sight notifies
  },
}
```

The values above are the defaults. More sections (terminal, auto-archive, AI) arrive with the tasks that need them; the schema is the list of what exists now. Your own shortcuts (the keys you record for an action) and a few other preferences (the recent folders, the answers to the question about running a project action) are still kept in the browser storage of the window, not in this file, until their settings get a place here.

## Profiles

Noren finds the shells of the machine by itself (PowerShell, Command Prompt, Git Bash and the WSL distributions on Windows; the shells of `$SHELL` and `/etc/shells` elsewhere). `profiles` lists shells of your own, which join them in the command palette (_New ... tab_, see [PALETTE.md](PALETTE.md)):

```jsonc
"profiles": [
  {
    "id": "dev-shell", // lower case words joined by hyphens; unique
    "name": "Dev Shell", // shown in the palette
    "program": "pwsh.exe", // the program, or a full path
    "args": ["-NoLogo"], // optional: one item for each argument
    "cwd": "C:\\work", // optional: where a session starts
  },
],
```

- `id`, `name` and `program` are required; `args` and `cwd` are optional. A program or a name that is empty (or only blanks) is an error of the file, shown with its line like any other. So is an `id` used twice or `default` (a pane uses that word for "the default shell").
- `%NAME%` in the program, the arguments and `cwd` is replaced by the environment variable `NAME` when the profile is loaded (so `%SystemRoot%\\System32\\cmd.exe` and `%USERPROFILE%` work); one that is not set stays as written.
- A session starts in the folder of the call when there is one (a tab opened in a folder, the folder of the space), else in `cwd`, else where the shell starts. A `cwd` that is not a folder is an error when the tab opens, with the folder named.
- The shell integration (the prompt marks and the folder reported by the shell, see [SHELL_INTEGRATION.md](SHELL_INTEGRATION.md)) is on for a profile of yours as for a detected one; it only does anything for the shells it knows, and leaves a command line that says what the shell runs (`/c`, `-Command`) alone.
- The list follows the file like the other settings: add a profile by hand, save, and it is in the palette with no reload; take it out and it is gone. The default shell is always one of the machine's (the first profile of yours only when the machine has none).
- An `id` that is one of the machine's shells (`pwsh`, `cmd`, `git-bash`, `wsl-Ubuntu`...) is refused when the profiles are loaded: the whole list is not applied, the profiles in force stay, and a notice in the corner says which profile and why. Pick another id.

**Import profiles...** in the settings screen fills this list from the settings file of another program: it shows what it would add and, when you confirm, appends the profiles to `profiles` keeping your comments (see [THEMING.md](THEMING.md#profiles-in-a-settings-file)). Its `colorScheme` is not carried over. Editing or deleting a profile from the interface is not there yet: change or remove the entry in the file.

## Themes

`appearance.theme` is the id of the theme. Without it, or with `"system"`, the theme follows the light or dark color scheme of the operating system (Noren Dusk when it is dark, Noren Paper when it is light), live. The id has to be lower case words joined by hyphens; one that is not is an error of the file, and an id that is well formed but that this build does not have follows the system, with no error.

The eight built-in themes:

| Id                 | Name             | Kind  |
| ------------------ | ---------------- | ----- |
| `noren-dusk`       | Noren Dusk       | dark  |
| `noren-paper`      | Noren Paper      | light |
| `noren-nightshade` | Noren Nightshade | dark  |
| `noren-fjord`      | Noren Fjord      | dark  |
| `noren-midnight`   | Noren Midnight   | dark  |
| `noren-meadow`     | Noren Meadow     | dark  |
| `noren-dune`       | Noren Dune       | light |
| `noren-oat`        | Noren Oat        | light |

You pick one in the command palette (_Theme: <name>_, see [PALETTE.md](PALETTE.md)), which previews the highlighted theme live and, on Enter, writes the id here like the settings screen does (the comments stay), or by writing the id in the file yourself. The theme of one space is not a setting of this file: a space can have its own theme (`themeId`), chosen in the menu of the space or by **Set theme for this space** in the palette, and it is saved with the space in `state.json`, so it follows the space (not the file) and is not touched by editing `config.jsonc`. The theme the window shows is, in order: the one being previewed in a list, the theme of the active space when this build has a theme with that id, then `appearance.theme`, then the system's; an id of a space the build does not have (a later build, a theme since removed) falls to the global theme with no error. See [PALETTE.md](PALETTE.md). The six themes after the first two are ports of color schemes published under permissive licenses; where each comes from, and its license, is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Your own themes join these: a theme file in the `themes` folder next to this file, or a color scheme imported with **Import color scheme...** in the palette, is a theme like the built-in ones, and its id can be the value of `appearance.theme` or the theme of a space. The folder, the formats the import reads and how the interface colors are derived are in [THEMING.md](THEMING.md). (An id this file names that no theme has, built-in or yours, follows the system, as above.)

A theme is data, in the format of the spec (`ThemeSchema` in `packages/model/src/theme.ts`; the type `Theme` comes from it): `id`, `name`, `kind` (`dark` or `light`), `ui` (the colors `bg`, `surface`, `text`, `muted`, `accent`, `border`, and `radius`, `blur`, `opacity`), `terminal` (`foreground`, `background`, `cursor`, `selection` and the 16 `ansi` colors), `font` and `background`. Colors are `#rrggbb` (the selection may add an alpha, `#rrggbbaa`); an unknown field, a missing one, a color that is not a color or a number out of its range makes the theme invalid. Every built-in theme goes through the schema when the app starts, and a test holds all of them to a contrast of at least 4.5:1 (WCAG 2.x, level AA) between `ui.text` and `ui.bg`, and between `terminal.foreground` and `terminal.background`. The interface reads a theme only through the `--nr-*` variables (see the API for mods in the spec).

## What happened to the choices made before the settings screen

Before the settings screen, the layout, the notification settings and the shortcut preset were kept in the browser storage of the window (`noren.ui.layout`, `noren.ui.notifications` and the `preset` of `noren.ui.keybindings`), with a small panel in the title bar to change them, and the theme was kept in `noren.ui.theme`. That panel is gone and the storage is no longer read for them. So that nobody loses what they chose, the first start after the upgrade **moves those choices into the file once**:

- the theme you had picked in the palette (`noren.ui.theme`) becomes `appearance.theme`, unless the file already names one;
- only what is not the default is written (a width of 200, the left side, comfortable density... are the defaults and add nothing), in the same way the screen writes it, with your comments in place if the file already exists, and the file is created if it does not;
- a setting the file already has is left as the file says: **the file wins**;
- after that the old keys are removed (for the shortcuts only the `preset` goes; your own recorded keys stay);
- if the file has a problem, or cannot be written, nothing is moved and nothing is removed, and the next start tries again.

## For contributors

- The schema is written with zod in `packages/model/src/config.ts` (`ConfigSchema`); `parseConfigText` reads the text (it uses `jsonc-parser`, so errors know their line) and never throws. `ConfigManager` (`config-manager.ts`) keeps the settings in force: a valid text replaces them, an invalid one keeps them and reports the errors.
- `docs/config.schema.json` is generated from that schema. A Vitest test fails when it is out of date; run `pnpm --filter @noren/model config:schema` to regenerate it.
- `noren-core` (`crates/noren-core/src/config.rs`) reads, writes atomically (temporary file in the same folder, flush, rename) and watches the file with the `notify` crate; the Tauri commands are `config_load`, `config_save` and `config_watch`, and the change reaches the page as the `config-changed` event with the new text (`null` when the file was removed).
- `Backend.loadConfig()`, `Backend.saveConfig(text)` and `Backend.watchConfig(callback)` are the interface. `FakeBackend.setConfig(text)` replaces the text of the in-memory file as another program would and tells the watchers; `saveConfig` does the same as the app does (and is recorded). In the web build the text lives in the browser storage under `noren.web.config`, and the test hook `window.__norenTest.setConfig(text)` is how the end-to-end tests edit "the file" (`failConfigSaves(message)` makes the next saves fail).
- **Editing the text.** `editConfigText(text, changes)` (`packages/model/src/config-edit.ts`) is the only way the app writes the file. A setting the text already has gets only its value replaced (`modify` and `applyEdits` of `jsonc-parser`); a new one is inserted by hand as a line of its own, indented like its neighbors, under the line of the setting before it (so the comment at the end of that line stays with it), in the order the schema lists the settings, creating the groups it needs; an object written on one line stays on one line; line breaks (LF or CRLF), indentation and a byte order mark are kept. `modify`'s own formatting is not used for an insertion because it reformats every line it touches. A change cannot take a setting out: that would take the comments around it with it. Besides setting a value, an edit can **append** items to a list (`{ path: ["profiles"], append: [...] }`): the items go under the last one, indented like it and as objects over several lines, a list written on one line stays on one line, a trailing comma the list had is kept, and a list the file lacks is created in the place the schema lists it.
- `ConfigManager.update(changes)` reads the file now, refuses when it has a problem or when the result would not be valid (nothing is written), edits it, saves it through the backend and applies the new text at once; the watcher then reports the same text and it is ignored. Updates queue up, so two quick ones both land.
- **Profiles.** `UserProfileSchema` (`user-profile-schema.ts`) is the schema of one entry and is part of `ConfigSchema`. `profiles-store.ts` hands the `profiles` of the settings in force to the backend with `Backend.setUserProfiles` (at start, before any shell is restored, and at every change of that list) and keeps the joined list `listProfiles` answers; a list the backend refuses is `getProfilesProblem`, shown as a notice. In `noren-core` (`profiles.rs`) `UserProfile` is validated and `ProfileSet::with_user_profiles` joins it to the detected shells (`%NAME%` replaced through an injected environment); the Tauri command is `profiles_set_user`, and `AppState` keeps the detected set and the joined one. `FakeBackend` checks the list with the same rules (`profilesProblem`) and starts a session of a profile of the user in its `cwd`.
- The screen is `SettingsDialog.tsx`; what it shows and what Save writes is the pure `settings-screen.ts` (`settingsOf`, `planSave`). `layout-store.ts`, `notification-settings.ts` and `keybindings-store.ts` read the settings in force; `legacy-settings.ts` is the one-time move described above.
- The theme: `theme-choice.ts` reads `appearance.theme` from the settings in force (`themeChoiceOf`) and plans picking one (`planThemeChoice`, `runThemeChoice`, which hands the change to `ConfigManager.update`). `effectiveThemeChoice` there is the order above (pure, tested), `space-theme.ts` lists what a space can pick, and `use-theme.ts` follows the active space of the store (`followActiveSpaceTheme`, started at boot) and holds the preview of the palette over the saved choice: `previewTheme`, `clearThemePreview` and `chooseTheme`, which keeps the chosen theme on screen until the file has it, so the window does not flicker back. The built-in themes are in `packages/model/src/builtin-themes.ts`; `user-themes-store.ts` holds the list of them and of the user's (see [THEMING.md](THEMING.md)), and `theme-choice.ts` looks a theme up in the list it is given (the built-in ones by default, the whole list where the window asks).
