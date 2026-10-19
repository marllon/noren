# The library

The library is where the tabs that left their space wait: the **archive** (tabs Noren put away because nobody used them) and the **closed** tabs (the stack Ctrl+Shift+Alt+T reopens from). Open it with **Ctrl+Shift+Alt+L** (the same in both presets) or with _Open library_ in the command palette. See [KEYBINDINGS.md](KEYBINDINGS.md#the-library) and [PALETTE.md](PALETTE.md).

## The archive

A tab goes to the archive when it has been idle for `archive.afterHours` (12 hours unless the file says otherwise): no command running, nothing printed, nothing unread, not on screen, and neither pinned nor a favorite. The rules and the settings are in [CONFIG.md](CONFIG.md#auto-archive).

An archived tab is not gone. The archive keeps:

- the tab as it was (title, panes, split layout, folder and profile of each pane), without its shells: the processes of an archived tab are ended, so a tab with a command running is never archived;
- the space it came from and **the slot it left**: the list (pinned or the tree), the group and the position, as a closed tab does (see [ARCHITECTURE.md](ARCHITECTURE.md#files-configuration-and-themes));
- its **output**: the last lines of each pane, written as the tab leaves, under the same rules as the saves of every minute (`terminal.saveScrollback` of the settings and `saveScrollback` of the space). A space or a setting that never saves keeps no output, and a file saved before is removed.

The archive has no size limit; deleting from the library is how it gets smaller.

## What the library shows

Two sections, **Archive** and **Closed**, each with its count, and a box that searches both by **title and folder** (the full folder of the pane that had the keyboard): every word of the search has to be in one of them, case does not matter. The text of the output is not searched yet. Each row shows the title, the folder (short form), the name of the space it came from and the moment it left. The newest is first.

- **Up** and **Down** move the selection from the search box, **Enter** restores the selected tab and **Escape** closes the library and gives the keyboard back to the terminal. A click on a row restores it.
- **Restore** puts the tab back in its space, in its list, group and position (clamped to what the list holds now); a group that is gone, or an entry with no place, sends it to the end of the tree of its space, and a space that is gone to the end of the tree of the active one. The space becomes the active one and the tab is shown. The shells are new, in the folder and profile of each pane, and the saved output comes back dimmed above the line `session restored <date and time>`, as when the app opens. The tab counts as active from that moment, so it is not archived again at once.
- **Delete** (the bin on the row) asks first and then forgets the tab for good: the entry leaves the list and the files of its output are removed. A closed tab and an archived one are deleted the same way. Restoring never removes the files: the tab that is open again owns them.

## Where it is in the code

- `packages/model`: `archive.ts` (the pure rule, `idleItems`, and the settings, `archiveSettingsOf`), the actions `item/archive`, `archive/restore`, `archive/delete` and `closed/delete` in `reducer.ts`, and the check of `Workspace.archive` (with its `place`) in `state.ts`. `state.json` of an earlier build, whose archive is empty, loads as it did.
- `apps/desktop/src`: `auto-archiver.ts` (the scheduler: a check every minute on an injected `Clock`, the signs of life of each tab, `item/archive` for the idle ones), `auto-archive-service.ts` (the settings and the clock of the app; in web mode the clock of the fake shell, which the tests move), `library-entries.ts` (the list and the search, pure), `Library.tsx` (the dialog), `reopen-closed.ts` (restoring) and `closed-scrollback.ts` (the files follow the lists: written when an entry joins the closed stack or the archive, removed when one leaves for good).
- Tests: `archive.test.ts`, `archive-actions.test.ts`, `archive-config.test.ts`, `auto-archiver.test.ts` (a clock that moves only by hand: a quiet tab is archived; a running command, a pinned tab, a favorite, recent output and the setting off are not), `archive-service.test.ts`, `library-entries.test.ts` and `e2e/library.spec.ts`.

## Not yet

Searching the text of the output, and sweeping the `scrollback` folder at start for files that no pane owns any more, arrive with a later task. Until then a file left by a crash stays on disk.
