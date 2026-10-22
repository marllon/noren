# Project actions

A project can declare the commands you start and stop all the time (a dev server, a build watcher, a loop) in a file that lives with the project and is committed with it. Noren runs them in a named tab of the space.

The file is `.noren/actions.json`, inside the default folder of the space.

## Schema

```json
{
  "actions": [
    { "id": "loop", "label": "Loop", "command": "loop", "stop": "loop parar", "tab": "loop" },
    { "id": "dev", "label": "Dev server", "command": "pnpm dev", "tab": "dev" }
  ]
}
```

| Field     | Required | Meaning                                                                        |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `actions` | yes      | List of actions. It may be empty.                                              |
| `id`      | yes      | Identifier of the action. Unique in the file.                                  |
| `label`   | yes      | Name shown on the button.                                                      |
| `command` | yes      | Command line typed into the tab, followed by Enter.                            |
| `stop`    | no       | Command line that stops the action. Without it, stopping ends the tab's shell. |
| `tab`     | yes      | Name of the tab the action runs in.                                            |

Every text field must be a non-empty string (surrounding spaces are trimmed). Unknown fields are ignored.

A file that is not valid JSON, misses a field, has a field of the wrong type or repeats an `id` is refused as a whole. Noren reports why (for example `actions[1].tab: tab must be a string`, or `Duplicate action id "dev"`) and runs nothing from it.

## What the actions do

- **Run** shows the tab named by `tab` in the space, opening it first if it does not exist, and types `command` and Enter into it. If the action is already running, only the tab is shown.
- **Stop** with a `stop` command runs that command in a short process with no tab, in the default folder of the space; when it ends with code 0, the sessions of the tab end too. If it fails, the sessions stay and Noren shows why. Without `stop`, it ends the session of the tab.
- **Status** is _running_ while the session of the action's tab is alive, and _idle_ when there is no tab or its session has ended.

## In the interface

- **Space header.** The sidebar shows a header above the tabs, with the name of the space and one row per action: a running indicator, the label and a **Start** or **Stop** button. It shows only for the active space, and only when that space has a default folder and a valid file with at least one action. A missing, unreadable or invalid file shows no header and no error. The header follows the file: it appears, changes or goes away within about 2 seconds of the file changing. Only the folder of the active space is watched.
- **Tab menu.** The context menu of the tab an action runs in starts with **Run _label_** or **Stop _label_**.
- **Favorites bar.** The right click of an action row of the header offers **Add to favorites** (**Remove from favorites** when it is there), and the action gets a tile in the Favorites bar, shown in every space. A click on the tile runs the action through the same first-run question (**Show _label_** while it runs, which only shows its tab). The tile names the action by its space and its `id`: when the file of the space no longer declares that `id` (or the file is missing, not valid or unreadable, or the space lost its folder) the tile stays, dimmed, and a click says why and runs nothing, never another action of the file. The file of every space that has an action in the bar is watched like the one of the active space.
- **First run.** The first run of an action in a space asks first. The dialog shows the label and the exact command, and the stop command on a second line when there is one. **Cancel** (or Esc) runs nothing. The answer is remembered per space and action, together with the confirmed text: if the file later changes the `command` or the `stop`, Noren asks again. Changing only the label or the tab does not. Stopping never asks. The answer is kept in the browser storage of the app under `noren.ui.actionConsent` until the settings file (NOR-F8-01) takes it over.
- **Links.** A `noren://action?path=<folder>&id=<id>` link runs an action of the file through the same first-run question; see [DEEP_LINKS.md](DEEP_LINKS.md).
- **Web mode and tests.** The web build reads the file texts from the browser storage key `noren.web.actions`, a JSON object from folder to text, so tests can seed a file before the page loads and change it while it runs.

## Where the file is read and how stop runs

- **Reading.** The file is read from `.noren/actions.json` inside the default folder of the space, through the backend (`readActionsFile`): the desktop app reads the disk; the web build and the tests read an in-memory file. A folder with no file (or no `.noren` folder) simply has no actions. A file that cannot be read for another reason (a folder in its place, no permission) is reported as unreadable, with the reason. Bytes that are not valid UTF-8 are replaced, so such a file is reported as invalid instead of failing the read.
- **Reload.** Noren reads the file again every 2 seconds (`ACTIONS_POLL_MS`) while a space is being watched, by polling: no file-watcher dependency. It reports the file when it is first read and after that only when its text changes, including when it appears, disappears, turns invalid or becomes valid again. The next read starts only after the previous one ended, and stopping the watcher drops a read in flight. A change shows up within about 2 seconds.
- **Stop.** The `stop` command runs through the system shell (`cmd /S /C` on Windows, `sh -c` elsewhere) in the default folder of the space, as a short process with no tab: no terminal, no window, and its output is discarded. A code of 0 means the action was stopped; any other code is reported as an error naming the command and the code. A command that is still running after 30 seconds is killed, together with the processes it started, and reported as an error. A space with no default folder cannot run a `stop` command.

The tab is followed by identity, not by name: once Noren opened it for an action, renaming the tab does not detach it from the action. After a restart Noren finds the tab again by its title.

## Rules

- Noren never runs a command that is not written in the file. The `command` and `stop` strings are the only things an action can execute; nothing is built from other input (a link, a pasted text, an AI suggestion).
- Commands run with the permissions of your user, as if you had typed them. Read the file before trusting a project, as you would a script.
- Noren never edits the file.
