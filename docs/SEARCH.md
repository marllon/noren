# Search over all tabs

Ctrl+Shift+Alt+F answers "in which tab did that output appear?": one search box over the text of every open tab of every space. The key is the action **Search all tabs** (`tab.search-all`) of the registry (`apps/desktop/src/keybindings.ts`, both presets), so it shows in the shortcuts screen, can be recorded like any other, and is listed in the command palette. See [KEYBINDINGS.md](KEYBINDINGS.md) and [PALETTE.md](PALETTE.md).

The matching is pure and lives in `apps/desktop/src/tab-search.ts`; `TabSearch.tsx` draws the panel; `App.tsx` reads the terminals and carries out the pick.

## What it searches

- The buffer of every terminal, scrollback included (up to 10 000 lines each), of every pane of every open tab, in the order of the sidebar. The text is read once, when the search opens, so output that arrives while it is open is not in the list.
- A line matches when it contains the query, ignoring case. The query is taken literally (no pattern characters); spaces around it are ignored; a blank query lists nothing.
- A match never spans two buffer rows: a long line the shell wrapped over two rows is two lines for the search.
- At most 50 lines per tab and 500 in all, from the top of each buffer down. When a cap cuts matches off, the tab shows a `+` after its count and the panel says "Showing the first matches only. Narrow the search."

## The panel

`data-nr-part="tab-search"`, a modal dialog with the box on top and the results below, grouped by tab (a header with the tab name, its space and the number of lines). Each line is a row (`role="option"`) with:

- `data-nr-item-id`: the tab;
- `data-nr-pane-id`: the pane of the tab the line is in;
- `data-nr-line`: the line number, counting from 1 at the top of the scrollback;
- the line number and the line text, with the matched text marked.

It uses only the `--nr-*` tokens.

## Keyboard

- The box takes the keyboard when the panel opens. Up and Down move the selection (it wraps), Enter goes to the selected line, Escape closes without going anywhere. A click on a row goes to it; a click outside closes.
- While the box has the keyboard no shortcut acts (the text-field guard of the keyboard listener), so Ctrl+Shift+D or Ctrl+Shift+P in it do nothing.
- Opening the search closes the palette, and the other way round.
- Closing it, by a pick or by Escape, gives the keyboard back to the terminal.

## Going to a line

Enter (or a click) closes the panel, shows the space that owns the tab and then the tab (the same path as a Favorites tile or the palette), focuses the pane the line is in (which ends a zoom on another pane) and calls `revealLine(row)` of that terminal: it scrolls the buffer so the row sits in the middle of the view and selects the whole line (`term.scrollToLine` and `term.select`), so it shows with the terminal's selection color. Nothing is typed into the shell. The terminal of a tab that was hidden has no size until it shows, so the call is made after the render and once more on the next frame.

The selection is the terminal's own: it is replaced by the next click or selection, and Ctrl+Shift+C copies it.

In web mode the test hook (`window.__norenTest`) reads the result with `selection()` (text selected in the active terminal) and `viewport()` (first buffer row in view and the rows in view).
