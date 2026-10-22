# Accessibility

Noren is meant to be usable with a keyboard and a screen reader. Two kinds of check hold that, and
they are not the same thing:

- **Automated** (every change): axe-core runs in the end-to-end tests on every screen, panel, pane,
  menu and dialog and fails on a violation of any impact. It finds missing names, bad roles, low
  contrast and the like. It cannot say what a screen reader actually reads, in what order, or
  whether it is pleasant to use. See [What the automated tests cover](#what-the-automated-tests-cover).
- **Manual** (before a release, and after a change to a screen): a person walks the script below with
  a real screen reader on Windows (NVDA and Narrator) and writes down what was read. This file is
  that script. No automated run does it: it needs a visible window and a screen reader running, and
  the project's loop never opens one.

Related: the setting and the announcements are described in
[Screen reader support in ARCHITECTURE.md](ARCHITECTURE.md#screen-reader-support); the setting itself in
[CONFIG.md](CONFIG.md#the-terminal); the keys in [KEYBINDINGS.md](KEYBINDINGS.md).

## What the automated tests cover

`e2e/axe-fixture.ts` holds one helper, `expectNoAxeViolations(page, surface)`. It runs every default
rule of axe-core on the whole page, disables no rule and excludes nothing, and fails with the rule, the
nodes and the reason of each violation. Each test opens the surface the way a user does (shortcut,
palette, click or menu) and runs it:

| Surface                                                                                                                      | Test file                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The five screens, the palette, the shortcuts screen                                                                          | `accessibility.spec.ts`                                                                                                    |
| Each section of the settings                                                                                                 | `accessibility-settings.spec.ts`                                                                                           |
| The column of sections and the search of the settings, in each section, the dark and the light theme, English and Portuguese | `settings-nav.spec.ts`                                                                                                     |
| Menus, dialogs, search, switchers, peek, quick panel                                                                         | `accessibility-overlays.spec.ts`                                                                                           |
| Ask panel (empty, preview, answer, failure, no provider)                                                                     | `ask-panel.spec.ts`                                                                                                        |
| Agents panel                                                                                                                 | `agents-panel.spec.ts`                                                                                                     |
| Bench scoreboard, recommended models, providers, gallery, Sync                                                               | `bench.spec.ts`, `models.spec.ts`, `ai-providers.spec.ts`, `settings-gallery.spec.ts`                                      |
| Sync (git and Gist)                                                                                                          | `settings-sync.spec.ts`, `sync-gist.spec.ts`                                                                               |
| Plugin panel                                                                                                                 | `plugin-panel.spec.ts`                                                                                                     |
| Library                                                                                                                      | `library.spec.ts`                                                                                                          |
| Browser, diff and preview panes                                                                                              | `browser-pane.spec.ts`, `diff-pane.spec.ts`, `preview-pane.spec.ts`, `preview-output.spec.ts`                              |
| Favorites bar (empty, with favorites, its menus), project actions header, live groups                                        | `favorites-bar.spec.ts`, `favorites.spec.ts`, `favorites-links.spec.ts`, `project-actions.spec.ts`, `live-groups*.spec.ts` |
| Quick terminal window, other windows                                                                                         | `quick-window.spec.ts`, `window-sidebar.spec.ts`, `window-panes.spec.ts`, `window-browser.spec.ts`                         |

Run them with `pnpm e2e` (all) or `pnpm exec playwright test -c e2e/playwright.config.ts -g axe`
(only the axe tests, after `pnpm --filter @noren/desktop build`).

What axe cannot see, and so is left to the script below:

- The **content of the sandboxed frame of a plugin panel**. The frame allows no script, so axe cannot
  enter it (the test checks the page around it and the frame element, and axe reports the inside as
  "not tested"). The content is the plugin's own; a plugin author is responsible for it.
- What a screen reader **says** for a control, a dialog or a live region, and in what order.
- Real **focus** behaviour in the Tauri window (a browser pane's native web view lies over the page
  and has its own accessibility tree).
- The **pixels** of the native window: the system-painted effect behind the window, high-contrast
  themes of Windows, and the terminal canvas (xterm's own `.xterm-accessibility` tree is what a
  screen reader reads there, and only with the screen reader mode on).

## Before you start

You need Windows 10 or 11, the Noren build you want to check (an installer or `pnpm desktop:build`),
and a way to write down results. Test with **both** screen readers, because they differ:

- **NVDA** (free, <https://www.nvaccess.org/>): start it, then `Insert+N` opens its menu. Use the speech
  viewer (Tools, Speech viewer) so you can read what it said afterwards. Browse mode and focus mode
  switch with `Insert+Space`; Noren is mostly focus-mode territory (a terminal, a tree, dialogs).
- **Narrator** (built in): `Win+Ctrl+Enter` starts and stops it. `Caps Lock` is the Narrator key by
  default. Turn on "Show Narrator's captions" if you want the text on screen.

Set up once:

1. Start Noren with a clean profile (a new config folder) so the defaults are the defaults. Keep the
   **safe** keybinding preset.
2. Leave **Screen reader mode** off for scenarios 1 to 3 and 5 to 11, and turn it on for scenario 4.
3. Use the English interface for the first pass. Repeat scenarios 1, 5 and 6 with the language set to
   Brazilian Portuguese; the words should be Portuguese everywhere and nothing should fall back to
   English.
4. Make a few things to walk through: two spaces, a pinned tab, a group with two tabs, a tab split in
   two panes, one finished command that failed (`false`), and one that succeeded.

For every step the **Expect** column says what the screen reader should read. It is the meaning that
counts, not the exact wording: write down what was read when it differs in a way that would confuse a
person, when nothing is read, when the wrong thing is read, or when the focus is somewhere you cannot
see or hear.

## Script

### 1. The window and its landmarks

| Step                                                       | Expect                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Start Noren.                                               | The window title is read. The first focus is the terminal, announced as a region named "Terminal".       |
| Walk the landmarks (NVDA: `D`; Narrator: `Caps+Ctrl+D`).   | A "Sidebar" complementary region, a "Content" region, the terminal region. No two with the same name.    |
| Walk the headings (NVDA: `H`; Narrator: `H` in scan mode). | One level-one heading (the window title), then the headings of whatever is open, never skipping a level. |
| Walk the buttons.                                          | Each is named by what it does: "New tab", "New space", "Settings", "Pane menu". None is "button" only.   |

### 2. The sidebar, spaces and tabs

| Step                                                          | Expect                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Focus the sidebar (palette: "Focus sidebar").                 | A tree named "Tabs"; the current row is read with its name, its level and its place ("2 of 5").     |
| Arrow Up and Down.                                            | Each row is read by its title; the folder, branch and last command are read as its description.     |
| Arrow Right on a group; Arrow Left to fold it.                | "Expanded" or "collapsed" is read; a group says how many tabs it holds.                             |
| Arrow Right on a split tab.                                   | Its panes are listed as rows; each says it is a pane, which tab it belongs to and its place.        |
| Press Enter on a tab.                                         | The tab is shown, the focus goes to its terminal, and the **announcement** "Tab _name_" is read.    |
| Move to the "Spaces" navigation and press a space button.     | The space is shown; "Space _name_, tab _name_" is read; the current space is read as current.       |
| Open the context menu of a tab (`Shift+F10` or the Menu key). | A menu is read; each item is read with its name; Escape closes it and the focus returns to the row. |

### 3. Dialogs and confirmations

For each: open it, listen, press Tab through all of it, close it with Escape, and check where the
focus lands.

| Dialog                                       | Open with                               | Expect                                                                                                         |
| -------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| New space                                    | The "New space" button                  | A dialog named "New space"; the first field is focused and read with its label; Create and Cancel are buttons. |
| Edit space, Background image                 | The space's menu                        | A dialog with its title; every field has a label.                                                              |
| Close a tab that is running a command        | The close shortcut on a busy tab        | An alert dialog; its message is read at once; the focus starts on **Cancel**.                                  |
| Paste of several lines                       | Paste a few lines in the terminal       | An alert dialog that says what will be pasted; Cancel is focused.                                              |
| Open link                                    | Click a link in the output              | An alert dialog that reads the address; Cancel is focused.                                                     |
| Ask the AI for a command (with AI turned on) | The palette                             | A dialog with a labelled question field; nothing runs until you press Enter in the terminal.                   |
| Worktrees, project action confirmation       | The palette; the project actions header | Dialog with its title; the exact command is read in the message before the buttons.                            |

Escape closes each one. Focus returns to the element that opened it, or to the terminal.

### 4. The terminal and the screen reader mode

| Step                                                                                            | Expect                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| With the mode **off**, type `echo hello` and Enter.                                             | The screen reader reads little or nothing of the terminal output. This is expected; it is why the mode exists.                                                                                                 |
| Settings, Terminal: tick **Screen reader mode**. (Or the palette: "Toggle screen reader mode".) | "Screen reader mode is on." is read in the notice line. The running shell is not restarted.                                                                                                                    |
| Type `echo hello` and Enter again.                                                              | The typed line and the output are read as they arrive. Use the review cursor (NVDA: numpad or laptop keys; Narrator: `Caps+Left/Right`) to read the lines above: the text of the screen is there line by line. |
| Run a long output (`ls` of a big folder).                                                       | The screen reader keeps up, or at least stays usable; write down any freeze longer than a second.                                                                                                              |
| Toggle the mode off again.                                                                      | "Screen reader mode is off." is read; the terminal still works.                                                                                                                                                |

### 5. Announcements

These come from one live region and are read whatever the mode is. Keep the terminal focused.

| Step                                                                            | Expect                                                                                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Switch tab with `Alt+1..9` or `Ctrl+Tab`.                                       | "Tab _name_" is read (polite: it waits if the screen reader is speaking).                                               |
| Switch space with `Ctrl+Alt+1..9`.                                              | "Space _name_, tab _name_".                                                                                             |
| Run `true` in a shell with integration, then `false`.                           | "Command finished" or "with exit code 0"; for `false` "Command finished with exit code 1" **interrupting** (assertive). |
| Print a bell (`printf '\a'`) in a tab that is not shown, then in the shown one. | "Bell in _name_".                                                                                                       |
| Type `exit` in a tab.                                                           | "Session ended in _name_ with exit code 0".                                                                             |
| Trigger the bell many times in a row (`yes $'\a' \| head -50`).                 | It is said once, not fifty times.                                                                                       |
| With sync set up, run "Pull settings" and "Push settings" from the palette.     | The result is read once (not twice).                                                                                    |

An announcement that is still there after about ten seconds is a bug: the region is emptied on purpose.

### 6. The command palette

| Step                                       | Expect                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `Ctrl+Shift+P`.                            | A dialog with a combo box named "Command palette", focused. The first option is read as selected. |
| Type a few letters.                        | The number of results is read, or each option as the selection moves with Up and Down.            |
| Prefix `>` (commands), then `@` (tabs).    | The kind of result is read with the option (command, tab, theme…).                                |
| Enter on a command; Escape on another try. | Enter runs it and the palette closes; Escape closes it and the focus returns to the terminal.     |

### 7. The settings screen

| Step                                               | Expect                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Settings (button or palette "Open settings"). | A dialog named "Settings"; the keyboard is on the first control (the search box, "Search settings"); a button named "Close" is at the top right, and no button says Save or Cancel (the line at the bottom reads "Every change is saved as you make it."). |
| Tab to the column of sections.                     | A navigation named "Settings sections", one stop for Tab on the current section (read as current). Up and Down move between the buttons, Enter or Space shows the section and the keyboard lands on its heading.                                           |
| Type a word in the search.                         | The sections and the rows without it go away from the column and the page; with no match, "No setting matches ..." is read as a status. Esc empties the box first.                                                                                         |
| Walk each section with headings or regions.        | Every section is a region with its own name ("Appearance", "Terminal options", "AI", "Sync"…).                                                                                                                                                             |
| Tab through the fields of Terminal and AI.         | Every field has a name that includes its visible text; selects say their value; a row of buttons (Cursor shape) is a group of radio buttons that the arrow keys move.                                                                                      |
| Space on a switch (Cursor blinks, Pane headers).   | "On" or "off" is read for the switch, named by its label and described by its explanation; a switch that cannot be used now (Keep sidebar open) is read as unavailable.                                                                                    |
| Arrows, Home, End on a slider (Font size).         | The value is read with its unit ("14 px", "55%") and the number in the box beside it changes with it; the handle never goes past the range, and a value typed past it is read as an error on the box.                                                      |
| In Profiles, add an SSH profile and press Choose.  | The button is named for its field ("Choose a file for “Key file (optional)”"); closing the chooser leaves the focus on the button; a chooser that cannot open is read as an alert under the field.                                                         |
| Enter a wrong value (a font size of `abc`).        | The error is read next to the field (`aria-invalid` and its message).                                                                                                                                                                                      |
| In AI, press "Store key" with an empty box.        | "Paste the key in the box first." is read. The key, once stored, is never read back.                                                                                                                                                                       |
| Escape.                                            | The dialog closes; the focus returns to where it was.                                                                                                                                                                                                      |

### 8. Splits and panes

| Step                                               | Expect                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Ctrl+Shift+D` (split right), then `Ctrl+Shift+E`. | The new pane gets the focus. Each terminal region is now named "Terminal 1 of 3", "2 of 3"…            |
| `Alt+Arrow` to move between panes.                 | The pane's name is read when it gets the focus.                                                        |
| `Ctrl+Shift+Z` to zoom a pane, again to restore.   | The zoom is not announced by the screen reader on its own; check that the focus stays in the terminal. |
| The pane menu button (with pane headers on).       | "Pane menu"; a menu with Close, Zoom, Detach and the like, each named.                                 |
| Resize with `Ctrl+Shift+Alt+Arrow`.                | The separator is a separator; resizing by keyboard works. Write down if it says nothing.               |
| Close a pane with `Ctrl+Shift+W`.                  | The focus goes to a remaining pane, not to nowhere.                                                    |

### 9. Panels

Open each by its shortcut or the palette. Each must open with the focus inside it, be read as a
named region or dialog, be closable with Escape and give the focus back.

| Panel           | Open with          | Expect                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask             | `Ctrl+Shift+A`     | A complementary region "Ask"; the question box is focused; the chips ("Selection", "Last output", "Screen", "@ Tab") say whether they are pressed; the preview is a region and is read in full before Send; an answer's headings follow the panel's title; an error is read as an alert. |
| Agents          | `Ctrl+Shift+Alt+G` | A dialog "Agents"; each row is a button whose name starts with what is shown: "_agent_, _state_, _time_, _tab_ in _space_, _last line_. Go to it."; Enter goes to that agent's pane.                                                                                                     |
| Library         | `Ctrl+Shift+Alt+L` | A dialog "Library" with two tabs (Archive, Closed), a search box, a list per tab; each row's button is "Restore _title_ _folder_ _space_ · _when_"; a delete button per row asks first.                                                                                                  |
| Search all tabs | `Ctrl+Shift+Alt+F` | Combo box and a list of matches; the number of matches is read.                                                                                                                                                                                                                          |
| Peek, switcher  | `Ctrl+Tab`         | A list of recent tabs; the selection is read as it moves; releasing Ctrl chooses it.                                                                                                                                                                                                     |
| Quick terminal  | ``Ctrl+` ``        | A window "Quick terminal" with one terminal and a "Promote to tab" button; Escape hides it.                                                                                                                                                                                              |

### 10. The sections with data

In Settings, check these with something in them (see the e2e fixtures for data you can mimic):

| Section | Expect                                                                                                                                                                                                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI      | Ollama's models are a list; each provider is a group with its key state ("No API key is stored" / "An API key is stored in the keychain") and "Test connection to _id_". The bench scoreboard and the recommended models are tables with column headers; the install question shows the exact command and focuses **Cancel**. |
| Gallery | Each item is a row with its kind, version and state ("Not installed", "Update available", "Up to date"); the button is "Install _name_" / "Update _name_"; a failure is read as a status on the row.                                                                                                                          |
| Sync    | The method list ("Sync through"), the remote or gist boxes with labels, "Connect", "Pull", "Push"; status and notes are read when they change; a conflict lists the paths. The token box is a password box and never reads its content.                                                                                       |

### 11. Panes that are not terminals, and plugin panels

| Pane / panel                                              | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview pane (Ctrl+click a path in the output)            | A group "File preview" whose heading is the path; the contents are a region named "Contents of _file_" that can be scrolled with the keyboard; a refusal ("There is no file at this path.") is read. A picture has a text alternative.                                                                                                                                                                                                                                                                                                                                       |
| Diff pane (palette: "Show the git diff beside this pane") | A list of files (buttons that say which file and its change); the picked file is a table; added and removed lines are told by words or a prefix, not by color alone.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Browser pane (Ctrl+click a web address)                   | A group "Web page" with an address box named "Address"; a refused address is read as an alert. The page itself is a native web view; it has its own accessibility tree: check that Tab moves into it and out of it.                                                                                                                                                                                                                                                                                                                                                          |
| Plugin panel                                              | A heading with the panel's title and the plugin's name; the sandboxed frame has a title; Escape closes it. The content of the frame is the plugin's (axe cannot enter it); read it once for sense.                                                                                                                                                                                                                                                                                                                                                                           |
| Favorites bar                                             | A region "Favorites" ("Favoritos"), always there; empty, it reads one line that says how to add a favorite; with favorites, buttons named by the tab's title, the one on screen read as current; a profile is "New _name_ tab", an action "Run _name_" ("Show _name_" while it runs). A profile the computer lost or an action its file dropped is `aria-disabled` and described by its reason; it stays focusable and a click says the reason in the notice line. Its menus (the right click, the menu key or Shift+F10) say "Add to favorites" or "Remove from favorites". |
| Project actions header                                    | A region "Project actions"; "Start _action_" / "Stop _action_"; a running action is told by words, not only by an indicator.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Other windows (drag a tab out)                            | The window has its own "Window sidebar" and "Window terminal"; New tab works; closing the last tab closes the window.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### 12. Contrast and zoom (look, do not listen)

- Turn on **High contrast** in Windows (Settings, Accessibility, Contrast themes) and check that text,
  focus rings and the active tab stay visible.
- Zoom the window to 200% (`Ctrl+=` three times raises the terminal font; use the Windows scale for the
  interface) and check that nothing overlaps and the dialogs stay reachable.
- Check the focus ring on every control: it must be visible against both the light and the dark theme.

## Reporting

For each run write: the date, the Noren version (the installer name has it), Windows version, NVDA
and Narrator versions, and a table:

| Scenario | Step | Reader | Read | Expected | Verdict (ok / confusing / missing / wrong) |
| -------- | ---- | ------ | ---- | -------- | ------------------------------------------ |

A "missing" or "wrong" row becomes an issue in the project's tracker, with the scenario and step
number. If the cause is something axe could have found, add an axe test for that surface so the
problem cannot come back; if axe could not have found it, add a line to the script above so the next
person checks it.

## For people changing a screen

- Name every control, and start the name with the visible text (axe's `label-content-name-mismatch`
  and WCAG 2.5.3): a person who says the button's name should say what they see.
- A heading does not skip a level. The window title is the level-one heading; a panel's title is a
  level two; an answer's Markdown headings start at three (see `Markdown.tsx`); a question asked inside
  a settings section takes that section's level.
- Landmarks and regions have names that differ from each other (a split terminal is "Terminal 2 of 3",
  a window's own sidebar is "Window sidebar").
- A dialog is a `div` with `role="dialog"` or `alertdialog`, `aria-modal` and a name; a form goes
  inside it (a `form` may not carry the role). It focuses its safe button when it asks.
- Muted text on a tinted row (hover, selected, active) is pulled toward the text color so it stays at
  4.5:1.
- Add the axe test with the screen: open it the way a user does, in each state (empty, with data, with
  an error), and call `expectNoAxeViolations`. Never disable a rule or exclude an element to make it
  pass.
