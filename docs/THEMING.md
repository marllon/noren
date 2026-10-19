# Your own themes, and importing color schemes

Noren ships eight themes (see [CONFIG.md](CONFIG.md)). You can add your own in two ways: put a theme file in the themes folder, or import a color scheme from a file you already have, which writes that theme file for you.

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

## Profiles in a settings file

The JSON reader also reads the shell profiles of a settings file (`profiles` as a list, or an object with a `list`): the name, the `commandline`, the `startingDirectory` and the `colorScheme` of each. A profile with `"hidden": true` is left out, and one with no name is left out with a warning. Only the reading exists so far (`importProfiles` in `@noren/model`); putting the profiles in Noren's own list, and importing from the settings screen, is a later task.

## For contributors

- The pure readers are in `packages/model/src`: `importers.ts` (the facade: `detectFormat`, `importColorSchemes`, `importProfiles`), `import-plist.ts`, `import-keyvalue.ts` and `import-json.ts`, and `theme-derive.ts` (the derived colors, the slug and the numbering of ids). They never throw; a failure is `{ ok: false, errors }` with sentences for a person. No dependency was added: the XML reader is a small one for the part of the property list format the color files use, and the JSON reader is `jsonc-parser`, already used for `config.jsonc`.
- The generated names and ids speak of file formats, never of a product, so a test holds that.
- `user-themes.ts` has `serializeTheme` (the text a theme is saved as) and `parseUserThemes` (what a file must be to count, as above).
- `Backend.listUserThemes()` returns the text of each file; `Backend.saveUserTheme(id, text)` writes `themes/<id>.json`. The id becomes a file name, so one that is not a theme id is refused before anything is written. In `noren-core` it is `themes.rs` (`ThemeStore`, over the same atomic write as `state.json`); the Tauri commands are `theme_list` and `theme_save`. The core does not know the schema of a theme: it only keeps files that can be one, and the interface validates them. The smoke run lists themes but never writes one.
- In the web build the theme files live in the browser storage under `noren.web.themes` (a JSON object from id to text); `FakeBackend.setUserTheme(id, text)` places a file as if by hand and `setUserThemeSaveFailure(error)` makes saves fail.
- In the interface, `user-themes-store.ts` holds the list (built-in first, then yours), loaded before the first frame; `scheme-import.ts` is what the action runs for a picked file; `theme-choice.ts` and `use-theme.ts` look themes up in that whole list, while `findTheme` of `@noren/model` stays the built-in themes alone.
- The fixtures of the tests (a scheme in each format, a settings file with a hidden profile, files that are not valid) are in `packages/model/src/import-fixtures.ts`, also used by the end-to-end tests.
