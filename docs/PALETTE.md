# Command palette

Ctrl+Shift+P opens the palette: one search box over what Noren can jump to or run. The key is the action **Open palette** of the registry (`apps/desktop/src/keybindings.ts`, both presets), so it shows in the shortcuts screen and can be recorded like any other. The list is built by the pure functions in `apps/desktop/src/palette.ts`; `CommandPalette.tsx` draws it with [`cmdk`](https://github.com/dip/cmdk) (MIT), which provides the listbox, the arrow-key selection and Enter. `cmdk` does not filter on its own (`shouldFilter={false}`): the matching below is ours, so it can be tested without a browser.

## What it lists

| Kind    | Entry                                                                                      | Enter                                                                                     |
| ------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Tab     | Title of every tab of every space, with the space name and the folder of the focused pane  | Shows the space that owns the tab, then the tab (same as a Favorites tile)                |
| Space   | Name of every space, with its tab count and default folder                                 | Shows the space (same as its button in the switcher)                                      |
| Action  | Every action of the registry, with the chord in force for the current preset and overrides | Runs the action's command (same as pressing its chord)                                    |
| Profile | "New <profile> tab" for every shell profile of the machine, with the space it opens in     | A new tab in the active space that starts that profile (same call as New tab)             |
| Folder  | A folder a shell reported through OSC 7, short form as the title, "Recent folder" below    | A new tab in that folder, with the profile of the space                                   |
| Theme   | "Theme: <name>" for every theme, and "Follow system theme"; the one in use says so         | Saves the theme in the settings file (see Themes below); the highlighted one is previewed |

Entries run the same calls as a click or a shortcut; the palette has no commands of its own. The command mark actions (_Previous prompt_, _Next prompt_, _Select command output_, _Copy last command output_) act on the focused pane of the tab on screen, and when there is nothing to do they say why in the notice (see [SHELL_INTEGRATION.md](SHELL_INTEGRATION.md)). _Go to last unread tab_ shows the pane that rang or notified last (see [KEYBINDINGS.md](KEYBINDINGS.md)), and says `Nothing unread` in the notice when there is none. An action that is refused (a split past the pane limit) shows the usual notice. The layout actions (_Switch sidebar side_, _Widen sidebar_, _Narrow sidebar_, _Switch density_, _Toggle compact mode_, _Toggle keep sidebar open_, _Toggle tabs on top_; category **Layout**, so `>layout` lists them) write the one setting they change into `config.jsonc` with its comments in place and the window follows the file; when they are refused or the write fails, the notice says why (see [KEYBINDINGS.md](KEYBINDINGS.md)). _Open settings_ opens the settings screen (see [CONFIG.md](CONFIG.md)) and leaves the keyboard to it; closing the screen gives the keyboard back to the terminal. "Open palette" is not listed: running it from the palette would only open it again.

## Search

- Empty box: everything, tabs first, then spaces, actions, profiles, recent folders and themes.
- Prefixes limit the list: `>` commands (the actions, the profiles, the recent folders and the themes), `@` tabs, `#` spaces. Only a leading prefix counts. (`?`, for AI, comes with the AI phase.)
- Each word of the text must match the title or the extra text of the entry (the space name and full folder of a tab, the category and chord of an action). A run of the word scores above letters spread out in order; the spread-out form only applies to the title, because in a long folder path it would match anything. A hit nearer the start of the title, or at the start of a word, ranks higher; a title hit counts double. Case, extra spaces and the `+` in a chord do not matter (`ctrl shift d` finds Split right).
- Within each kind the best match comes first, ties keep the order of the workspace.

## Keyboard

- The search box takes the keyboard when the palette opens. Up and Down move the selection (it wraps), Enter runs it, Escape closes without running anything. Tab does not leave the box.
- While the box has the keyboard no shortcut acts (the text-field guard of the keyboard listener), so typing `d` or pressing Ctrl+Shift+D in it does not split.
- Closing the palette, by running an entry, Escape or a click outside, gives the keyboard back to the terminal of the tab on screen.
- The listener does not open the palette over a menu or dialog.

## Theming

The panel carries `data-nr-part="palette"` (one of the stable attributes of the theme API) and uses only the `--nr-*` tokens. Each entry carries `data-nr-kind="tab|space|action|profile|folder|theme"`.

## Profiles

The list comes from `listProfiles` of the backend, read once when the window starts. A profile entry runs `newTab({ profileId })` of the workspace store, the same call as the New tab command with the profile named, so the folder and environment still come from the space. In web mode (tests, demo) the profiles can be seeded in `localStorage` under `noren.web.profiles`, a JSON list of `{ id, name, default }`.

## Recent folders

Every terminal listens for OSC 7 (`ESC ] 7 ; file://host/path BEL`), which a shell with integration sends at each prompt. `osc7.ts` turns the text into a folder: the host is ignored, percent escapes are decoded and `/C:/x` becomes `C:/x`; anything that is not a plain `file:` URL with a path, has a control character or is longer than 4096 characters is dropped. The folder goes to the front of the list in `recent-folders.ts`:

- most recent first; a folder reported again moves to the front instead of repeating;
- two paths are the same folder by the comparison deep links use (`sameFolder`: `/` and `\` alike, no trailing separator, Windows-style paths ignore case);
- at most 200, the oldest leave first;
- kept in `localStorage` under `noren.ui.recent-folders`; a value that is not a list of text reads as empty. This is provisional until the settings file (NOR-F8-01).

The list is read when the palette opens. Picking a folder only opens a shell there; nothing is run. The folder the sidebar shows for a pane is not changed by OSC 7 yet: the shell scripts and the shared parser come with NOR-F7-01a and NOR-F7-01b, and the interface does not use that parser yet.

## Themes

Eight themes come with Noren: Noren Dusk (dark) and Noren Paper (light), the two Noren was born with, and six more: Noren Nightshade, Noren Fjord, Noren Midnight and Noren Meadow (dark), Noren Dune and Noren Oat (light). The palette lists "Theme: <name>" for each, and "Follow system theme". The entry in use says so ("in use" for a theme, "In use" for the system).

- **Live preview.** The theme highlighted in the list (with the arrows, or with the pointer, or because it is the only one a search leaves) is applied to the whole window at once, the terminals included, without being saved. Moving the highlight to another theme previews that one; to anything that is not a theme (a tab, an action...) shows the saved theme again.
- **Escape** (or a click outside the palette) closes it and puts the saved theme back. Nothing is written.
- **Enter** (or a click) on the highlighted entry saves it: it writes `appearance.theme` in `config.jsonc` through the same call as the settings screen, so the comments of the file stay, and the window already shows it (see [CONFIG.md](CONFIG.md)). "Follow system theme" writes `"system"`; when the file has no choice at all it writes nothing, because it already follows the system. If the file has a problem of its own, or the disk refuses the write, the usual notice says so and the saved theme stays.

The choice is a setting of the file, not of the browser storage: it also changes when the file changes (an editor, a script), with no reload. A theme the file names but this build does not have follows the system, like no choice. The way a theme is made, and where the six others come from, is in [CONFIG.md](CONFIG.md) and in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
