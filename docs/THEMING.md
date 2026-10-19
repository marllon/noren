# Your own themes, mods, and importing color schemes

Noren ships eight themes (see [CONFIG.md](CONFIG.md)). You can add your own in two ways: put a theme file in the themes folder, or import a color scheme from a file you already have, which writes that theme file for you. Beyond colors, a **mod** is a CSS file of yours that restyles the window itself; see [Mods](#mods-your-own-css) below, which also lists the variables and attributes a mod can rely on.

## The themes folder

Your themes live in the folder `themes`, inside the config folder of the app, next to `config.jsonc`:

| System  | Path                                                            |
| ------- | --------------------------------------------------------------- |
| Windows | `%APPDATA%\io.github.marllon.noren\themes\`                     |
| macOS   | `~/Library/Application Support/io.github.marllon.noren/themes/` |
| Linux   | `~/.config/io.github.marllon.noren/themes/`                     |

One file per theme, named `<id>.json`: the id is lower case letters and digits in words joined by single hyphens (`lagoon`, `my-night-2`), at most 64 characters. The folder does not exist until a theme is saved; Noren creates it then.

A theme file is JSON in the format of the theme (see "A theme is data" in [CONFIG.md](CONFIG.md)): `id`, `name`, `kind`, `ui`, `terminal`, `font` and `background`. The `id` inside the file is the one that counts; name the file after it. Files are written atomically (a temporary file in the same folder, then a rename), so a crash never leaves half a theme.

When Noren starts it reads every `*.json` in the folder and keeps the themes that are valid. These are left out, and the files are not touched:

- a file whose name is not `<id>.json` with a valid id, a folder, a leftover temporary file, a file that is not UTF-8 text, is empty, is not a JSON object or is larger than 256 KiB;
- a file that is not JSON, or is JSON that is not a valid theme (a missing field, a color that is not a color, not sixteen ANSI colors, an unknown field);
- a theme that takes the id of one of the eight built-in themes, or `system` (which means "follow the system"), or that repeats the id of a file before it (files are read in the order of their names).

The themes of your folder are listed after the built-in ones, in order of name, everywhere a theme is chosen: the palette (_Theme: <name>_), the global theme (`appearance.theme` in `config.jsonc` can be one of their ids), and the theme of a space (the menu of the space and _Set theme for this space_). A theme file you add by hand is read at the next start; the folder is not watched.

## Importing a color scheme

**Import color scheme...** in the command palette (category General, so `>import` finds it; no key by default, record one in the shortcuts screen if you want) opens a file picker. Pick a file; Noren tells the format from what is in it, not from its name, so a file with any extension, or none, works. It then writes one theme file in the folder above for each scheme it found, and says what it did in the notice at the bottom of the window:

- `Imported color scheme "Lagoon". Pick it with "Theme: Lagoon" in the command palette.`
- `Imported 2 color schemes: "A", "B". ...`, with `Left out: ...` and the reason when a file held more than it could use;
- `Could not import "file.name": <reason>` when it is not a scheme: nothing is written.

Importing does not apply the theme and does not touch `config.jsonc`; pick the theme afterwards like any other. Everything stays on your machine, and nothing is run: a file is only read as data.

### The formats

**An XML property list** (the `.itermcolors` files). One scheme per file. The entries read are `Ansi 0 Color` to `Ansi 15 Color`, `Foreground Color` and `Background Color` (all required), and `Cursor Color` and `Selection Color` when present. Each color is a dictionary with `Red Component`, `Green Component` and `Blue Component` from 0 to 1 (an `Alpha Component` below 1 is kept for the selection). The color space the file names is not converted: the components are read as sRGB, so a color can differ a little from the program that made the file. A binary property list (it starts with `bplist`) is not read; export the XML form. A property list nested deeper than 24 levels is refused.

**JSON with comments and trailing commas.** `//` and `/* */` comments and a comma after the last item are fine. The file may be a settings file with a `schemes` list, a bare list of schemes, or one scheme object. A scheme has a `name` and these colors, each `#rgb`, `#rrggbb` or `#rrggbbaa`:

| Key                                                                                                           | Becomes                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `foreground`, `background`                                                                                    | terminal foreground and background (required)                             |
| `cursorColor`                                                                                                 | terminal cursor (optional)                                                |
| `selectionBackground`                                                                                         | terminal selection (optional; its alpha is kept)                          |
| `black` `red` `green` `yellow` `blue` `purple` `cyan` `white`                                                 | ANSI colors 0 to 7 (required; `magenta` is read as `purple`)              |
| `brightBlack` `brightRed` `brightGreen` `brightYellow` `brightBlue` `brightPurple` `brightCyan` `brightWhite` | ANSI colors 8 to 15 (required; `brightMagenta` is read as `brightPurple`) |

A scheme with a color missing or not a color is left out with the reason (`Scheme "Broken": "red" is missing`) and the others of the file are still imported; the import fails only when no scheme is left. At most the first 200 are read.

**Text with one `key = value` per line.** A line that starts with `#` is a comment (a `#` later in a line starts a color). The lines read:

```
palette = 0=#1d1f21        # ANSI color 0 to 15: all sixteen are required
background = #1d1f21       # required
foreground = #c5c8c6       # required
cursor-color = #c5c8c6     # optional
selection-background = #373b41   # optional
```

Colors are `#rgb`, `#rrggbb`, or `rrggbb` with no `#`; a value may be in quotes. A `palette` entry past 15 and every other key are ignored. A line that is not `key = value` is ignored with a warning.

### What a theme gets

The colors of the terminal are kept exactly as the file gives them. A theme also has the colors of the interface around the terminal, which a scheme does not have, so they are derived from the terminal colors:

- `ui.bg` is the terminal background; the theme is `dark` when white text reads better on it than black text does, `light` otherwise;
- `ui.text` is the terminal foreground, moved toward white (dark) or black (light) only as far as needed to reach a contrast of 4.5:1 on the background; `ui.muted` is the text blended 40% toward the background, with a contrast of at least 3:1; `ui.accent` is the scheme's blue (the normal one, then the bright one), else its cyan, its magenta, the cursor color or the foreground, the first with a contrast of at least 3:1 on the background;
- `ui.surface` and `ui.border` are the background moved 6% and 15% toward the text;
- with no cursor color the cursor is the foreground, and with no selection color the selection is the background a quarter of the way to the foreground;
- the radius, blur, opacity, font and background are the ones the built-in themes start with.

So the interface stays legible even for a scheme with a low-contrast terminal; the terminal itself shows what the scheme says.

**The id and the name.** The name is the one in the file (JSON); a plist or key-value file has none, so it takes the name of the file without its extension (`Lagoon.itermcolors` is "Lagoon"), and when even that gives nothing it is `Imported plist scheme`, `Imported JSON scheme` or `Imported key-value scheme`. The id is the name as a slug (lower case, accents and symbols dropped, words joined by hyphens: `Café Nuit #2` is `cafe-nuit-2`). An id that is taken, by a built-in theme, by `system`, by a theme of yours or by another scheme of the same file, gets a number: `lagoon`, `lagoon-2`, `lagoon-3`, and the name `Lagoon (2)`, so importing the same file twice makes two themes and never replaces one.

A file over 1,000,000 bytes is not read.

## Importing from the settings screen

The **Import** section of the settings screen has both imports, **Import color scheme...** and **Import profiles...**. A scheme goes through the same steps as the palette action (a file picker, the format told from the content, one file per theme in the `themes` folder), and the sentence that says what happened shows under the buttons instead of in the corner of the window. Importing profiles is described next.

## Profiles in a settings file

The JSON reader also reads the shell profiles of a settings file (`profiles` as a list, or an object with a `list`): the name, the `commandline`, the `startingDirectory` and the `colorScheme` of each. A profile with `"hidden": true` is left out and counted, and one with no name is left out with a warning.

**Import profiles...** picks a file, reads it and **shows what it would add before anything is written**: every profile with its name and the command line that would start it, how many hidden profiles the file had (they are ignored), and the profiles that were read but cannot be imported, with the reason (a profile with no command line has nothing to start). Nothing is written until you press **Import N profiles**; **Cancel** and Esc write nothing. Importing only adds to the list: it never starts a shell and never runs a command, and the command lines run only when you open a tab of that profile from the command palette (_New ... tab_).

What each profile becomes (an entry of `profiles` in `config.jsonc`, see [CONFIG.md](CONFIG.md#profiles)):

- the **command line** is split into the program and its arguments by the rules of Windows (`CommandLineToArgvW`): the first word is the program (in double quotes it runs to the closing quote, spaces included, and its backslashes are plain), the rest are the arguments, separated by spaces and tabs, with double quotes grouping words and a backslash escaping a quote. `"C:\Program Files\Git\bin\bash.exe" --login -i` is the program `C:\Program Files\Git\bin\bash.exe` and the arguments `--login` and `-i`. `%NAME%` is kept as written and replaced by the environment variable when a session starts;
- the `startingDirectory` becomes `cwd`;
- the `colorScheme` is **not carried over**: a profile of yours has no color scheme of its own (the theme is chosen for the window or for a space), so a profile that used one of the schemes of the file starts with the theme in force. Import the scheme itself with **Import color scheme...** if you want it as a theme;
- the `id` is the name as a slug, and the name is the one in the file. An id that the machine's shells already have (for example `pwsh`), an id of a profile you already have, `default`, or another profile of the same file gets a number in the id and `(2)` in the name, so importing the same file twice makes more profiles and never replaces one.

The profiles go to the end of `profiles` in the file, keeping the comments and the layout of the file as every write from the settings screen does. If the file has a problem of its own, or the disk refuses the write, the preview stays open with the reason and nothing is written. A file over 1,000,000 bytes is not read.

## Mods: your own CSS

A mod is a CSS file in the `mods` folder, next to `config.jsonc`. Noren reads the file, puts its rules in a cascade layer that comes after its own style, and applies it to the window: you can move things, change spacing, colors and shapes, and hide what you do not use. A mod only restyles; it runs no code, and nothing in Noren fetches anything for it.

| System  | Path                                                          |
| ------- | ------------------------------------------------------------- |
| Windows | `%APPDATA%\io.github.marllon.noren\mods\`                     |
| macOS   | `~/Library/Application Support/io.github.marllon.noren/mods/` |
| Linux   | `~/.config/io.github.marllon.noren/mods/`                     |

Noren makes the folder when it starts, so there is somewhere to put a file. Three mods to start from are in the repository, in `examples/mods/`: copy one into the folder.

| File                 | What it does                                                             |
| -------------------- | ------------------------------------------------------------------------ |
| `tinted-sidebar.css` | The sidebar takes a little of the color of the space you are in.         |
| `accent-bar.css`     | A bar in the color of the space on the tab you are in, and rounder tabs. |
| `dim-unfocused.css`  | In a split tab, the panes that do not have the keyboard fade a little.   |

### The files

A mod's name is its id. The name is letters, digits, `.`, `_` and `-` (the first a letter or digit, 64 characters at most before the extension) and ends in `.css` in lower case, and it is not a name Windows reserves for a device (`con.css`, `aux.css`, `com1.css`, ...). A file that does not follow this, a folder, a file that is not UTF-8 text or is larger than 256 KiB is not listed (no space in the name, so `my mod.css` must be renamed `my-mod.css`); only the first 100 by name are listed. Nothing in the folder is ever changed or deleted by Noren.

### Turning mods on

- **For every space**: the **Mods** section of the settings screen lists the files, a box to turn each on, and for the ones that are on a pair of arrows that move it earlier or later. Save writes the list into `config.jsonc` as `mods` (for example `"mods": ["tinted-sidebar.css", "accent-bar.css"]`; see [CONFIG.md](CONFIG.md)). The rest of the file, comments included, stays as it was; the comments inside the old `mods` list itself go with the list.
- **For one space**: the menu of the space (right-click it at the foot of the sidebar) has a **Mods** list with a box for each file. It applies while that space is active and is kept with the space in `state.json`, not in `config.jsonc`. A mod that is on for every space shows as checked and disabled there, with `(all spaces)`: turn it off in the settings.

Both are lists, in order. The mods of the whole list apply first, then the ones of the active space, and **the one applied last wins**. A mod that is in both lists applies once, where the space's list puts it. Switching space switches the mods at once.

### Reload and what can go wrong

The folder is watched. Save the file in your editor and the window follows within a moment, without a restart: an edit, a new file and a removed file are all noticed. A file that is turned on but is not in the folder (deleted, renamed, or never copied there) is **ignored with a notice** and the rest still apply; the notice goes away when the file comes back, and the settings screen and the space menu show the stale name so it can be turned off. A mod that cannot be used (see "The cascade" below) is ignored the same way, with the reason.

### The cascade

The style of the window is in layers, declared in this order: `vendor` (the CSS of the terminal library), `base` (Noren's own style), `mods` (all your mods). A rule in a later layer wins over a rule in an earlier one **whatever its specificity**, so a plain selector in a mod beats Noren's style without `!important` and without matching its specificity. Every mod is put in `@layer mods`, whatever it contains: Noren wraps the file, and you do not write the layer yourself. Between mods, the usual rules apply inside the layer: a more specific selector wins, and with equal specificity the mod applied later wins.

Things to know:

- A declaration with `!important` flips the order of layers: an `!important` in Noren's own style (there is one, on the width of the command marks) beats an `!important` in a mod, and an `!important` in a mod beats a normal one anywhere, including the inline styles the app sets (the width of the sidebar, for one).
- A mod is wrapped as text, so a `}` that closes nothing would end its layer early: a mod with one is **not applied** and the notice names the line. Braces inside comments, strings and `url(...)` do not count. A block or comment the mod leaves open is closed for it.
- `@import` and `@charset` have no effect in a mod (they are not allowed inside a layer): a mod is one file.
- The rest is plain CSS: `@media`, `@keyframes`, `@font-face`, nesting, `color-mix()` and `var()` all work. What you write is read as you wrote it; Noren does not rewrite it. It is CSS for the window around the terminal: the terminal draws its own text, and its colors come from the theme.

### The theme API

These names are the contract between Noren and your mods. They are set by the app and meant to be read by CSS. Renaming or removing one is a breaking change and will be noted in the release notes; anything not listed here (the class names, for one) can change at any release, so do not select by class.

#### Variables

Set on the root element of the page by the active theme (and the active space, for the last one), so a mod can use them in any rule and they follow a change of theme at once.

| Variable           | What it holds                                                                     |
| ------------------ | --------------------------------------------------------------------------------- |
| `--nr-bg`          | Background of the window.                                                         |
| `--nr-surface`     | Background of the surfaces on top of it: the sidebar, the title bar, the dialogs. |
| `--nr-text`        | Text.                                                                             |
| `--nr-muted`       | Secondary text.                                                                   |
| `--nr-accent`      | The accent of the theme.                                                          |
| `--nr-border`      | Lines and borders.                                                                |
| `--nr-radius`      | The corner radius, with its unit (`10px`).                                        |
| `--nr-space-color` | The color of the active space, or the accent when it has none.                    |

#### Parts

`data-nr-part` names what an element is. `data-nr-state` (where the table gives values) says what state it is in, and is absent when the element is in none.

| `data-nr-part`   | What it is                                        | `data-nr-state`                                   |
| ---------------- | ------------------------------------------------- | ------------------------------------------------- |
| `sidebar`        | The sidebar.                                      | `revealed` or `hidden`, only with compact mode on |
| `space-switcher` | The row of spaces at the foot of the sidebar.     |                                                   |
| `item`           | A tab, in the sidebar or in the bar on top.       | `active`                                          |
| `item-title`     | The title inside a tab.                           |                                                   |
| `group`          | A group of tabs.                                  | `expanded` or `collapsed`                         |
| `pinned-list`    | The list of pinned tabs.                          | `over` while a tab is dragged over it             |
| `favorites`      | The grid of favorites.                            | `over` while a tab is dragged over it             |
| `favorite`       | One favorite.                                     | `active`                                          |
| `tabbar`         | The bar of tabs on top, when the tabs are on top. |                                                   |
| `pane`           | One terminal pane.                                |                                                   |
| `pane-header`    | The header of a pane, when pane headers are on.   |                                                   |
| `palette`        | The command palette.                              |                                                   |
| `settings`       | The settings screen.                              |                                                   |

#### Other attributes

| Attribute           | On                                              | Values                                                    |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `data-nr-focused`   | `pane`                                          | `true` or `false`, only in a tab that is split into panes |
| `data-nr-selected`  | `item`                                          | `true` while the tab is part of a selection               |
| `data-nr-pinned`    | `item`                                          | `true` for a pinned tab                                   |
| `data-nr-indicator` | the marks on a tab                              | `running`, `failed`, `unread` or `bell`                   |
| `data-nr-side`      | the area that holds the sidebar and the content | `left` or `right`: the side of the sidebar                |
| `data-nr-density`   | the area that holds the sidebar and the content | `comfortable` or `compact`                                |

#### Reading the page

```css
/* The active tab gets a bar in the color of its space. */
[data-nr-part="item"][data-nr-state="active"] {
  box-shadow: inset 3px 0 0 var(--nr-space-color);
}

/* Smaller, rounder, quieter. */
[data-nr-part="sidebar"] {
  font-size: 12px;
}
[data-nr-part="item"] {
  border-radius: calc(var(--nr-radius) * 1.5);
}
```

### Not verified in a real window

The reload, the layer order and the computed styles are checked in a browser by the end-to-end tests (`e2e/mods.spec.ts`). That the watching of the folder reaches the app on every system (Windows, macOS and Linux each report file changes their own way), and how a mod looks in the webview of the app, are checked in the Rust tests and by reading the code, and have not been seen in a window.

## For contributors

- **Mods.** The pure part is `packages/model/src/mods.ts`: `isValidModFileName` (the rule of the file names, mirrored by `is_valid_mod_file_name` in `crates/noren-core/src/mods.rs`; both are tested with the same cases), `wrapModCss` (the layer wrapper and the brace check), `planMods` (the lists, the order, what is missing or refused) and the helpers the screens use to turn a mod on or off and move it. In `noren-core`, `mods.rs` has `ModStore` (`list`, and `watch` over `notify`, which watches the folder that holds `mods/` so the folder can be deleted and made again) with a `ModFile` of name and text. The Tauri commands are `mod_list` and `mod_watch` and the event is `mods-changed` (the payload is the whole list); the smoke run lists but does not watch, since watching makes the folder. `Backend.listMods()` and `Backend.watchMods()` are in the Tauri, web (`noren.web.mods` in the browser storage) and fake backends; `FakeBackend.setMod(name, text | null)` places, edits or removes a file as an editor would.
- **In the interface**, `mods-store.ts` holds the files (loaded and watched before the first frame), `use-mods.ts` follows the mods of the active space and turns the lists into a plan, `mod-styles.ts` keeps one `<style data-nr-mod="name.css">` per mod in the `<head>` and `ModStyles.tsx` runs it before paint and shows the notice. The layers are declared in `app.css` (`@layer vendor, base, mods;`, the CSS of the terminal library in `vendor` and `styles.css` in `base`), and every mod repeats the statement (`MOD_LAYER_ORDER`), so the order holds whichever stylesheet the browser reads first. A test holds the statement in `app.css` equal to the constant. `space/set-mods` is the reducer action for the mods of a space (`modIds` of the space, kept as given when they are mod names).
- **The names in the tables above** are checked against the code by `theming-api.test.ts`: every variable the theme sets, and every part, state and attribute listed, has to exist in the source, and the other way round for the variables.
- The pure readers for themes are in `packages/model/src`: `importers.ts` (the facade: `detectFormat`, `importColorSchemes`, `importProfiles`), `import-plist.ts`, `import-keyvalue.ts` and `import-json.ts`, and `theme-derive.ts` (the derived colors, the slug and the numbering of ids). They never throw; a failure is `{ ok: false, errors }` with sentences for a person. No dependency was added: the XML reader is a small one for the part of the property list format the color files use, and the JSON reader is `jsonc-parser`, already used for `config.jsonc`.
- The generated names and ids speak of file formats, never of a product, so a test holds that.
- `user-themes.ts` has `serializeTheme` (the text a theme is saved as) and `parseUserThemes` (what a file must be to count, as above).
- `Backend.listUserThemes()` returns the text of each file; `Backend.saveUserTheme(id, text)` writes `themes/<id>.json`. The id becomes a file name, so one that is not a theme id is refused before anything is written. In `noren-core` it is `themes.rs` (`ThemeStore`, over the same atomic write as `state.json`); the Tauri commands are `theme_list` and `theme_save`. The core does not know the schema of a theme: it only keeps files that can be one, and the interface validates them. The smoke run lists themes but never writes one.
- In the web build the theme files live in the browser storage under `noren.web.themes` (a JSON object from id to text); `FakeBackend.setUserTheme(id, text)` places a file as if by hand and `setUserThemeSaveFailure(error)` makes saves fail.
- In the interface, `user-themes-store.ts` holds the list (built-in first, then yours), loaded before the first frame; `scheme-import.ts` is what the action runs for a picked file; `theme-choice.ts` and `use-theme.ts` look themes up in that whole list, while `findTheme` of `@noren/model` stays the built-in themes alone.
- Profiles: `user-profiles.ts` has `splitCommandLine` (the rules above), `userProfilesFromImported` (the ids and the schema check, never throws) and `commandLineOf` (the line shown in the preview); `user-profile-schema.ts` is the schema of one entry of `profiles`, shared with the schema of `config.jsonc`. In the interface, `profile-import.ts` reads the file into a plan (`readProfileFile`) and writes it (`commitProfileImport`, through `ConfigManager.update` with an append to `profiles`), `ProfileImportDialog.tsx` is the preview and `profiles-store.ts` hands the profiles of the file to the backend and keeps the joined list.
- The fixtures of the tests (a scheme in each format, settings files with hidden profiles and profiles to import, files that are not valid) are in `packages/model/src/import-fixtures.ts`, also used by the end-to-end tests.
