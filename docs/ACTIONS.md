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
- **Stop** with a `stop` command runs that command in a short process with no tab, in the default folder of the space. Without `stop`, it ends the session of the tab.
- **Status** is _running_ while the session of the action's tab is alive, and _idle_ when there is no tab or its session has ended.

The tab is followed by identity, not by name: once Noren opened it for an action, renaming the tab does not detach it from the action. After a restart Noren finds the tab again by its title.

## Rules

- Noren never runs a command that is not written in the file. The `command` and `stop` strings are the only things an action can execute; nothing is built from other input (a link, a pasted text, an AI suggestion).
- Commands run with the permissions of your user, as if you had typed them. Read the file before trusting a project, as you would a script.
- Noren never edits the file.
