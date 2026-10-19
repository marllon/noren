# Command palette

Ctrl+Shift+P opens the palette: one search box over what Noren can jump to or run. The key is the action **Open palette** of the registry (`apps/desktop/src/keybindings.ts`, both presets), so it shows in the shortcuts screen and can be recorded like any other. The list is built by the pure functions in `apps/desktop/src/palette.ts`; `CommandPalette.tsx` draws it with [`cmdk`](https://github.com/dip/cmdk) (MIT), which provides the listbox, the arrow-key selection and Enter. `cmdk` does not filter on its own (`shouldFilter={false}`): the matching below is ours, so it can be tested without a browser.

## What it lists

| Kind   | Entry                                                                                      | Enter                                                                      |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Tab    | Title of every tab of every space, with the space name and the folder of the focused pane  | Shows the space that owns the tab, then the tab (same as a Favorites tile) |
| Space  | Name of every space, with its tab count and default folder                                 | Shows the space (same as its button in the switcher)                       |
| Action | Every action of the registry, with the chord in force for the current preset and overrides | Runs the action's command (same as pressing its chord)                     |

Entries run the same calls as a click or a shortcut; the palette has no commands of its own. An action that is refused (a split past the pane limit) shows the usual notice. "Open palette" is not listed: running it from the palette would only open it again.

## Search

- Empty box: everything, tabs first, then spaces, then actions.
- Prefixes limit the list to one kind: `>` actions, `@` tabs, `#` spaces. Only a leading prefix counts. (`?`, for AI, comes with the AI phase.)
- Each word of the text must match the title or the extra text of the entry (the space name and full folder of a tab, the category and chord of an action). A run of the word scores above letters spread out in order; the spread-out form only applies to the title, because in a long folder path it would match anything. A hit nearer the start of the title, or at the start of a word, ranks higher; a title hit counts double. Case, extra spaces and the `+` in a chord do not matter (`ctrl shift d` finds Split right).
- Within each kind the best match comes first, ties keep the order of the workspace.

## Keyboard

- The search box takes the keyboard when the palette opens. Up and Down move the selection (it wraps), Enter runs it, Escape closes without running anything. Tab does not leave the box.
- While the box has the keyboard no shortcut acts (the text-field guard of the keyboard listener), so typing `d` or pressing Ctrl+Shift+D in it does not split.
- Closing the palette, by running an entry, Escape or a click outside, gives the keyboard back to the terminal of the tab on screen.
- The listener does not open the palette over a menu or dialog.

## Theming

The panel carries `data-nr-part="palette"` (one of the stable attributes of the theme API) and uses only the `--nr-*` tokens. Each entry carries `data-nr-kind="tab|space|action"`.

## Not yet

Profiles ("New pwsh in..."), recent folders and themes arrive with NOR-F6-02b.
