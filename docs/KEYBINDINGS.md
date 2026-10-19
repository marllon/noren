# Keybindings

Every Noren shortcut is an action in one registry (`apps/desktop/src/keybindings.ts`). A pure resolver turns a key press into the action it stands for, or into nothing. A key with no Noren action is left alone and reaches the terminal.

## How a key press is handled

One listener on the window, in the capture phase, reads every `keydown`:

1. The resolver looks the press up. No action: the listener returns and the key goes on to the terminal.
2. The key goes to a text field (a rename box, a dialog field): the listener returns, so the shortcuts never act while the user types.
3. Otherwise the listener calls `preventDefault` and `stopPropagation`, so the terminal never sees the key, and runs the action. Holding the key repeats only the actions that allow it (moving the focus, resizing a pane).

A key is a shortcut only when it matches an action, and a shortcut that is bound but cannot act (go to tab 7 with three tabs, split past the pane limit) is still swallowed.

## Chords

A chord is written as modifiers in the fixed order `Ctrl`, `Alt`, `Shift`, then the physical key as the browser names it in `event.code`: `Ctrl+Shift+KeyT`, `Alt+ArrowLeft`, `Ctrl+Alt+Digit1`. Matching uses `event.code` and exactly the modifiers named, so `Ctrl+KeyT` does not match Ctrl+Shift+T, and a press with Meta held matches nothing. A chord needs Ctrl or Alt, so plain typing and Shift+letter can never be one.

## Presets

The **safe** preset is the default. It does not fight the shell: Ctrl+T, Ctrl+W and Ctrl+1..9 stay with the terminal.

| Action                        | Safe preset           | Browser preset        |
| ----------------------------- | --------------------- | --------------------- |
| New tab                       | Ctrl+Shift+T          | Ctrl+T                |
| Close pane                    | Ctrl+Shift+W          | Ctrl+W                |
| Split right                   | Ctrl+Shift+D          | Ctrl+Shift+D          |
| Split below                   | Ctrl+Shift+E          | Ctrl+Shift+E          |
| Zoom pane                     | Ctrl+Shift+Z          | Ctrl+Shift+Z          |
| Focus pane left/right/up/down | Alt+arrows            | Alt+arrows            |
| Resize pane                   | Ctrl+Shift+Alt+arrows | Ctrl+Shift+Alt+arrows |
| Go to space 1..9              | Ctrl+Alt+1..9         | Ctrl+Alt+1..9         |
| Go to tab 1..9                | Alt+1..9              | Ctrl+1..9             |

The browser preset is opt-in. It takes Ctrl+T, Ctrl+W and Ctrl+1..9 away from the terminal, so a shell program that uses them (for example a readline "transpose characters" or a "delete word") no longer receives them.

A preset gives each action at most one chord. Where the browser preset moves an action, the safe chord is free again (Ctrl+Shift+T does nothing there, until an action that needs it exists).

Only the actions that exist today are registered. Later tasks add theirs (the palette, reopen closed, the MRU switcher, search) to the same registry.

## Overrides and conflicts

The user's own chords are overrides: an action id mapped to a chord, or to `null` to leave the action without a key. An override equal to the preset's chord is no override.

If an override would bind a chord that another action holds, the override is not applied: the action keeps its preset chord and the resolver reports the refusal (`resolveBindings(...).rejected`). Two overrides asking for the same chord: the first action in the registry gets it. `findConflicts` is the pure check for a chord bound to two actions in a chord map.

## Storage

The chosen preset and the overrides live in the browser storage under `noren.ui.keybindings`, as `{"preset": "safe" | "browser", "overrides": {"<action id>": "<chord>" | null}}`. This is provisional until the settings file (NOR-F8-01) owns it. A value that is missing, not JSON, not an object, or has an unknown preset falls back to the default; an override for an unknown action, or with a chord that cannot match, is dropped.

For now the preset is chosen in the Layout panel of the title bar. The shortcuts screen (search, recording a chord, the conflict warning) is NOR-F6-01b.
