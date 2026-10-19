# Deep links

A `noren://` link opens a folder in Noren, or runs one of the project actions declared in that folder. A link carries only the folder and, for an action, the id of the action. It never carries a command.

This page describes the format and what the interface does with a link. Registering the protocol with the system and delivering a link to a running Noren is a separate step (NOR-F5-07b); until then the interface entry point below is what that step calls.

## Forms

| Link                                  | What it does                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `noren://open?path=<folder>`          | Shows the space whose default folder is `<folder>`, or makes a new space with that folder.                   |
| `noren://action?path=<folder>&id=<a>` | The same space, then runs the action `<a>` declared in the `.noren/actions.json` of that folder (see below). |

Examples (the second encodes a space and an accent):

```
noren://open?path=/srv/proj
noren://open?path=C%3A%5CUsers%5CJo%C3%A3o%5CMeus%20Projetos
noren://action?path=/srv/proj&id=dev
```

## What a link may contain

- **Kinds.** Only the hosts `open` and `action`. The scheme and the host are case-insensitive, and one slash after the host is allowed (`noren://open/?path=...`).
- **Parameters.** `open` takes `path`; `action` takes `path` and `id`. Each is required, appears once and has a value. Any other parameter, whatever its name (`command`, `cmd`, `args`, `stop`, `run`, ...), refuses the whole link. So does a repeated parameter, an empty value, a fragment (`#...`) and any extra path after the host.
- **Values** are percent-decoded (`%20` is a space, `%C3%A9` is `é`). A `+` stays a plus sign. A bad percent sequence refuses the link.
- **Folder.** Must be absolute: a POSIX path (`/srv/proj`), a drive path (`C:\x` or `C:/x`) or a UNC path (`\\server\share`). It must not have a `..` segment (also when written `%2e%2e`), a control character, or more than 4096 characters.
- **Action id.** Surrounding spaces are trimmed (the actions file does the same). It must not be empty or have a control character.

A refused link shows the existing notice at the foot of the content area with the reason (`Link refused: the "action" link does not take the parameter "command"`) and changes nothing: no space is made, no file is read, nothing runs.

## Which space

The folder of a link is compared with the default folder of each space:

- `/` and `\` are the same separator, repeated separators count once, and a trailing separator does not count.
- Paths in the Windows style (a drive or a UNC path, on either side) compare without regard to case. POSIX paths compare exactly.
- When more than one space has the folder, the active one wins, else the first in the order of the switcher.

If no space has the folder, `open` and `action` make a new one with that folder (and one tab), named after the last segment of the folder, and show it. `open` never starts anything beyond that first tab.

## What `action` does

1. Finds the space for the folder (without changing anything yet) and reads `.noren/actions.json` from its default folder, or from the folder of the link when there is no space yet.
2. The id must be declared in that file. A missing file, an unreadable or invalid file, or an id the file does not declare shows a notice (`There is no action "x" in /srv/proj`) and stops: **no space is made and nothing runs.**
3. Shows (or makes) the space and hands the action to the same flow as the Start button ([ACTIONS.md](ACTIONS.md)). The first run of an action in a space asks first, showing the exact command from the file; an action already confirmed in that space with the same command runs at once. Cancel runs nothing.

The command that runs is always the one written in the project's file. Nothing in a link can change it.

## Entry point

The interface exposes one function for the code that receives links:

```ts
window.__norenHandleDeepLink(url: string): Promise<void>
```

It takes the raw text of the link, applies it as above and resolves when done; problems become notices, it does not reject. A value that is not text is ignored. A link that arrives before the interface has started is kept (up to 8) and applied as soon as it is ready.

In web mode and in tests, `window.__norenTest.openUrl(url)` calls the same entry point.

## Rules

- A link never runs anything on its own account: `open` runs nothing, and `action` can only start what the project's own file declares, after the first-run question.
- Treat a link like a click on a Start button of a project you may not know: read the project's file before you confirm the question.
