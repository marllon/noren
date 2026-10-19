# Command palette

Ctrl+Shift+P opens the palette: one search box over what Noren can jump to or run. The key is the action **Open palette** of the registry (`apps/desktop/src/keybindings.ts`, both presets), so it shows in the shortcuts screen and can be recorded like any other. The list is built by the pure functions in `apps/desktop/src/palette.ts`; `CommandPalette.tsx` draws it with [`cmdk`](https://github.com/dip/cmdk) (MIT), which provides the listbox, the arrow-key selection and Enter. `cmdk` does not filter on its own (`shouldFilter={false}`): the matching below is ours, so it can be tested without a browser.

## What it lists

| Kind        | Entry                                                                                       | Enter                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Tab         | Title of every tab of every space, with the space name and the folder of the focused pane   | Shows the space that owns the tab, then the tab (same as a Favorites tile)                |
| Space       | Name of every space, with its tab count and default folder                                  | Shows the space (same as its button in the switcher)                                      |
| Action      | Every action of the registry, with the chord in force for the current preset and overrides  | Runs the action's command (same as pressing its chord)                                    |
| Profile     | "New <profile> tab" for every shell profile of the machine, with the space it opens in      | A new tab in the active space that starts that profile (same call as New tab)             |
| Folder      | A folder a shell reported through OSC 7, short form as the title, "Recent folder" below     | A new tab in that folder, with the profile of the space                                   |
| Theme       | "Theme: <name>" for every theme, and "Follow system theme"; the one in use says so          | Saves the theme in the settings file (see Themes below); the highlighted one is previewed |
| Space theme | Only after _Set theme for this space_: the themes and "Use global theme" (see Themes below) | Saves the theme in the active space; the highlighted one is previewed                     |

Entries run the same calls as a click or a shortcut; the palette has no commands of its own. The command mark actions (_Previous prompt_, _Next prompt_, _Select command output_, _Copy last command output_) act on the focused pane of the tab on screen, and when there is nothing to do they say why in the notice (see [SHELL_INTEGRATION.md](SHELL_INTEGRATION.md)). The font size actions (_Increase font size_, _Decrease font size_, _Reset font size_; category **Terminal**, so `>terminal` lists them with the command mark ones) change the font of every terminal of the window by one pixel, or put it back to `terminal.font.size` of the settings file; they write nothing and the palette closes and gives the keyboard back to the terminal (see [CONFIG.md](CONFIG.md#the-terminal)). _Reopen closed tab_ (category **Tabs**) brings back the tab closed last, where it was, with its old output dimmed above a new shell, and says `No closed tab to reopen` in the notice when there is none (see [KEYBINDINGS.md](KEYBINDINGS.md#reopening-a-closed-tab)). _Open library_ (category **Tabs**) opens the library of archived and closed tabs and leaves the keyboard to it (see [LIBRARY.md](LIBRARY.md)). _Go to last unread tab_ shows the pane that rang or notified last (see [KEYBINDINGS.md](KEYBINDINGS.md)), and says `Nothing unread` in the notice when there is none. An action that is refused (a split past the pane limit) shows the usual notice. The layout actions (_Switch sidebar side_, _Widen sidebar_, _Narrow sidebar_, _Switch density_, _Toggle compact mode_, _Toggle keep sidebar open_, _Toggle tabs on top_; category **Layout**, so `>layout` lists them) write the one setting they change into `config.jsonc` with its comments in place and the window follows the file; when they are refused or the write fails, the notice says why (see [KEYBINDINGS.md](KEYBINDINGS.md)). _Open settings_ opens the settings screen (see [CONFIG.md](CONFIG.md)) and leaves the keyboard to it; closing the screen gives the keyboard back to the terminal. _Import color scheme..._ (category General, no key by default) opens a file picker and imports the color scheme in the file it picks as a theme of your own, with a notice saying what it did or why it could not (see [THEMING.md](THEMING.md)); it writes nothing to `config.jsonc`, and the palette closes and gives the keyboard back to the terminal. "Open palette" is not listed: running it from the palette would only open it again.

## Search

- Empty box: everything, tabs first, then spaces, actions, profiles, recent folders and themes.
- Prefixes limit the list: `>` commands (the actions, the profiles, the recent folders and the themes), `@` tabs, `#` spaces. Only a leading prefix counts. `?` is not a filter but a request to the AI: see [`? text`](#-text-ask-for-a-command) below, and it exists only where the AI is on.
- Each word of the text must match the title or the extra text of the entry (the space name and full folder of a tab, the category and chord of an action). A run of the word scores above letters spread out in order; the spread-out form only applies to the title, because in a long folder path it would match anything. A hit nearer the start of the title, or at the start of a word, ranks higher; a title hit counts double. Case, extra spaces and the `+` in a chord do not matter (`ctrl shift d` finds Split right).
- Within each kind the best match comes first, ties keep the order of the workspace.

## `? text`: ask for a command

Where the AI is on (in the settings and for the space on screen), a query that starts with `?` replaces the list with one entry, **Ask for a command: <text>**; with nothing after the `?` it shows a hint instead. Enter closes the palette and opens a dialog (`CommandAskDialog.tsx`) that shows the exact text that will be sent: the instructions (which name the shell of the pane in use, by the name of its profile, and the system the window runs on) and the request, with the secrets already swapped for markers (`redactSecrets`) and a line with how many were. Nothing goes to the provider until **Send**. The provider is the one `ai.defaults.command` names (else the first provider of the file, else the first model of the Ollama of the computer). When the answer ends, the dialog shows the command taken out of it and **Insert at the prompt** puts it at the prompt of the focused pane through the same path as _Insert in terminal_ of the Ask panel (`TerminalHandle.insert`); it never presses Enter, and the dialog says the command runs only when you press Enter in the terminal. Nothing is executed.

The command is taken by `extractCommand` (`@noren/model`): the first non-blank line of the first fenced block of the answer, or the first non-blank line when there is no block (inside one pair of backticks, or after a leading `$ `, it is unwrapped). Tabs become blanks and every control character, line break and line or paragraph separator is removed, so the command is one line and cannot hold a `\r` or `\n`; a block of several lines gives its first line and the dialog says so. An answer with no command, or one longer than 1000 characters, is refused and nothing is inserted. `buildCommandMessages` refuses a blank request, one longer than 1000 characters, and any request where the AI is off.

Where the AI is off (the settings, or the space) a `?` query is an ordinary search, the entry and the hint do not exist, the search box does not mention it and nothing calls a provider.

## Keyboard

- The search box takes the keyboard when the palette opens. Up and Down move the selection (it wraps), Enter runs it, Escape closes without running anything. Tab does not leave the box.
- While the box has the keyboard no shortcut acts (the text-field guard of the keyboard listener), so typing `d` or pressing Ctrl+Shift+D in it does not split.
- Closing the palette, by running an entry, Escape or a click outside, gives the keyboard back to the terminal of the tab on screen.
- The listener does not open the palette over a menu or dialog.

## Theming

The panel carries `data-nr-part="palette"` (one of the stable attributes of the theme API) and uses only the `--nr-*` tokens. Each entry carries `data-nr-kind="tab|space|action|profile|folder|theme|space-theme"`.

## Profiles

The list comes from `listProfiles` of the backend: the shells found on the machine, then the profiles of your own from `profiles` in `config.jsonc` (see [CONFIG.md](CONFIG.md#profiles)), and it follows the file, so a profile you add by hand or import from the settings screen is in the list with no reload. A profile entry runs `newTab({ profileId })` of the workspace store, the same call as the New tab command with the profile named, so the folder and environment still come from the space. In web mode (tests, demo) the profiles can be seeded in `localStorage` under `noren.web.profiles`, a JSON list of `{ id, name, default }`.

## Recent folders

Every terminal listens for OSC 7 (`ESC ] 7 ; file://host/path BEL`), which a shell with integration sends at each prompt. `osc7.ts` turns the text into a folder: the host is ignored, percent escapes are decoded and `/C:/x` becomes `C:/x`; anything that is not a plain `file:` URL with a path, has a control character or is longer than 4096 characters is dropped. The folder goes to the front of the list in `recent-folders.ts`:

- most recent first; a folder reported again moves to the front instead of repeating;
- two paths are the same folder by the comparison deep links use (`sameFolder`: `/` and `\` alike, no trailing separator, Windows-style paths ignore case);
- at most 200, the oldest leave first;
- kept in `localStorage` under `noren.ui.recent-folders`; a value that is not a list of text reads as empty. This is provisional until the settings file (NOR-F8-01).

The list is read when the palette opens. Picking a folder only opens a shell there; nothing is run. The folder the sidebar shows for a pane is not changed by OSC 7 yet: the shell scripts and the shared parser come with NOR-F7-01a and NOR-F7-01b, and the interface does not use that parser yet.

## Themes

Eight themes come with Noren: Noren Dusk (dark) and Noren Paper (light), the two Noren was born with, and six more: Noren Nightshade, Noren Fjord, Noren Midnight and Noren Meadow (dark), Noren Dune and Noren Oat (light). The palette lists "Theme: <name>" for each, and "Follow system theme". The entry in use says so ("in use" for a theme, "In use" for the system). The themes you imported or placed in the themes folder (see [THEMING.md](THEMING.md)) are listed after the built-in ones, with the same preview and the same Enter; the list of _Set theme for this space_ and the menu of a space have them too.

- **Live preview.** The theme highlighted in the list (with the arrows, or with the pointer, or because it is the only one a search leaves) is applied to the whole window at once, the terminals included, without being saved. Moving the highlight to another theme previews that one; to anything that is not a theme (a tab, an action...) shows the saved theme again.
- **Escape** (or a click outside the palette) closes it and puts the saved theme back. Nothing is written.
- **Enter** (or a click) on the highlighted entry saves it: it writes `appearance.theme` in `config.jsonc` through the same call as the settings screen, so the comments of the file stay, and the window already shows it (see [CONFIG.md](CONFIG.md)). "Follow system theme" writes `"system"`; when the file has no choice at all it writes nothing, because it already follows the system. If the file has a problem of its own, or the disk refuses the write, the usual notice says so and the saved theme stays.

### A theme for one space

A space can have its own theme, which shows while the space is the active one; a space with none shows the global theme above. The action **Set theme for this space** (category Spaces, no key by default, so `>space theme` finds it) keeps the palette open and replaces its list with the eight themes and **Use global theme**; the one the space has says "In use in <space>". It works like the global list: the highlighted theme is previewed in the whole window (the "Use global theme" entry previews what the window shows with no theme of the space), **Escape** or a click outside puts the theme back and writes nothing, **Enter** gives the highlighted theme to the active space, or takes the space's own theme back. The same choices are in the menu of the space (right click on its icon in the switcher), under "Theme". Switching space switches the theme, the terminals included, with no reload.

The theme of a space is saved with the space in `state.json`, not in `config.jsonc` (see [CONFIG.md](CONFIG.md)). A global theme chosen from the palette while the active space has its own theme is saved, but the window keeps showing the theme of the space until another space is active.

The choice is a setting of the file, not of the browser storage: it also changes when the file changes (an editor, a script), with no reload. A theme the file names but this build does not have follows the system, like no choice. The way a theme is made, and where the six others come from, is in [CONFIG.md](CONFIG.md) and in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
