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
- the radius, blur, opacity, font and background are the ones the built-in themes start with. (The `font` of a theme is part of the format but is not used to draw the terminal: the terminal takes its font from `terminal.font` in `config.jsonc`, see [CONFIG.md](CONFIG.md#the-terminal). If a later build reads the font of a theme, its family is text from a file and will go through the same rule for font names.)

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

## The window: effect, opacity and background

Three things change how the window itself looks, beyond the colors of a theme. All three are settings of `config.jsonc` (the **Window** and **Background** sections of the settings screen write them; see [CONFIG.md](CONFIG.md)).

### The effect behind the window

`appearance.window.effect` asks the system to paint something behind the window, which shows through wherever the interface is see-through:

| Value      | What it is                                                | Where it works                       |
| ---------- | --------------------------------------------------------- | ------------------------------------ |
| `none`     | A plain opaque window. The default.                       | Everywhere                           |
| `mica`     | The soft backdrop of Windows 11, tinted by the wallpaper. | Windows 11                           |
| `acrylic`  | A translucent, blurred backdrop.                          | Windows 11, and Windows 10 from 1809 |
| `vibrancy` | The translucent material of macOS windows.                | macOS                                |

- **A system that cannot paint the effect keeps the window opaque, with no error.** Mica before Windows 11, vibrancy on Windows or Linux, and any effect on Linux or in a browser answer "not applied". The file is still valid; the **Window** section of the settings screen says what was not applied and why, and the app writes one line to its log, such as `window effect mica applied` or `window effect mica not applied, opaque window kept: <reason>`. While the window has no effect the interface does not use the see-through opacity of the theme (below), so nothing is left half transparent over a window that cannot show anything behind it.
- **The effect is painted dark or light like the theme you chose**, not like the mode of the system: a dark theme gets a dark Mica even when the system is in light mode, because text in a dark theme on a light backdrop would not be readable. The window is given that look as its own, which also makes the page report it as its preferred color scheme; that only matters to a theme that follows the system, and one that does is never given a look: while the theme follows the system (`appearance.theme` is `system` or missing, and the space has no theme of its own) the window follows the system too, so the two agree, and **Follow system theme** keeps following it.
- The window is created see-through (that is what lets an effect show), and the page paints it opaque unless the opacity says otherwise, so a window with no effect looks as it always did.
- The effect is applied as soon as the setting is read, and again when it changes or when the theme changes from dark to light (the palette preview too). The smoke run (`pnpm smoke`) gives the hidden window Mica on Windows (vibrancy on macOS) and prints the answer, for example `SMOKE window effect mica applied`; a system that cannot paint it prints the fallback with its reason and still passes.

### The opacity of the interface

`appearance.window.opacity` is a number from 0.3 to 1. It is how opaque the **backgrounds** of the window, the title bar, the sidebar, the tab bar and the terminals are; text, borders and the accent are never faded, and menus, dialogs and the command palette stay solid so they are always readable.

- With a value in the file, that value, with or without an effect. Below 1, what is behind the window shows through (the effect, or the desktop).
- Without a value (or with `null`): solid, except while the window has an effect, when it is the `ui.opacity` of the theme (0.92 for the built-in themes).
- It is applied by the variable `--nr-opacity` (and `--nr-bg-glass`, `--nr-surface-glass`; see the table of variables below), which a mod can use.
- Why 0.3 is the lowest: a test holds every built-in theme to a contrast of 4.5:1 for its text and 3:1 for its muted text, in the interface and in the terminal, at the lowest opacity over the extreme backdrop of its own kind (black for a dark theme, white for a light one). What shows behind the window decides the rest; a backdrop of the other kind cannot be made readable by any opacity, which is why the effect follows the theme.

### The background picture

A picture can sit behind the terminals. It comes from the first of these that has one, and each part (the file, how much of it shows, how blurred it is) is taken from the last layer that says it:

1. the **theme**: `background.image`, `background.opacity` and `background.blur` in the theme file (the built-in themes have no picture);
2. the **settings file**: `appearance.background` (`image`, `opacity`, `blur`), where `"image": null` says no picture even if the theme has one;
3. the **space**: the picture of the space, chosen in its menu (**Background image...**), kept in `state.json`. **Remove background image** in the same menu gives the space back to the layers above.

| Part      | Range                  | When nothing says                                      |
| --------- | ---------------------- | ------------------------------------------------------ |
| `image`   | a file path, see below | no picture                                             |
| `opacity` | 0 (not seen) to 1      | 0.15 (the `background.opacity` of the built-in themes) |
| `blur`    | pixels, 0 to 100       | 0                                                      |

**Only a local file.** The path is an absolute path, or a path inside the config folder (`backgrounds/sky.jpg`, next to `config.jsonc`). Noren refuses, when it reads the file and again in the part that opens it:

- a web address or any other scheme (`http:`, `https:`, `file:`, `data:`, `blob:`), and a network path (`\\server\share\sky.png`): nothing is ever fetched, and nothing reaches the network;
- a path inside the config folder with `..` in it, so it cannot climb out of the folder;
- a name that does not end in `png`, `jpg`, `jpeg`, `webp`, `gif` or `bmp`;
- a file larger than 32 MiB, a folder, or a file whose first bytes are not those of one of those pictures (the name is not trusted: a text file called `sky.png` is refused, and so is a `.svg`).

In a theme file or in `config.jsonc` a refused path makes the theme or the file invalid, with the reason (and the line, for the file). In a space, or when the file cannot be read (it was moved, it is not a picture), the picture is left out and a notice says why; the rest of the window is not affected.

The picture is read by the app (the page is never given a path or an address to fetch: it gets the bytes and shows them from memory), so the file is read again only when the path changes. The picture is drawn under everything, covering the window; the **terminals have no background of their own while a picture shows**, so it shows through them at the opacity you set, and the sidebar, the title bar and the tab bar keep their color at the opacity of the interface (lower it to let the picture through them too).

### Variables and attributes

`--nr-opacity`, `--nr-bg-glass`, `--nr-surface-glass` and the three `--nr-background-*` variables are in the table of variables below; `data-nr-window-effect` on the root of the window says which effect the window has (not the one that was asked for), `data-nr-picture="shown"` is there while a picture is on screen, and the picture itself is the part `background`.

### Not verified in a real window

How Mica, Acrylic and vibrancy look, and that the window with no effect looks the same now that it is created see-through (its corners, its shadow and the first frame before the page paints), have not been seen in a window: the Mica of the system and the desktop behind a see-through window are not part of the picture that the web view gives (see below). What was run on the real app is `pnpm smoke`, which gives the hidden window its effect and prints what the system answered.

#### What the pictures of the real app showed

`pnpm shot` (see [DEV.md](DEV.md#pictures-of-the-real-app)) takes the picture of the main window from its own web view, with the window out of sight. It holds what the page paints, so it shows the interface, the terminal and the picture behind them, and does not show the Mica or Acrylic behind the window or what the desktop would show through a see-through window. The first pictures (a settings file with `appearance.background` at 0.6, `appearance.window.opacity` 0.7 and the Dusk theme) showed, in the real app and for the first time:

- **The picture and the see-through interface work in the sidebar and the title bar:** the picture shows through both, at the opacity of the interface, and the text stays readable.
- **The terminal is not see-through.** Its area is a solid black block that hides the picture, though the text above says the terminals have no background of their own while a picture shows. Only the margins around the terminal let the picture through. The cause was not looked for here; the settings give the terminal `allowTransparency`, so the opaque black is what the WebGL renderer draws.
- **A picture named in the settings file the app starts with does not show.** The page asks for the picture before the store that reads it has been given its backend, is answered "No backend is available to read the image.", and takes the path as already asked for, so it never asks again. The same settings written while the app runs (what the settings screen does) show the picture, which is how the picture above was taken.

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

Set on the root element of the page by the active theme (and the active space, for `--nr-space-color` and the picture), so a mod can use them in any rule and they follow a change of theme at once.

| Variable                  | What it holds                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--nr-bg`                 | Background of the window.                                                                               |
| `--nr-surface`            | Background of the surfaces on top of it: the sidebar, the title bar, the dialogs.                       |
| `--nr-text`               | Text.                                                                                                   |
| `--nr-muted`              | Secondary text.                                                                                         |
| `--nr-accent`             | The accent of the theme.                                                                                |
| `--nr-border`             | Lines and borders.                                                                                      |
| `--nr-radius`             | The corner radius, with its unit (`10px`).                                                              |
| `--nr-space-color`        | The color of the active space, or the accent when it has none.                                          |
| `--nr-opacity`            | How opaque the interface is, a number from 0.3 to 1 (see [the opacity](#the-opacity-of-the-interface)). |
| `--nr-bg-glass`           | `--nr-bg` at that opacity: what the window itself is painted with.                                      |
| `--nr-surface-glass`      | `--nr-surface` at that opacity: what the title bar, the sidebar and the tab bar are painted with.       |
| `--nr-background-image`   | The picture behind the terminals as `url(...)`, or `none`.                                              |
| `--nr-background-opacity` | How much of the picture shows, a number from 0 to 1.                                                    |
| `--nr-background-blur`    | How blurred the picture is, with its unit (`6px`).                                                      |

#### Parts

`data-nr-part` names what an element is. `data-nr-state` (where the table gives values) says what state it is in, and is absent when the element is in none.

| `data-nr-part`   | What it is                                                     | `data-nr-state`                                   |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `sidebar`        | The sidebar.                                                   | `revealed` or `hidden`, only with compact mode on |
| `space-switcher` | The row of spaces at the foot of the sidebar.                  |                                                   |
| `item`           | A tab, in the sidebar or in the bar on top.                    | `active`                                          |
| `item-title`     | The title inside a tab.                                        |                                                   |
| `group`          | A group of tabs.                                               | `expanded` or `collapsed`                         |
| `pinned-list`    | The list of pinned tabs.                                       | `over` while a tab is dragged over it             |
| `favorites`      | The grid of favorites.                                         | `over` while a tab is dragged over it             |
| `favorite`       | One favorite.                                                  | `active`                                          |
| `tabbar`         | The bar of tabs on top, when the tabs are on top.              |                                                   |
| `pane`           | One terminal pane.                                             |                                                   |
| `pane-header`    | The header of a pane, when pane headers are on.                |                                                   |
| `palette`        | The command palette.                                           |                                                   |
| `library`        | The library of archived and closed tabs.                       |                                                   |
| `library-row`    | One tab of the library.                                        | `selected`                                        |
| `peek`           | The peek of a tab: its last lines in a popover beside it.      |                                                   |
| `settings`       | The settings screen.                                           |                                                   |
| `background`     | The picture behind the terminals, only while one is on screen. |                                                   |

#### Other attributes

| Attribute               | On                                              | Values                                                             |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `data-nr-focused`       | `pane`                                          | `true` or `false`, only in a tab that is split into panes          |
| `data-nr-selected`      | `item`                                          | `true` while the tab is part of a selection                        |
| `data-nr-pinned`        | `item`                                          | `true` for a pinned tab                                            |
| `data-nr-indicator`     | the marks on a tab                              | `running`, `failed`, `unread` or `bell`                            |
| `data-nr-side`          | the area that holds the sidebar and the content | `left` or `right`: the side of the sidebar                         |
| `data-nr-density`       | the area that holds the sidebar and the content | `comfortable` or `compact`                                         |
| `data-nr-window-effect` | the root of the window                          | `none`, `mica`, `acrylic` or `vibrancy`: the effect the window has |
| `data-nr-picture`       | the root of the window                          | `shown` while a picture is on screen; absent otherwise             |

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
- **The window and the background.** The pure parts are in `packages/model/src`: `window-effect.ts` (the effects, `interfaceOpacity`, the lowest opacity) and `background.ts` (`backgroundImageProblem`, `sniffImageMime`, `resolveBackground`). The space's picture is `Space.background` (`space/set-background`, checked and clamped by the reducer, read back by `state.json`). `Backend.setWindowEffect(effect, scheme)` and `Backend.readBackgroundImage(path)` are the two calls; `FakeBackend` takes `windowEffects` (what its system can paint) and `images` (files by path; `setImage` places one), and in the web build they are seeded under `noren.web.window-effects` (a list of effect names) and `noren.web.images` (path to base64), which is how the end-to-end tests give the page a system with Mica and a picture (`e2e/fixtures/background.png`).
- In `noren-core`, `window.rs` has the effects, the rule that falls back to an opaque window (`apply_effect` over a `WindowPainter`, tested with a fake painter) and the line for the log; `background.rs` has `path_problem` (the same cases as the TypeScript one), `sniff_image` and `BackgroundStore` (reads a picture: the path, the size and the first bytes are checked before a byte is returned). In the app, `window_effect.rs` paints with the `window-vibrancy` crate, called directly because the Tauri call drops the answer; the commands are `window_effect_set` (also sets the window theme to the scheme asked for) and `background_image_read` (a raw response, not JSON). The main window is `transparent` in `tauri.conf.json` (and `tauri.macos.conf.json`).
- In the interface: `window-effect-store.ts` (asks the backend for the effect and holds the answer), `background-image-store.ts` (reads the picture through the backend into a `blob:` address and keeps a few), `window-appearance.ts` (the pure merge of settings, theme and space into `windowVariables`), `use-window.ts` (follows the picture of the active space) and `WindowBackground.tsx` (the layer and the notice). `terminalTheme(theme, opacity)` gives the terminal its alpha.
- The fixtures of the tests (a scheme in each format, settings files with hidden profiles and profiles to import, files that are not valid) are in `packages/model/src/import-fixtures.ts`, also used by the end-to-end tests.
