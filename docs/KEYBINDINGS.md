# Keybindings

Every Noren shortcut is an action in one registry (`apps/desktop/src/keybindings.ts`). A pure resolver turns a key press into the action it stands for, or into nothing. A key with no Noren action is left alone and reaches the terminal.

## How a key press is handled

One listener on the window, in the capture phase, reads every `keydown`:

1. The resolver looks the press up. No action: the listener returns and the key goes on to the terminal.
2. The key goes to a text field (a rename box, a dialog field, the search box of the command palette): the listener returns, so the shortcuts never act while the user types. This is also why Ctrl+Shift+P does nothing while the palette is open.
3. Otherwise the listener calls `preventDefault` and `stopPropagation`, so the terminal never sees the key, and runs the action. Holding the key repeats only the actions that allow it (moving the focus, resizing a pane).

A key is a shortcut only when it matches an action, and a shortcut that is bound but cannot act (go to tab 7 with three tabs, split past the pane limit) is still swallowed.

## Chords

A chord is written as modifiers in the fixed order `Ctrl`, `Alt`, `Shift`, then the physical key as the browser names it in `event.code`: `Ctrl+Shift+KeyT`, `Alt+ArrowLeft`, `Ctrl+Alt+Digit1`. Matching uses `event.code` and exactly the modifiers named, so `Ctrl+KeyT` does not match Ctrl+Shift+T, and a press with Meta held matches nothing. A chord needs Ctrl or Alt, so plain typing and Shift+letter can never be one.

## Presets

The **safe** preset is the default. It does not fight the shell: Ctrl+T, Ctrl+W and Ctrl+1..9 stay with the terminal.

| Action                        | Safe preset           | Browser preset        |
| ----------------------------- | --------------------- | --------------------- |
| Open palette                  | Ctrl+Shift+P          | Ctrl+Shift+P          |
| New tab                       | Ctrl+Shift+T          | Ctrl+T                |
| Close pane                    | Ctrl+Shift+W          | Ctrl+W                |
| Split right                   | Ctrl+Shift+D          | Ctrl+Shift+D          |
| Split below                   | Ctrl+Shift+E          | Ctrl+Shift+E          |
| Zoom pane                     | Ctrl+Shift+Z          | Ctrl+Shift+Z          |
| Focus pane left/right/up/down | Alt+arrows            | Alt+arrows            |
| Resize pane                   | Ctrl+Shift+Alt+arrows | Ctrl+Shift+Alt+arrows |
| Go to space 1..9              | Ctrl+Alt+1..9         | Ctrl+Alt+1..9         |
| Go to tab 1..9                | Alt+1..9              | Ctrl+1..9             |
| Next recent tab               | Ctrl+Tab              | Ctrl+Tab              |
| Previous recent tab           | Ctrl+Shift+Tab        | Ctrl+Shift+Tab        |
| Search all tabs               | Ctrl+Shift+Alt+F      | Ctrl+Shift+Alt+F      |
| Go to last unread tab         | Ctrl+Shift+U          | Ctrl+Shift+U          |
| Previous / next prompt        | Ctrl+Up / Ctrl+Down   | Ctrl+Up / Ctrl+Down   |
| Select command output         | none                  | none                  |
| Copy last command output      | none                  | none                  |

The browser preset is opt-in. It takes Ctrl+T, Ctrl+W and Ctrl+1..9 away from the terminal, so a shell program that uses them (for example a readline "transpose characters" or a "delete word") no longer receives them.

A preset gives each action at most one chord. Where the browser preset moves an action, the safe chord is free again (Ctrl+Shift+T does nothing there, until an action that needs it exists).

Only the actions that exist today are registered. Later tasks add theirs (reopen closed) to the same registry. The command palette lists these same actions with the chord in force; see [PALETTE.md](PALETTE.md).

## Overrides and conflicts

The user's own chords are overrides: an action id mapped to a chord, or to `null` to leave the action without a key. An override equal to the preset's chord is no override.

If an override would bind a chord that another action holds, the override is not applied: the action keeps its preset chord and the resolver reports the refusal (`resolveBindings(...).rejected`). Two overrides asking for the same chord: the first action in the registry gets it. `findConflicts` is the pure check for a chord bound to two actions in a chord map.

## Storage

The chosen preset and the overrides live in the browser storage under `noren.ui.keybindings`, as `{"preset": "safe" | "browser", "overrides": {"<action id>": "<chord>" | null}}`. This is provisional until the settings file (NOR-F8-01) owns it. A value that is missing, not JSON, not an object, or has an unknown preset falls back to the default; an override for an unknown action, or with a chord that cannot match, is dropped.

The preset is chosen in the Layout panel of the title bar, which also holds the button that opens the shortcuts screen.

## The shortcuts screen

The **Keyboard shortcuts** button in the Layout panel opens a dialog that lists every action of the registry with its category and the chord in force for the current preset (`Ctrl+Shift+T`, `Alt+Left`; an action without a key reads `None`). Nothing is kept in the screen itself: it reads and writes the same preferences as above.

- **Search.** The box filters by title, category or chord text. Case, spaces and `+` do not matter, so `split right`, `Ctrl Shift D` and `ctrl+shift+d` all find Split right.
- **Record.** The Record button of an action reads the next key press as its new chord and saves it as an override; it works at once, with no restart. While a row records, the global shortcut listener runs nothing, so pressing a chord that is already an action's (for example Ctrl+Shift+D) records it and does not split. Escape cancels, and the screen stays open. A press with no Ctrl or Alt, or with Meta held, is ignored and the hint says why. A modifier key on its own is waited on. Holding the key down (auto-repeat) is ignored.
- **Reset** puts the chord of the current preset back (it is disabled when the action has no override). **Remove** leaves the action without a key (an override of `null`).
- **Conflicts.** Before anything is saved the new chord is laid over the chords in force and checked with `findConflicts`, and the result must still resolve with `resolveBindings`. If another action holds the chord, the change is refused: a warning (`role="alert"`) names the action that holds it, the action keeps its chord and the stored preferences stay as they were. This covers Record, and also Reset when another action has since taken the preset's chord. The refusal does not depend on the order of the registry: an action that was earlier in it cannot take a chord from a later one either. Both the check and the change are pure (`changeBinding` in `apps/desktop/src/shortcuts-screen.ts`).
- **Shell keys.** A note on the screen lists the keys the browser preset takes from the terminal (today `Ctrl+T`, `Ctrl+W`, `Ctrl+1..9`). The list is computed from the registry: the chords the browser preset gives to an action that the safe preset leaves free, so a new action added to the registry shows up without editing the text. The note reads "would take" while the safe preset is on and "no longer reach" once the browser preset is on.

The screen is a modal dialog; Escape (when no row is recording) or the Close button closes it and the focus goes back to the Layout button.

## The recent-tab switcher

Ctrl+Tab and Ctrl+Shift+Tab (the same in both presets; "Next recent tab" and "Previous recent tab" in the registry, so the shortcuts screen shows and records them) switch tabs by recent use, across all spaces.

- **A tap** (press and release) goes to the tab used before the one on screen. Tap again and it goes back.
- **Holding Ctrl** and pressing Tab again walks down the list; Ctrl+Shift+Tab walks up (and wraps at both ends). From the second step an overlay (`data-nr-part="mru"`) lists every open tab by recent use, each row (`data-nr-item-id`) with the tab name, its space and the last five non-empty lines of the focused pane. The row the walk stands on is selected. A quick tap shows no overlay.
- **Releasing Ctrl** (or whichever of Ctrl and Alt the chord uses) switches to the selected tab, changing space when it is in another, and the keyboard goes back to the terminal. **Escape** cancels and the Escape does not reach the terminal. Any other key or shortcut pressed during the walk ends it without switching, and the window losing focus cancels it.
- With a single tab nothing happens. The overlay never takes the keyboard: the terminal keeps it until the switch.

The list lives in memory only (it starts again when the app opens): a tab that shows goes to the front, a closed tab drops out, and tabs never shown follow in sidebar order. The pure part (order, wrapping, preview lines) is in `apps/desktop/src/mru.ts`; the walk and the overlay are `use-mru-switcher.ts` and `MruSwitcher.tsx`. From the command palette the two actions go straight to the previous tab (Next) or the least recently used one (Previous), since no key is held there.

## The command marks

Ctrl+Up and Ctrl+Down (the same in both presets; "Previous prompt" and "Next prompt" in the registry, category _Terminal_, so the shortcuts screen shows and records them and the palette lists them) scroll the focused terminal to the prompt of the previous or next command the shell reported. Holding the key repeats. See [SHELL_INTEGRATION.md](SHELL_INTEGRATION.md) for what a mark is and how the step is chosen.

These are the only registry actions whose key is not always taken. The listener asks the focused terminal first: if it has no command mark to go to (a shell without integration, a tab with no command yet, a program such as an editor on the alternate screen), or the keyboard is not in a terminal, the listener returns before `preventDefault`, and Ctrl+Up reaches the shell as it did before. With a mark the press is taken even when there is no further prompt in that direction (the first prompt, or the live end), so the shell does not get a Ctrl+Up that was only half ours. Up and Down with other modifiers are not ours: Alt+arrows focus a pane and Ctrl+Alt+Shift+arrows resize one, as before.

"Select command output" and "Copy last command output" are registry actions with no chord in either preset (an action may have none). They show as _None_ in the shortcuts screen, where a chord can be recorded for them, and they are always in the palette. A press of a chord recorded for them says in a notice why it did nothing.

## The last unread tab

Ctrl+Shift+U (the same in both presets; "Go to last unread tab", `tab.last-unread`, category _Tabs_, so the shortcuts screen shows and records it and the palette lists it) shows the pane that became unread last, in any space: it chooses that tab, focuses the pane and shows its space, which clears its marks. Pressing it again goes to the next most recent unread pane. With nothing unread it says so in the notice and changes nothing. The key does not repeat when held. See [SHELL_INTEGRATION.md](SHELL_INTEGRATION.md) for what marks a pane unread and what clears it.

## The search over all tabs

Ctrl+Shift+Alt+F (the same in both presets; "Search all tabs" in the registry, so the shortcuts screen shows and records it, and the palette lists it) opens a search over the output of every open tab of every space. The screen writes the chord as `Ctrl+Alt+Shift+F`, the fixed order of chord text. The key goes to a text field like any other shortcut, so pressing it again while the box has the keyboard does nothing. See [SEARCH.md](SEARCH.md).
