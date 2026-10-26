# Project actions

A project can declare the commands you start and stop all the time (a dev server, a build watcher, a loop) in a file that lives with the project and is committed with it. Noren runs them in a named tab of the space.

The file is `.noren/actions.json`, inside the default folder of the space.

## Schema

```json
{
  "actions": [
    {
      "id": "loop",
      "label": "Loop",
      "command": "loop",
      "stop": "loop parar",
      "stopWaits": true,
      "tab": "loop"
    },
    { "id": "dev", "label": "Dev server", "command": "pnpm dev", "tab": "dev", "main": true }
  ]
}
```

| Field       | Required | Meaning                                                                        |
| ----------- | -------- | ------------------------------------------------------------------------------ |
| `actions`   | yes      | List of actions. It may be empty.                                              |
| `id`        | yes      | Identifier of the action. Unique in the file.                                  |
| `label`     | yes      | Name shown on the button.                                                      |
| `command`   | yes      | Command line typed into the tab, followed by Enter.                            |
| `stop`      | no       | Command line that stops the action. Without it, stopping ends the tab's shell. |
| `stopWaits` | no       | `true` leaves the shell of the tab to end on its own after `stop` (see below). |
| `tab`       | yes      | Name of the tab the action runs in.                                            |
| `main`      | no       | `true` marks the action the one-line block of the space runs (see below).      |

Every text field must be a non-empty string (surrounding spaces are trimmed); `main` and `stopWaits` must be `true` or `false`. Unknown fields are ignored.

A file that is not valid JSON, misses a field, has a field of the wrong type or repeats an `id` is refused as a whole. Noren reports why (for example `actions[1].tab: tab must be a string`, or `Duplicate action id "dev"`) and runs nothing from it.

## What the actions do

- **Run** shows the tab named by `tab` in the space, opening it first if it does not exist, and types `command` and Enter into a pane of it that runs nothing else (a new tab, or a free pane of the tab). That pane is the pane of the action. If the action is already running, only its pane is shown.
- **Stop** with a `stop` command runs that command in a short process with no tab, in the default folder of the space; when it ends with code 0, the session of the pane of the action ends too. If it fails, the session stays and Noren shows why. Without `stop`, it ends the session of the pane. The other panes of the tab are left alone.
- **Stop now** ends the session of the pane of the action at once, without running the `stop` command. It is what a click on a _stopping_ action offers (see below).
- **Status** is _running_ while the pane of the action exists and its session is alive, _stopping_ while it is alive and the action waits for it to end (see below), and _idle_ otherwise. It follows the pane, not the tab: closing the pane, or its session ending, makes the action idle even when the tab stays open with other panes. A pane made by splitting another does not take its action or its name.

### The pane of an action

The pane of an action is the first of these that exists:

1. The pane **Run** typed the command into. Noren keeps it in memory only; moving the pane to another tab or merging tabs does not change it.
2. A terminal pane of **any space** whose running command is the `command` of the action, as the shell reports it (the shell integration's command line; see [SHELL_INTEGRATION.md](SHELL_INTEGRATION.md)), with surrounding spaces trimmed and runs of spaces collapsed. This is how a command typed by hand lights the action, and how the action is found again after a restart: nothing about it is saved in `state.json`. A pane that is the pane of another action is not taken. With the command running in more than one pane, the pane that **Run** typed the command into wins, else the one seen running it last, so **Stop** acts on the most recent.

Noren does not look at the process tree for this: it only identifies agents, and it cannot tell one loop from another. A shell without the integration (cmd) reports no command line, so a command typed there lights nothing; an action that **Run** started is still followed by its pane.

## A stop that waits

Some actions stop in two steps: the `stop` command asks the program to finish (a loop that ends after its current round, a server that drains its requests), and the program then ends its own shell. With `"stopWaits": true` Noren waits for that instead of closing the shell of the pane under it.

- **Stop** runs the `stop` command as always. When it ends with code 0 the session of the pane of the action stays, and the status is _stopping_ until that session has ended on its own; then it is _idle_, and the next start runs in a free pane of the tab or a new tab. If the `stop` command fails, the action stays _running_ and Noren shows why, as without the field.
- **Stopping** shows in the Projects section as an amber dot, an hourglass and the word _Stopping_ on the button of the action (the dot of a closed block is amber when nothing runs but an action is stopping, and lit as usual while some other action runs). The tab, its terminal and the tile of the action in the Favorites bar stay as they are; a click on the tile still only shows the tab.
- **Stop now.** A click on the button of a _stopping_ action opens a small menu with **Stop now**, which ends the session of the pane at once, as a plain stop does, without running the `stop` command again. The context menu of the tab offers **Stop _label_ now** in the same state. Stopping an action that is already stopping does nothing.
- Without a `stop` command the field has no effect: stopping ends the shell of the pane at once. Without the field, or with `"stopWaits": false`, stopping works as described above.

## In the interface

- **Projects section.** The sidebar shows a section above the tabs with one block for each space that has a default folder and a valid file with at least one action, in the order of the space switcher (not only the space on screen). A closed block is one row: a state dot (lit while any action of the space runs), the name of the space and the **Start** or **Stop** button of its main action: the first action marked `"main": true`, else the first action of the file. A click on the name opens the block, which lists the other actions, each with its own button; another click closes it. Whether a block is open is kept per space in `state.json` (`projectsOpen`). A button works on the space of its block and does not change the space on screen: the tab named by `tab` is opened in that space when it is missing and made the tab that space shows, and the command is typed there. The first run still asks, as below. The space on screen is drawn lit. A missing, unreadable or invalid file, and a file with no action, give no block and no error. The file of every listed space is read again about every 2 seconds, so a block appears, changes or goes away within about 2 seconds of its file changing. The menu of a space has **Show in Projects** (on by default): turning it off takes the space out of the list (`inProjects: false` in `state.json`) and its file is no longer read for it.
- **Tab menu.** The context menu of the tab an action runs in starts with **Run _label_** or **Stop _label_**.
- **Favorites bar.** The right click of an action row of the Projects section (the line of a block, or a row of an open block) offers **Add to favorites** (**Remove from favorites** when it is there), and the action gets a tile in the Favorites bar, shown in every space. A click on the tile runs the action through the same first-run question (**Show _label_** while it runs, which only shows its tab). The tile names the action by its space and its `id`: when the file of the space no longer declares that `id` (or the file is missing, not valid or unreadable, or the space lost its folder) the tile stays, dimmed, and a click says why and runs nothing, never another action of the file. The file of every space that has an action in the bar is watched like the one of the active space.
- **First run.** The first run of an action in a space asks first. The dialog shows the label and the exact command, and the stop command on a second line when there is one. **Cancel** (or Esc) runs nothing. The answer is remembered per space and action, together with the confirmed text: if the file later changes the `command` or the `stop`, Noren asks again. Changing only the label or the tab does not. Stopping never asks. The answer is kept in the browser storage of the app under `noren.ui.actionConsent` until the settings file (NOR-F8-01) takes it over.
- **Links.** A `noren://action?path=<folder>&id=<id>` link runs an action of the file through the same first-run question; see [DEEP_LINKS.md](DEEP_LINKS.md).
- **Web mode and tests.** The web build reads the file texts from the browser storage key `noren.web.actions`, a JSON object from folder to text, so tests can seed a file before the page loads and change it while it runs.

## Where the file is read and how stop runs

- **Reading.** The file is read from `.noren/actions.json` inside the default folder of the space, through the backend (`readActionsFile`): the desktop app reads the disk; the web build and the tests read an in-memory file. A folder with no file (or no `.noren` folder) simply has no actions. A file that cannot be read for another reason (a folder in its place, no permission) is reported as unreadable, with the reason. Bytes that are not valid UTF-8 are replaced, so such a file is reported as invalid instead of failing the read.
- **Reload.** Noren reads the file again every 2 seconds (`ACTIONS_POLL_MS`) while a space is being watched, by polling: no file-watcher dependency. It reports the file when it is first read and after that only when its text changes, including when it appears, disappears, turns invalid or becomes valid again. The next read starts only after the previous one ended, and stopping the watcher drops a read in flight. A change shows up within about 2 seconds.
- **Stop.** The `stop` command runs through the system shell (`cmd /S /C` on Windows, `sh -c` elsewhere) in the default folder of the space, as a short process with no tab: no terminal, no window, and its output is discarded. A code of 0 means the action was stopped; any other code is reported as an error naming the command and the code. A command that is still running after 30 seconds is killed, together with the processes it started, and reported as an error. A space with no default folder cannot run a `stop` command. With `"stopWaits": true`, a code of 0 leaves the session of the pane alone and the action waits for it to end (see [A stop that waits](#a-stop-that-waits)).

The tab is followed by identity, not by name: once Noren opened it for an action, renaming the tab does not detach it from the action. After a restart Noren finds the tab again by its title, and the pane of the action by the command it runs.

The pane that Noren opens for an action is named after the action: its `label` is the **name of the pane**, shown in bold before the folder in the header of the pane and on its row in the sidebar. The name belongs to the pane, so it stays with the pane when the tab is merged into a split of another tab and when the pane is taken out of it again, and it is kept in `state.json`. Renaming the pane (F2 on its row, or **Rename pane** in its menu) changes only that name: the action still finds its tab by the title of the tab. A tab that already exists keeps the name its pane has.

## Rules

- Noren never runs a command that is not written in the file. The `command` and `stop` strings are the only things an action can execute; nothing is built from other input (a link, a pasted text, an AI suggestion).
- Commands run with the permissions of your user, as if you had typed them. Read the file before trusting a project, as you would a script.
- Noren never edits the file.
