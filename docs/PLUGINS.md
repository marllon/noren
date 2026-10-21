# Plugins

A plugin is a small JavaScript program that adds things to Noren without being part of it. It can put an action in the command palette, ask for a new tab, read the output of a terminal and show a panel of its own. It runs apart from the page, starts with no power at all, and can do only what its `plugin.json` asks for and the app answers yes to.

This is plugin API version 1 (`apiVersion: 1`). It is pre-alpha: the surface is small on purpose and may grow, never silently (a plugin states the version it speaks and a build that does not speak it answers `unsupported_version`).

- [A plugin on disk](#a-plugin-on-disk)
- [`plugin.json`](#pluginjson)
- [Permissions](#permissions)
- [Protocol v1](#protocol-v1)
- [The methods](#the-methods)
- [Events the app sends](#events-the-app-sends)
- [The panel](#the-panel)
- [Limits](#limits)
- [Isolation](#isolation)
- [When a plugin fails](#when-a-plugin-fails)
- [The example](#the-example)

## A plugin on disk

Plugins live in the folder `plugins/` next to `config.jsonc`. Each plugin is a folder, and the **name of the folder is the `id` of the plugin**:

```
plugins/
  new-tab-action/
    plugin.json
    main.js
```

The app reads the folder when it starts (it does not watch it: restart to pick up a change) and never creates it. A folder that is not a plugin is listed as invalid with a short reason and the others go on. Rules for what is read:

- `plugin.json` and the file `main` names are read as UTF-8 text, at most 256 KiB each.
- At most 50 folders are listed; files directly in `plugins/` and names starting with a dot are left out.
- `main` must be a relative path inside the plugin's folder: no `..`, no leading `/` or `\`, no drive or `:`, no control characters, no Windows device name (`con`, `aux`, ...). A link that leaves the folder is refused, for `main` and `plugin.json` alike.

## `plugin.json`

```json
{
  "id": "new-tab-action",
  "name": "New tab action",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "main.js",
  "permissions": ["palette.actions", "tabs.create", "panel"]
}
```

| Field         | Rule                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `id`          | Characters `a-z`, `0-9` and `-`, up to 32. Must equal the name of the folder.                             |
| `name`        | Text, 1 to 64 characters, no control characters. Shown as `Plugin · <name>` in the palette.               |
| `version`     | Three numbers, like `1.2.0` (an optional `-pre` or `+build` suffix), up to 32 characters.                 |
| `apiVersion`  | `1`, the only version there is.                                                                           |
| `main`        | The script of the plugin, a path inside its folder (see above), up to 256 characters.                     |
| `permissions` | A list of the permissions below, with no repeats. An empty list is valid: the plugin can do nothing then. |

A field that is not in the table is an error, not ignored. The app tells which field is wrong (`permissions.2: permission tabs.create is listed twice`).

## Permissions

A method works only if the manifest holds its permission. Asking for more than a plugin needs is the first thing to cut.

| Permission        | Opens                                                         |
| ----------------- | ------------------------------------------------------------- |
| `terminal.read`   | `terminal.read`: the newest lines of a terminal.              |
| `tabs.create`     | `tabs.create`: a new tab with a new shell.                    |
| `palette.actions` | `palette.register`: an action in the command palette.         |
| `panel`           | `panel.open`: a panel beside the terminal, with your content. |

No method types into a terminal: a plugin can make a tab and read what a terminal printed, never send a key or a command to it.

## Protocol v1

The plugin and the app talk with messages (`postMessage`). In the plugin, `globalThis.postMessage(...)` sends and `globalThis.onmessage` hears.

A **request** is sent by the plugin:

```js
{ version: 1, id: 7, method: "palette.register", params: { id: "open", label: "Open something" } }
```

- `version` is `1`. Another number is answered `unsupported_version`, before anything else is looked at.
- `id` is text of 1 to 64 characters or a whole number (0 or more); the answer repeats it. A request without a usable `id` is answered with `id: null`.
- `method` is one of the methods below; `params` is what the method takes.
- Any other field is an error (`invalid_request`).

The **answer** is `{ version: 1, id, result }` or `{ version: 1, id, error }`, never both:

```js
{ version: 1, id: 7, result: { id: "open" } }
{ version: 1, id: 8, error: { code: "permission_denied", message: "...", permission: "panel" } }
```

The app checks a request in this order and stops at the first problem:

| Order | Check                                                                | Error code            |
| ----- | -------------------------------------------------------------------- | --------------------- |
| 1     | The request is an object with a usable `id`.                         | `invalid_request`     |
| 2     | `version` is `1`.                                                    | `unsupported_version` |
| 3     | No field other than `version`, `id`, `method` and `params`.          | `invalid_request`     |
| 4     | `method` is text and one of the methods below.                       | `unknown_method`      |
| 5     | The manifest holds the permission of the method.                     | `permission_denied`   |
| 6     | The parameters fit the method.                                       | `invalid_params`      |
| 7     | The method runs; it may fail with `not_found`, `failed`, `internal`. | (those)               |

`permission_denied` carries `permission`, the one that was missing. When it is answered **nothing else is read or done**: the parameters are not even looked at and the app is untouched. The other methods of the local API (`docs/API.md`) are not reachable from a plugin; they answer `unknown_method`.

## The methods

| Method             | Permission        | `params`                            | `result`                                     |
| ------------------ | ----------------- | ----------------------------------- | -------------------------------------------- |
| `palette.register` | `palette.actions` | `{ id, label }`                     | `{ id }`                                     |
| `tabs.create`      | `tabs.create`     | `{ space?, cwd?, profile? }`        | `{ space, group?, item, terminal, session }` |
| `terminal.read`    | `terminal.read`   | `{ terminal, lines? }` (1 to 10000) | `{ terminal, lines: [text], truncated }`     |
| `panel.open`       | `panel`           | `{ title, html? }`                  | `{ title }`                                  |

- **`palette.register`** puts an action in the palette, under "Plugins". `id` has the characters `a-z`, `0-9`, `.`, `_` and `-`, up to 64; `label` is text of 1 to 80 characters with no control characters. A plugin may hold up to 64 actions (`failed` beyond that); registering an id again changes its label and keeps its place. Two plugins never see each other's actions.
- **`tabs.create`** and **`terminal.read`** are the `items.create` and `terminal.read` calls of the local API, with the same limits, routing rules and errors (see `docs/API.md`). Unknown fields are refused. `tabs.create` starts a shell and writes nothing into it.
- **`panel.open`** shows a panel (below). `title` is text of 1 to 80 characters; `html` is optional text up to 20,000 characters (default empty). Another call replaces the panel; there is one panel on screen at a time, the last one opened.

## Events the app sends

Besides answers, the app posts one kind of event to a plugin: `{ event: "action", id }` when the person chose the palette action `id` that this plugin registered. An event has no `version` and no `result`, so tell it from an answer by the `event` field. The app only sends it for an action the plugin registered.

## The panel

`panel.open` opens a panel beside the terminal, with the title in its header, the name of the plugin, and a close button (Escape closes it too while the focus is inside the panel). Its content is the `html` text you sent, shown in a frame:

- The frame is an `iframe` with an **empty `sandbox`**: it has an opaque origin that the app cannot read and that cannot read the app, and it cannot run scripts, send forms, open windows or move the app to another address.
- The page inside also carries its own policy, `default-src 'none'; style-src 'unsafe-inline'`: nothing loads (no images, fonts, frames or requests), and only **inline styles** are allowed. So the content can draw (text, lists, tables, `style="..."`, a `<style>` element) and nothing else.
- Because the frame has no scripts, **the panel is static in API v1**: there is no way for the content to send a message back, so a button inside it does nothing. The plugin updates the panel by calling `panel.open` again (for example, after the person chose a palette action).
- The content is the plugin's own text, put in the frame as it came. The app does not clean it, because the frame is what holds it back.

The panel closes by itself if the plugin fails, and never stays behind a plugin that is gone.

## Limits

| What                                     | Limit                                 |
| ---------------------------------------- | ------------------------------------- |
| `id` of a plugin                         | 32 characters                         |
| `name`                                   | 64 characters                         |
| `version`                                | 32 characters                         |
| `main`                                   | 256 characters, and a file of 256 KiB |
| `plugin.json`                            | 256 KiB                               |
| plugins listed                           | 50 folders                            |
| `id` of a request                        | 64 characters, or a whole number      |
| `id` of a palette action                 | 64 characters                         |
| `label` of an action, `title` of a panel | 80 characters                         |
| actions per plugin                       | 64                                    |
| `html` of a panel                        | 20,000 characters                     |

The app puts no limit yet on the size or the rate of the messages a plugin sends, or on a plugin that never answers (finding 276 in `docs/SECURITY_REVIEW.md`): a plugin can use the memory or the time of the page, though it cannot run anything outside its Worker.

## Isolation

Each plugin runs in its own **Worker**, made from the text of `main` through a `blob:` address, and it is given nothing from the app: no Tauri, no `invoke`, no files, no address. It keeps the Content Security Policy of the page, so inside it `eval`, `new Function`, `importScripts` of anything outside the app, `fetch` and `new Worker` of other addresses are refused (a plugin that tries each gets an error and no request leaves the page). What it posts goes to the broker of its own manifest, which looks at the permission first.

The panel is a separate **frame** with an empty sandbox (above). The policy of the app did not need a new source for it: the frame is made from `srcdoc`, and `frame-src` stays `'none'`. `worker-src blob:` is the one door the plugins opened in the policy (NOR-F18-01c). `docs/SECURITY_REVIEW.md` section 1 gives the reasons and the tests, and lists what is still open.

A plugin is **code you chose to install**: the permissions limit what it can ask the app to do, not what the code does inside its Worker (it can burn the processor, for example). Install plugins only from people you trust.

## When a plugin fails

The app records what happened to each folder (`running`, `failed` with the reason, `invalid` with the reason) and shows no dialog. A plugin whose Worker cannot start, raises an uncaught error or cannot be reached is ended, its actions leave the palette and its panel closes; the others and the app go on. A plugin that sends a request that breaks the broker gets an `internal` error for its own `id`, not silence.

## The example

`examples/plugins/new-tab-action/` is a complete plugin. Copy the folder into `plugins/` to try it. It asks for three permissions, registers two palette actions and answers them:

```js
let lastId = 0;
const ask = (method, params) =>
  globalThis.postMessage({ version: 1, id: ++lastId, method, params });

ask("palette.register", { id: "open-tab", label: "Open a new tab (example plugin)" });
ask("palette.register", { id: "open-panel", label: "Show the panel (sample)" });

globalThis.onmessage = (event) => {
  const message = event.data;
  if (!message || message.event !== "action") return;
  if (message.id === "open-tab") {
    ask("tabs.create", {});
  } else if (message.id === "open-panel") {
    ask("panel.open", {
      title: "Example panel",
      html: '<h3>Hello from the plugin</h3><p id="from-plugin">This panel is drawn from text the plugin sent.</p>',
    });
  }
};
```

Remove `"panel"` from its `plugin.json` and "Show the panel (sample)" is answered `permission_denied` and no panel appears: `e2e/plugin-panel.spec.ts` runs both cases in a real browser.
