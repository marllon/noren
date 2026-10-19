# The settings file

Noren keeps its settings in one text file, `config.jsonc`. It is JSON that allows comments (`//` and `/* */`) and a comma after the last item, so it can be edited by hand and annotated. Nothing is stored anywhere else that you need to know about: this file is the place to look.

## Where it is

| System  | Path                                                                 |
| ------- | -------------------------------------------------------------------- |
| Windows | `%APPDATA%\io.github.marllon.noren\config.jsonc`                     |
| macOS   | `~/Library/Application Support/io.github.marllon.noren/config.jsonc` |
| Linux   | `~/.config/io.github.marllon.noren/config.jsonc`                     |

It is the config folder of the app (Tauri `app_config_dir`), next to `state.json` on Windows. The file does not exist until you create it, and Noren never creates or rewrites it by itself in this version. Without it every setting has its default.

## Reload without a restart

Noren watches the folder of the file (and creates that folder, empty, when it is missing, so a file created later is seen too). When you save it, from an editor or a script, the new settings apply at once, with no restart and no reload of the window: move `appearance.sidebar.position` to `"right"` and the sidebar moves.

If the saved text has a problem (it is not JSON, a value is of the wrong kind or out of its range, a setting does not exist), **nothing changes**: Noren keeps the last valid settings and shows a notice in the corner that names the first problem with its line, for example:

```
The settings file has a problem, so the last valid settings stay in use.
config.jsonc, line 3, column 19: appearance.sidebar.position: Invalid option: expected one of "left"|"right"
```

The notice does not block anything; close it with its button. It goes away by itself when the file is valid again. A file that is wrong when the app starts means the defaults until it is fixed. Deleting the file puts the defaults back.

A setting that is missing is "not set here", not "reset": a preference you did not put in the file keeps the choice you made with the controls of the layout panel (kept in the browser storage until the settings screen exists). A preference the file **does** set belongs to the file: its control in the layout panel is disabled, with the title "Set in config.jsonc", and the width handle of the sidebar does nothing.

## Settings

Every setting is optional. Unknown settings are an error, so a typo does not go unnoticed. The editor can complete and check the file with the schema: add `"$schema": "./config.schema.json"` (the schema is [config.schema.json](config.schema.json) in this folder of the repository).

```jsonc
{
  "appearance": {
    "sidebar": {
      "position": "left", // "left" | "right"
      "width": 200, // whole pixels, 180 to 480
      "compact": false, // the sidebar hides and shows when the pointer touches the edge
      "keepOpen": false, // in compact mode, keeps it open
    },
    "density": "comfortable", // "comfortable" | "compact"
    "tabs": "sidebar", // "sidebar" | "top"
    "paneHeaders": false, // a header on every pane
  },
  "notifications": {
    "enabled": true, // false: never ask the system for a notification
    "longCommandSeconds": 30, // a longer command that ends out of sight notifies
  },
}
```

The values above are the defaults. More sections (terminal, profiles, shortcuts, auto-archive, AI) arrive with the tasks that need them; the schema is the list of what exists now.

## For contributors

- The schema is written with zod in `packages/model/src/config.ts` (`ConfigSchema`); `parseConfigText` reads the text (it uses `jsonc-parser`, so errors know their line) and never throws. `ConfigManager` (`config-manager.ts`) keeps the settings in force: a valid text replaces them, an invalid one keeps them and reports the errors.
- `docs/config.schema.json` is generated from that schema. A Vitest test fails when it is out of date; run `pnpm --filter @noren/model config:schema` to regenerate it.
- `noren-core` (`crates/noren-core/src/config.rs`) reads, writes atomically (temporary file in the same folder, flush, rename) and watches the file with the `notify` crate; the Tauri commands are `config_load` and `config_watch`, and the change reaches the page as the `config-changed` event with the new text (`null` when the file was removed).
- `Backend.loadConfig()` and `Backend.watchConfig(callback)` are the interface; `FakeBackend.setConfig(text)` replaces the text of the in-memory file and tells the watchers. In the web build the text lives in the browser storage under `noren.web.config`, and the test hook `window.__norenTest.setConfig(text)` is how the end-to-end tests edit "the file".
- Writing the file from the interface (the settings screen, which keeps comments) is the next task, NOR-F8-01b.
