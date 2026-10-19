# Command palette

Ctrl+Shift+P opens the palette: one search box over what Noren can jump to or run. The key is the action **Open palette** of the registry (`apps/desktop/src/keybindings.ts`, both presets), so it shows in the shortcuts screen and can be recorded like any other. The list is built by the pure functions in `apps/desktop/src/palette.ts`; `CommandPalette.tsx` draws it with [`cmdk`](https://github.com/dip/cmdk) (MIT), which provides the listbox, the arrow-key selection and Enter. `cmdk` does not filter on its own (`shouldFilter={false}`): the matching below is ours, so it can be tested without a browser.

## What it lists

| Kind    | Entry                                                                                      | Enter                                                                         |
| ------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Tab     | Title of every tab of every space, with the space name and the folder of the focused pane  | Shows the space that owns the tab, then the tab (same as a Favorites tile)    |
| Space   | Name of every space, with its tab count and default folder                                 | Shows the space (same as its button in the switcher)                          |
| Action  | Every action of the registry, with the chord in force for the current preset and overrides | Runs the action's command (same as pressing its chord)                        |
| Profile | "New <profile> tab" for every shell profile of the machine, with the space it opens in     | A new tab in the active space that starts that profile (same call as New tab) |
| Folder  | A folder a shell reported through OSC 7, short form as the title, "Recent folder" below    | A new tab in that folder, with the profile of the space                       |
| Theme   | "Theme: <name>" for every theme, and "Follow system theme"; the one in use says so         | Applies the theme and keeps the choice (see Themes below)                     |

Entries run the same calls as a click or a shortcut; the palette has no commands of its own. An action that is refused (a split past the pane limit) shows the usual notice. "Open palette" is not listed: running it from the palette would only open it again.

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

The list is read when the palette opens. Picking a folder only opens a shell there; nothing is run. The folder the sidebar shows for a pane is not changed by OSC 7 yet: the shell scripts and the shared parser come with NOR-F7-01.

## Themes

A theme entry applies the theme at once and saves the choice in `localStorage` under `noren.ui.theme` (provisional until NOR-F8-01). Without a choice, or with a value that is corrupt or names a theme this build does not have, the theme follows `prefers-color-scheme` as before; the entry "Follow system theme" clears the choice.
