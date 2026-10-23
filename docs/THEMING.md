# Your own themes, mods, and importing color schemes

Noren ships eight themes (see [CONFIG.md](CONFIG.md)). You can add your own in three ways: duplicate one in the **Themes** section of the settings screen, put a theme file in the themes folder, or import a color scheme from a file you already have, which writes that theme file for you. Beyond colors, a **mod** is a CSS file of yours that restyles the window itself; see [Mods](#mods-your-own-css) below, which also lists the variables and attributes a mod can rely on.

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

## The Themes section of the settings screen

The **Themes** section shows a card for every theme the window has, in a grid: the eight that ship with Noren first, then yours in order of name. Each card has a miniature drawn from the colors of its own theme (a title bar, a sidebar with the accent tab, a terminal with its prompt, the cursor and the colors of the ANSI palette), the name, whether it is dark or light and whether it is built in or yours, and the buttons that apply to it. The card of the theme in use for what you are choosing is pressed (it has the accent as its frame), and a small tag says where a theme is in use: **In use: whole app** and **In use: this space**.

Everything here acts at once, like the rest of the settings screen (which has no Save), because a theme is a file (or the same choice the palette makes), and each action tells what it did in a line under the gallery (a refusal is announced as an alert, the rest politely).

- **Using a theme.** Above the gallery you choose what a click is for, in a row of two buttons: **The whole app** or **This space** (the active space, named in the line under the choice; with no space the choice is not offered). A click on a card then writes `appearance.theme` (the comments of the file stay) or gives the space its own theme (saved with the space in `state.json`). The theme shows at once. **Follow the system** takes the choice of the app back to the light or dark theme of the system; **Use the theme of the app** takes the theme of the space away. A space that has a theme of its own keeps showing it, so with **The whole app** chosen the section says that the theme you pick shows in the other spaces. A refusal (the settings file has a problem of its own, or the disk refused) is said under the gallery.
- **Customize** (on the built-in cards) and **Edit** (on yours) open the [theme editor](#the-theme-editor): every group of the theme with a live preview, and **Save as my theme** to write it to the themes folder.
- **Duplicate** (on every card, the built-in ones too) writes a copy as a new file: the name is "<name> copy" (and " (2)", " (3)" when that name is taken), the id is the slug of the name with a number added when it is taken, and nothing else changes, so the copy looks exactly like the original until it is edited. The ids of the built-in themes and `system` are never given to a copy. The keyboard goes to the new card.
- **Rename** (yours only) opens a small dialog with the name selected. The id and the file stay, so the choice of the app and the themes of spaces that name it keep working. The name is cleaned like an imported one (blanks folded, ends trimmed) and is refused, with the sentence under the box, when it is empty or longer than 60 characters; Enter renames and Esc closes only the dialog, not the settings screen.
- **Export** (yours only) opens the save chooser of the system offering `<id>.json`, and writes the theme there: the same text as its file in the themes folder (the JSON of the theme, indented), with `.json` added to a name without that extension. Nothing is written when the chooser is closed, and the line says so. The page only hands the text over; it cannot choose the path, and the app only writes what the chooser gave it, a JSON object of at most 256 KiB.
- **Delete** (yours only) asks first, then removes `themes/<id>.json` and nothing else: the id has to be a theme id (so it can never name a path), a folder with that name is left alone, and the themes that ship with Noren are not files and have no Delete. The app and the spaces that named the theme fall back, by themselves, to the next choice (the theme of the app, then the system's); the settings file and `state.json` are not rewritten, so a theme with the same id imported later is in use again.
- **Import theme...** is **Import color scheme...** (below) with the same steps and the same line at the end: the format is told from what is in the file. A file exported by **Export** is read back whole (see "A theme of Noren itself" below).

Not verified in a real window: the save chooser of **Export** is the system's and no test opens it. The end-to-end tests use a fake one that they answer (a path, a closed chooser, a failure), and the Rust tests cover what the app writes, what it refuses and the name it offers; that the system chooser opens over the settings screen and writes where you point it is read from the code (`theme_export` in `apps/desktop/src-tauri/src/bridge.rs`) and has not been seen in a window. The gallery is checked in a browser and, since the editor round, in the real app: `pnpm shot` opens the settings screen from inside its page and takes the picture of the Themes section (see [The theme editor in the real app](#the-theme-editor-in-the-real-app)).

## The theme editor

**Customize** on a theme that ships with Noren and **Edit** on one of yours (both in the Themes section) open the editor: a dialog over the settings screen with the boxes of every group of a theme on the left, which scroll, and a preview of the theme on the right, which stays in sight with the buttons at the bottom. The dialog is drawn with the colors of the theme in force, never those of the theme you are editing, so a color you cannot read cannot make the editor unreadable. That is the layout of the dense style; under the glass style (the default) the editor is a card with the preview on the left and the boxes in a column on the right, see [The glass theme editor](#the-glass-theme-editor). The groups, the boxes and what they edit are the same in both.

| Group               | Boxes                                                                                                                                          | Field of the theme file                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Name and kind       | Name (1 to 60 characters, cleaned like a rename), Dark or Light                                                                                | `name`, `kind`                                                                                         |
| Accent color        | Accent                                                                                                                                         | `ui.accent`                                                                                            |
| Background and text | Background, Text, Muted text, Border                                                                                                           | `ui.bg`, `ui.text`, `ui.muted`, `ui.border`                                                            |
| Sidebar and panels  | Sidebar and panel color                                                                                                                        | `ui.surface`                                                                                           |
| Terminal            | Terminal background, Terminal text, Cursor, Selection, and the 16 colors of the palette (Normal and Bright side by side)                       | `terminal.background`, `terminal.foreground`, `terminal.cursor`, `terminal.selection`, `terminal.ansi` |
| Font                | Font names, Size (6 to 96 px), Line height (0.8 to 3), Ligatures                                                                               | `font.family`, `font.size`, `font.lineHeight`, `font.ligatures`                                        |
| Corners             | Corner radius (0 to 32 px)                                                                                                                     | `ui.radius`                                                                                            |
| Transparency        | Panel opacity (0 to 1), Panel blur (0 to 100 px)                                                                                               | `ui.opacity`, `ui.blur`                                                                                |
| Background picture  | Choose image... (the file chooser of the system), Remove, the path by hand, Picture opacity (0 to 1), Picture blur (0 to 100 px, may be empty) | `background.image`, `background.opacity`, `background.blur`                                            |

**The boxes.** A color is a swatch, which opens the color picker, and a box for its hex value: `#rgb`, `#rrggbb` or `rrggbb`, in any case; the selection also takes `#rrggbbaa` and keeps its alpha when the swatch changes its color, and an alpha in any other color is refused, not dropped. A number is a box with a slider (a comma works as the decimal point). Every box is held to the range the schema of the theme allows (the ranges in the table); a value that is not valid says why under its box, the preview keeps the last value that was, and **Save** waits ("Fix the boxes that say what is wrong before saving"). A name that is empty or longer than 60 characters is refused the same way.

**The preview** is the theme as a small window of its own: a title bar, a sidebar with the accent tab and two quiet ones, and a terminal with a prompt, output in the colors of the palette, a selected piece of text, the cursor and the sixteen colors as swatches, in the font, the corners and the transparency the theme says (the sample line `=> != >= ->` shows the ligatures). With a picture the picture shows behind the terminal under the veil of the window, with its opacity and blur, and the panels let it through the way the window does (at 55%, whatever the panel opacity says, because that is what the window does with a picture); without a picture the panels are as opaque as the panel opacity says, over a gradient that stands for what the system paints behind a window that lets it through. The preview is a picture of your colors, not text of the page: its words are generated content, it is hidden from a screen reader (the boxes beside it hold every value it shows), and an accessibility check does not hold the sample to a contrast, since a low one is your choice. What it does not show is the Mica or Acrylic of the system, which only the real window can.

**The font is saved but the terminal does not use it yet.** The `font` of a theme is part of the format and the editor edits it and shows it in the preview, but the terminal of the app takes its font from `terminal.font` in the settings file (see "What a theme gets" below and [CONFIG.md](CONFIG.md#the-terminal)): the defaults of the two differ (14 px, line height 1 and no ligatures for the terminal; 13 px, 1.2 and ligatures for the themes), so using the font of the theme would change every terminal. The editor says so under the Font group.

**Warnings about contrast** appear under the preview while a pair of colors reads worse than the built-in themes do: the text on the background (4.5:1), the text on the panels, the muted text and the accent on the background (3:1 each) and the terminal text on the terminal background (4.5:1). They only warn; the editor still saves the theme.

**Saving.** Nothing is written while you edit: the preview is the only thing that changes. **Cancel** and Esc (which close only the editor, not the settings screen) throw the changes away, and the next time the editor opens it starts from the theme as it is saved.

- On a theme that ships with Noren the one button is **Save as my theme**: it starts as "<name> copy" and writes a new theme of yours, `themes/<id>.json`, with the slug of the name as the id (a number is added when it is taken, and the ids of the built-in themes and `system` are never given), checked against the schema before it is written, in the text every theme file has.
- On a theme of yours **Save changes** writes over it: the id and the file stay, so the choice of the app and the themes of spaces that name it keep working, and the window shows the new look at once when it is the theme in use. A new name is kept (the id stays). **Save as a new theme** leaves it as it is and writes a copy under the new name.
- The card is in the gallery as soon as the file is on the disk, with a line under the gallery that says what was saved. A disk that refuses the file keeps the editor open with the reason and nothing in the folder.

Not verified in a real window: the color picker the swatch opens is the system's (a native popup) and no test opens it; the end-to-end tests set the value of the swatch, which is what the picker does when you choose a color. Dragging a slider with a real mouse is not either (the tests move it by value).

### The theme editor in the real app

`pnpm shot` (see [DEV.md](DEV.md#pictures-of-the-real-app)) opens the settings screen and the editor from inside the page of the real app and takes the picture: `themes.png` is the settings screen at its Themes section, `editor.png` is the editor of Noren Dusk with two of its boxes typed into (the run fails if the preview did not change when they were). The calls are made in the page (`click()` on the settings button and on the card, the `input` event on a box), never by the mouse or the keyboard of the system. What the pictures of the real app showed, for the first time: the gallery with its **Customize** buttons; the editor with its groups, the sixteen colors in two columns, the preview in the font of the theme with its ligatures, and the preview changing with the accent and a color of the palette; both in the light and the dark theme, in English and in Portuguese. Nothing was cut off or overlapped, and the text read well.

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

**A theme of Noren itself.** The JSON of a file of the themes folder, which is what **Export** writes (it is recognised by its `ui` and `terminal` parts, which a color scheme of another program does not have). It is not derived from colors: it is read against the whole schema, one that is not valid is refused with where it is wrong (`This theme file is not valid: ui.accent: Expected a color like #1a2b3c`) and writes nothing, and one that is valid keeps everything it says, the font, the radius and the background included. It keeps its id when no other theme has it; otherwise (an import of the same file twice, or an exported theme brought back to the window it came from) it takes a new id and name the way a copy does (`lagoon-2` and "Lagoon (2)"), so an import never replaces a theme of yours and never takes the id of a built-in one. A background picture in it is a path on the computer it was exported from, and shows only where that path exists.

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

(The **Themes** section has an **Import theme...** button that does the same for a scheme.) The **Import** section of the settings screen has both imports, **Import color scheme...** and **Import profiles...**. A scheme goes through the same steps as the palette action (a file picker, the format told from the content, one file per theme in the `themes` folder), and the sentence that says what happened shows under the buttons instead of in the corner of the window. Importing profiles is described next.

## Profiles in a settings file

The JSON reader also reads the shell profiles of a settings file (`profiles` as a list, or an object with a `list`): the name, the `commandline`, the `startingDirectory` and the `colorScheme` of each. A profile with `"hidden": true` is left out and counted, and one with no name is left out with a warning.

**Import profiles...** picks a file, reads it and **shows what it would add before anything is written**: every profile with its name and the command line that would start it, how many hidden profiles the file had (they are ignored), and the profiles that were read but cannot be imported, with the reason (a profile with no command line has nothing to start). Nothing is written until you press **Import N profiles**; **Cancel** and Esc write nothing. Importing only adds to the list: it never starts a shell and never runs a command, and the command lines run only when you open a tab of that profile from the command palette (_New ... tab_).

What each profile becomes (an entry of `profiles` in `config.jsonc`, see [CONFIG.md](CONFIG.md#profiles)):

- the **command line** is split into the program and its arguments by the rules of Windows (`CommandLineToArgvW`): the first word is the program (in double quotes it runs to the closing quote, spaces included, and its backslashes are plain), the rest are the arguments, separated by spaces and tabs, with double quotes grouping words and a backslash escaping a quote. `"C:\Program Files\Git\bin\bash.exe" --login -i` is the program `C:\Program Files\Git\bin\bash.exe` and the arguments `--login` and `-i`. `%NAME%` is kept as written and replaced by the environment variable when a session starts;
- the `startingDirectory` becomes `cwd`;
- the `colorScheme` is **not carried over**: a profile of yours has no color scheme of its own (the theme is chosen for the window or for a space), so a profile that used one of the schemes of the file starts with the theme in force. Import the scheme itself with **Import color scheme...** if you want it as a theme;
- the `id` is the name as a slug, and the name is the one in the file. An id that the machine's shells already have (for example `pwsh`), an id of a profile you already have, `default`, or another profile of the same file gets a number in the id and `(2)` in the name, so importing the same file twice makes more profiles and never replaces one.

The profiles go to the end of `profiles` in the file, keeping the comments and the layout of the file as every write from the settings screen does. If the file has a problem of its own, or the disk refuses the write, the preview stays open with the reason and nothing is written. A file over 1,000,000 bytes is not read.

## The interface style: glass and dense

`appearance.style` of `config.jsonc` chooses how the whole window looks beyond its colors: `glass` (the default) or `dense`. Choose it in **Appearance > Interface style** of the settings screen (a row of two buttons, **Glass** and **Dense technical**) or with the palette command **Toggle interface style**. It changes the open window at once and writes only that key, so the comments and the rest of the file stay (see [CONFIG.md](CONFIG.md)).

|            | Glass                                                                                           | Dense technical                                                |
| ---------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| What it is | Panels of glass over the picture of the window: rounded cards with a gap, blurred, veiled lines | Square corners, 1 px solid lines, small controls, a status bar |
| Type       | Geist for the interface, Geist Mono for shortcuts and code                                      | JetBrains Mono for everything                                  |
| Highlight  | `#5EE6C8`, then `#A99BFF`, `#F5B84B` and `#FF8FA3`                                              | `#2EE6D6`, then `#B4FF39`, `#FFB547` and `#FF5CA8`             |
| Corners    | 14 px the sidebar, 12 px the panels, 10 px the controls                                         | none on the panels, 3 px on the controls                       |

The style never changes the colors of the theme. The lines and the glass are worked out from the theme (`--nr-bg`, `--nr-surface`, `--nr-text`, `--nr-border`), so every theme, dark or light, works in either style. The one thing both have a say in is the corner radius `--nr-radius`, which the components that are not redrawn yet still read: it is the radius of the theme under glass and at most 3 px under dense, so a theme that asks for round corners gets square ones in the dense style.

The root element of the window carries the style as `data-nr-style="glass"` or `data-nr-style="dense"`, and the token set of that attribute (the table below) is what the stylesheet reads. Both sets have the same names, so a component never asks which style is on. The page starts as `glass` before the settings are read.

The new look comes in steps. The style itself is the first (task NOR-F20-17): the attribute, the two token sets, the fonts and the switch. The surfaces of the glass window are the second (task NOR-F20-18a, below): the window behind everything, the sidebar and the panes as cards of glass, the highlight, the controls and the opaque panels. The content of the sidebar is the third (task NOR-F20-18b, [the glass sidebar](#the-glass-sidebar)) and the header of a pane with the rings and the badge of an agent is the fourth (task NOR-F20-18c, [the glass pane](#the-glass-pane)). The settings screen is the fifth (task NOR-F20-19, [the glass settings screen](#the-glass-settings-screen)). The theme editor is the sixth (task NOR-F20-20, [the glass theme editor](#the-glass-theme-editor)). The dense style follows, one screen to a task: the main window with its status bar is the seventh (task NOR-F20-21a, [the dense window](#the-dense-window)); its settings screen and its theme editor come in the next tasks and are built on these tokens.

### The fonts

Geist, Geist Mono and JetBrains Mono ship inside the app (`apps/desktop/src/fonts.css`, from the `@fontsource` packages): when the window opens nothing is fetched from the network, which the policy of the app (`font-src 'self'`) would refuse anyway. They are the Latin subset in woff2, which covers English and Portuguese; any other script falls back to the font of the system. They are published under the SIL Open Font License 1.1, and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) has the attribution and the license text. A font that is missing falls back to the one the system has (`system-ui`, `Cascadia Mono`, `Consolas`).

The font of the terminal is a setting of its own (`terminal.font.family`) and is not changed by the style.

### Reduced transparency

With `prefers-reduced-transparency: reduce`, or when the system has its transparency effects turned off, the glass is opaque: the fills of the sidebar, the title bar and the panes are the solid `--nr-surface` and `--nr-bg` of the theme and the blur is off; the shape (corners, gap, line) stays. The dense style has no glass, so it is the same either way.

The web view does not always report the "Transparency effects" switch of Windows (Settings > Personalization > Colors) as that media feature, so the app asks for the switch itself: the `system_transparency_reduced` command of the shell reads the value `EnableTransparency` under `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` (read only, never written; 0 is off; anything else, or no value, is on) and the page puts the answer on the root element as `data-nr-transparency="reduced"`, which the stylesheet treats like the media feature. It asks when the window starts and each time it gains the focus, so a change made in the system settings while the app is open is followed when you come back. Other systems answer "on".

### The glass surfaces

Under the glass style (task NOR-F20-18a) the window is built from the tokens above, as in the approved design of the main window:

- **The window behind everything.** The picture of the person (see [the background picture](#the-background-picture)) or, when there is none, an illustrated backdrop: a night landscape (a sky, a moon, stars and three ridges of hills; `GlassBackdrop.tsx`, the part `glass-backdrop`) for a dark theme and a pale one of the same shapes for a light theme (the colors are `BACKDROP_PALETTES` in `interface-style.ts`). It is made of boxes and clip paths, nothing is fetched, it takes no click and a screen reader skips it. It is not drawn while a system effect (Mica, Acrylic) is behind the window: the effect is the window then. The blur of the **Background** section softens it as it softens a picture.
- **The sidebar** is a card with `--nr-radius-side` corners (14 px), `--nr-glass-side` as its fill, the filter `--nr-glass-blur-side` (`blur(30px) saturate(160%)`) over what is behind it, and a 1 px line, `--nr-line` (8% of the text color). **The title bar** is a strip of the same glass, flush with the top of the window.
- **The panels** are cards with `--nr-radius-panel` corners (12 px), `--nr-glass-panel` as their fill, `--nr-glass-blur-panel` (`blur(24px)`) and the same line: each pane of a tab, the bar of top tabs, the bar of favorites when it is at the top of the window, the Ask panel and the panel of a plugin. The terminal inside a pane draws no background of its own, so the glass shows; at an opacity of 1 it paints itself again, solid.
- **The gap**, `--nr-gap` (8 px), is around the cards and between them, and also where the panes of a tab meet (the line you drag to resize is that gap, lit in the highlight while it is pointed at). The terminal keeps a few pixels off the rounded corners of its card.
- **The highlight** is the color of the active space, `--nr-highlight`: the ring of the pane in focus (a tab with more than one pane) is that color at 55% and follows the corners of the card, and the line between panes lights up in it while it is dragged. It does not change `--nr-accent`, which stays the accent of the theme. Without a color of its own a space gets `--nr-style-accent`.
- **Transparency and blur follow the controls of the settings.** The **Interface opacity** slider moves the fills at once (the panels at its value, the sidebar and the title bar 0.2 less), and the blur slider of the **Background** section softens the backdrop or the picture at once, before the file has the number.
- **Opaque** with `prefers-reduced-transparency` and with the Windows transparency effects off (see [reduced transparency](#reduced-transparency)).
- **Readable over any picture.** The veil over a picture is 0.55 under glass, and with the defaults the text of the sidebar and of the terminal keeps 4.5:1 against the hardest pixel a picture can have (white under a dark theme, black under a light one) in every built-in theme whose own text has room for it (`glass.test.ts`, with the same sum the stylesheet paints); the end-to-end tests also measure it in the pixels of the page, over a white and a black picture and over the illustrated backdrop. Over any picture the secondary text keeps 3:1, and 4.5:1 over the backdrop.
- The dense style is not touched by this section: every rule of it sits under `:root[data-nr-style="glass"]` (a test holds it to that); the dense window has its own, [below](#the-dense-window).

The colors that differ between a dark and a light theme (the state colors, the backdrop) are picked with `data-nr-scheme` on the root, and not with `light-dark()`: the build of the app rewrites `light-dark()` to follow the color scheme of the system and not the theme.

### The glass sidebar

The content of the sidebar under the glass style (task NOR-F20-18b) follows the approved design of the main window, part by part, from the top of the card to its foot. The numbers are the design's; the colors are tokens (the text, the muted text pulled toward the text where it sits on a tint so it keeps 4.5:1, `--nr-highlight`, `--nr-state-running` and `--nr-state-waiting`), so every theme, dark or light, works. Nothing a part does changed: the keyboard, the mouse, the drag, the right click and what is saved are the same as under the dense style, and every part below is drawn only under `:root[data-nr-style="glass"]`.

- **The head** (`sidebar-head`): the brand (`sidebar-brand`: a 22 px mark in the color of the active space and the name) and the button that folds the sidebar (`sidebar-collapse`, 28 px). The button is the layout command **Toggle compact mode** of the palette: it writes `appearance.sidebar.compact`, so the sidebar leaves the layout and shows over it at the edge of the window; once folded the same button reads **Keep the sidebar open** and puts it back. It is not there with the tabs on top, where the sidebar always hides.
- **The search** (`sidebar-search`): a 38 px button that looks like a field. It opens the command palette, as the shortcut does, and shows that shortcut in a keycap (`keycap`, in the mono font: `Ctrl ⇧ P`), read from the shortcuts the person set, so a rebound key shows as it is. The keycap is for the eyes (it is hidden from a screen reader); the button carries the shortcut as `aria-keyshortcuts`. The sidebar is 200 px wide by default, so the button says **Search** and keeps the sentence **Search or run a command** as its tooltip; from 320 px the sentence is its text.
- **The favorites** (`favorites`, in the sidebar): a grid of four equal tiles, 50 px tall, 6 px apart, with the line of the style and the corners of a control; more tiles go on to the next row. A tile that needs the person or is busy has a state dot on its corner (`favorite-dot`, 7 px): amber (`data-nr-dot="waiting"`) for a favorite tab whose agent waits for you, green (`running`) for a tab with a command running or an agent working and for a project action that runs. The dot is also said in words, as the description of the tile. The bar at the top of the window (`data-nr-placement="top"`) keeps its row of tiles and takes the same look.
- **The card of the project actions** (`space-header`): the mark of the space (its color), its name and "project actions", then one button per action, 30 px tall, one to a line at the default width and side by side when there is room for two. A running action is a green button with a stop mark and a dot on its corner; its name is still **Stop** and the name of the action.
- **The tabs** (`item`): a state dot at the start of the row (`item-dot`, 8 px: green running, amber waiting, a muted point idle), the title, and a second line (`item-meta`) with the folder, a middle dot and the branch, in 11.5 px. The row is 44 px at least (a third shorter in compact density), with the corners of a control; the tab on screen is a lit row. The marks a tab already had (the agent, a failed command, unread, the bell) stay at the end of the title line, and the line of the last command stays under the second line. A group is a quiet row with its count at the end.
- **The foot**: **New tab** is a quiet row with a plus and its keycap (`Ctrl ⇧ T`); under a line, `sidebar-base` holds the spaces (34 px, the active one lit), the buttons of a new space and of the space options, and the **Settings** button (`sidebar-settings`) at the right end. The title bar has no Settings button while the sidebar is docked under glass; with the sidebar folded (or the tabs on top) it has it again, so there is always exactly one button of that name on the page.
- **Long names** are cut by an ellipsis inside their own box (a tab title, a folder, a branch, a group, a space, the label of an action); nothing leaves the card or overlaps the row next to it, from the narrowest sidebar (180 px) to the widest (480 px).

### The glass pane

Under the glass style (task NOR-F20-18c) a terminal pane has a header of its own and two rings, as in the approved design of the window. Nothing the pane does changed: focus, keyboard, mouse, split, zoom, drag, the menu of the right click and what is saved are the same as under the dense style, and everything below is drawn only under `:root[data-nr-style="glass"]`.

- **The header** (`pane-bar`): a strip of 38 px at the top of the card of every terminal pane, a line under it (`--nr-line`) and the terminal under that. Its height never changes with what it says, so a command starting or an agent changing state does not resize the terminal. A browser, a preview and a diff pane have a bar of their own and get none, and neither does a pane in a window of a space. It holds, from the left:
  - **the folder** (`pane-folder`): the folder icon and the path in the muted text with its last segment in the text color and heavier (up to three segments, `~` for the home folder, the whole path as the tooltip; until the shell tells its folder, the folder of the space; `Terminal` when there is none). The head of the path is cut first, the last segment last;
  - **the branch** (`pane-branch`): a chip with the branch icon and the name of the git branch of the folder, left out when the folder is not in a repository;
  - **the command** (`pane-command`): a chip with the command that runs (a green dot, `data-nr-state="running"`) or, once it ended, the last one (a hollow dot, `done`, or `failed` with its `exit N`); left out until the shell tells a command;
  - **the badge** (`pane-agent-badge`): in amber, **Agent waiting for you**, only while an agent in the pane waits for the person. The words reach a screen reader once, from the status of the pane that already said them; the badge is for the eyes;
  - **the buttons** (`pane-bar-actions`) at the right end: **Split right** (`pane-bar-split-right`), **Split down** (`pane-bar-split-down`) and, in a tab with more than one pane, **Zoom pane** / **Restore pane** (`pane-bar-zoom`). They are 28 px, always in sight (the dense style has its own header with the same buttons, [below](#the-dense-window); the hover corner of the first versions is gone), and their tooltip carries the shortcut that does the same (`Split right (Ctrl+Shift+D)`), read from the shortcuts the person set. At the limit of panes of a tab (`terminal.maxPanes`) the two split buttons are off.
- **With the pane headers of the settings on** (`appearance.paneHeaders`) the header with the title, the menu, detach, zoom and close buttons keeps its place above the glass header and lets the glass through; its zoom button is then the only one of the pane, so no button has two of the same name.
- **The ring of the pane in focus** is the highlight, `--nr-highlight` (the color of the active space), at 55%, 1 px inside the card and following its corners; it is there in a tab with more than one pane, and the pane the mouse presses (the header too) takes it.
- **The ring of an agent** (`pane-agent-ring`) is a thin line inside the card in the color of what the agent does: **waiting** is the amber of the state (`--nr-state-waiting`, solid), **working** the green (`--nr-state-running`, it pulses unless the person asked for less motion) and **idle** the muted color, faint. The ring of the pane in focus is drawn over it.
- **Narrow panes.** The header is a container: below 300 px of header the branch and the command give way (the folder and the badge stay), below 240 px the badge keeps only its icon and the folder only its last segment, below 200 px the folder icon goes too, below 150 px only the buttons stay (24 px) and below 100 px zoom goes as well (its shortcut and the menu of the pane stay). A long folder, branch or command is cut by an ellipsis inside its own box; nothing leaves the header or reaches the buttons.
- **Readable over any picture.** The text of the header keeps 4.5:1 over the hardest pixel a picture can have (white under a dark theme, black under a light one): the chips use the text color pulled toward the color of their state, and the end-to-end tests measure it in the pixels of the page.

### The glass settings screen

Under the glass style (task NOR-F20-19) the settings screen is drawn as in the approved design of it. It is still the dialog over the window it was, with the same sections, the same search and the same keys (Tab, the arrows in the column, Esc, Enter in the search); what each field writes is untouched, and everything below is drawn only under `:root[data-nr-style="glass"]`: the dense screen keeps its size (960 by 720 px), its grid of 8 px and its markup.

- **The card** (`settings`): one card of glass over the window, 14 px corners (`--nr-radius-side`), the fill `--nr-glass-sheet` (the background of the theme at the opacity of the panes plus 0.12, so 74% by default: it is all text), `--nr-glass-blur-sheet` (`blur(28px)`), a line at 10% of the text color and a shadow (`--nr-sheet-shadow`). It is 1120 by 860 px at most and keeps the gap of the window (8 px) around it in a smaller one. The fill follows the transparency control of the **Window** section like the panes do, and is solid from 0.88 and under `prefers-reduced-transparency` or with the transparency effects of the system off.
- **The header**: 60 px, the title at 18 px, the search (`settings-search-field`: a frame of 36 px and 10 px corners with a magnifier in it; the frame shows the focus ring, not the box inside) and the X at the far end. The box is the same `settings-search`.
- **The column of sections**: 232 px, a 36 px row for each section with its icon (16 px, for the eyes only: a screen reader says the name) and the current one lit. A name that does not fit goes to a second line; it is never cut.
- **The content**: a column of 780 px at most, a heading of 15 px for each section and rows of a label (medium weight) with its explanation under it (12 px, muted) on the left and the control on the right, in a column of 260 px, 14 px over and under each row with a line between them. The controls are the ones of the design: a **switch** of 40 by 24 px with a 20 px knob (on, its track is the highlight; it is at the right end of the column), a **row of buttons** for a choice of two or three (they sit in a track with 3 px around them, 30 px tall, the chosen one lit), a **slider** with its number at the right end of its column in the mono font (the number is still a box you can type in; it looks like plain text until the pointer or the keyboard is on it, and it shows the number in force, muted, while the file has none), **boxes and lists** of 34 px with 9 px corners, and **buttons** of 34 px with 9 px corners. What is on, chosen or focused is `--nr-highlight`, the color of the space.
- **The cards of the interface style** (`settings-style`, `settings-style-card`): **Appearance** opens with two cards, each with a little picture of its style, a radio mark, its name and a line about it (**Glass**: translucent, rounded corners; **Dense technical**: compact, square corners). A card is a radio button: a click anywhere on it, Space and the arrows choose it, and a screen reader says the style and then the line. The pictures are drawings (the night landscape of the glass, the black and the line of the dense) and keep their colors in every theme: they are `--nr-sample-*` of `style-tokens.css`. The line the design puts under the title says the themes and colors stay in both. The dense screen has the same choice as a row of two buttons, as it had.
- **The picture of the background** (`background-picker`): a card with the miniature (112 by 68 px), the name of the file (`background-picker-name`, cut by an ellipsis inside its box), **Choose image...** (`background-choose`, tinted with the highlight: a solid fill could not keep its text at 4.5:1 for every color of a space and every theme) and **Remove** (`background-remove`). It is above the box that takes a path typed by hand.
- **The themes**: the cards of the gallery have 10 px corners, a name under the miniature and a line of the highlight on the one in use; what can be done with a theme (**Customize**, **Duplicate**, **Rename**, **Export**, **Delete**) stays under its card.
- **A narrow window** gives the column of sections 168 px and the content a smaller padding below 760 px; the control column gives way to the labels (at most 55% of the content). Nothing leaves its box and nothing scrolls sideways.

What the design shows and the app has no data for is left out: the size, the dimensions and the scope of the picture ("2560 x 1440 · 1.8 MB · applies to every space"), the option **Hidden** of the favorites bar, a "Use only in the space..." switch for the theme (the choice is the row of two buttons of the **Themes** section) and the **Create theme** and **Edit theme** buttons of the gallery (the editor is the **Customize** and **Edit** of each card, and has its own task). The design has ten sections; the app has fifteen, each in its own part (`settings-<section>`).

### The glass theme editor

Under the glass style (task NOR-F20-20) the [theme editor](#the-theme-editor) is drawn as in the approved design of it. It is still the dialog over the settings screen it was, with the same nine groups, the same boxes and the same keys (Tab, Esc, Enter in a box); what it edits, what the preview draws and what **Save as my theme** writes are untouched, and everything below is drawn only under `:root[data-nr-style="glass"]`: the dense editor keeps its dialog of 1040 px with the name in its first group, the hint under the title and the buttons under the boxes.

- **The card** (`theme-editor`): a card of glass like the settings screen (14 px corners, `--nr-glass-sheet`, `--nr-glass-blur-sheet`, a line at 10% of the text color and `--nr-sheet-shadow`), 1120 by 860 px at most and keeping the gap of the window (8 px) around it in a smaller one. The fill follows the transparency control like the settings screen does, and is solid under `prefers-reduced-transparency` or with the transparency effects of the system off.
- **The header**, 60 px: the title (18 px), the name of the theme in a frame of 34 px with its label inside (the frame shows the focus ring, takes the highlight for its line while the name is refused, and the reason shows under the frame, the header growing to hold it) and, at the right end, the buttons: **Cancel**, **Save as a new theme** (on a theme of yours) and **Save as my theme** or **Save changes**, which is filled with the highlight; its text is `--nr-on-highlight`, dark, which keeps 4.5:1 on every color a space can have. The buttons come after the boxes in the page, as the buttons of a dialog do, so Tab goes through the boxes first and the buttons last; the style sheet draws them in the header.
- **The preview**, on the left, takes what the column leaves: its title, the sentence that says what it does and the reading of the contrast of the text on the background (`theme-editor-contrast`: "Text contrast 14.5 : 1", green with a check while the text holds the 4.5:1 the editor warns about, amber with a warning mark under it; `data-nr-state` is `ok` or `low`). The preview is the window it always drew (`theme-preview`, the same parts and variables), now filling its frame, over the night landscape of the design (the sky, the ridge and the moon, drawn in the frame with `--nr-sample-glass-*`), which stands for what the system paints behind a window that lets it through.
- **The column of boxes**, on the right, 360 px, scrolls on its own: the nine groups one under the other, each with a title of 13 px (the first, the kind of the theme, is a row with a label and a track of two buttons; its title is for a screen reader). A color is **one box of 30 px** with the swatch (22 px, 6 px corners) and the hex value in the mono type; they are still two controls, the swatch opens the color picker and the hex is a box to type in. The sixteen colors are eight rows of a name and two such boxes. A number with a range is its label (112 px), the slider, filled with the highlight up to the handle, and its number at the right end (48 px, mono, still a box to type in). The ligatures are a switch of 40 by 24 px with a knob of 20. The font names and the path of the picture are boxes of 30 px. The picture is a card with its miniature (54 by 36 px), the name of the file and the buttons **Choose image...**, tinted with the highlight, and **Remove**.
- **A narrow window**: below 860 px the preview goes above the boxes and the body scrolls as one; below 760 px the buttons take a row of their own under the title and the name. Nothing leaves the card and nothing scrolls sideways.
- **The switch in the dense editor** (finding 352) was 2 by 2 px: `--su`, the unit the switch is drawn in, was only defined in the settings dialog and the editor is not inside it. The editor defines it now, in both styles, so its switch is 40 by 24 px in the dense one too.

What the design shows and the app has no data for is left out: the list of themes on the left ("My themes" and "Built in": the editor edits one theme, and the gallery is the list), the **Undo**, **Duplicate** and **Export** buttons of the header (the editor has no undo, and duplicating and exporting are on the card of each theme), the back arrow (**Cancel** is the way back), a cursor "same as the accent" and a selection "at 28%" (the boxes hold the values of the theme file: `terminal.cursor` and `terminal.selection` are colors) and the sixteen colors as a grid of squares without their values (each color keeps its box for the hex value). The design has three groups (Interface, Terminal, Shape and glass) and the card of the picture; the app has nine groups, which the picture tool (`--editor-group`), the tests and the screen reader use.

### The dense window

Under the dense style (task NOR-F20-21a) the main window is drawn as in the approved design of it (`denso-janela`): square corners, lines of 1 px (`--nr-line`), JetBrains Mono for everything, and the highlight, the color of the active space (`--nr-highlight`), where the design has its accent; a space starts from `#2EE6D6` and the new-space dialog offers the four colors of the design (Cyan `#2EE6D6`, Lime `#B4FF39`, Apricot `#FFB547`, Fuchsia `#FF5CA8`) after the older twelve, so the default stays Blue. Nothing a part does changed: the keyboard, the mouse, the drag, the right click and what is saved are the same as under glass, and every rule of the section sits under `:root[data-nr-style="dense"]` (a test holds it to that, and holds it free of a literal color: the colors are tokens, a mix of tokens or the four worked out from the theme below). Switching the style in **Appearance** changes the window at once, with the settings screen still open, and the glass window is as it was.

The window reads from the head to the foot:

- **The title bar** is 32 px: the brand (the mark in the highlight and **Noren** in capitals), where you are as a breadcrumb (`titlebar-crumbs`: the space, the group of the tab on screen when it is in one, and the tab, `SITE / api / pnpm dev`, the last in the text color and marked `aria-current`), the button of the palette (`titlebar-palette`, 22 px: **commands** and its shortcut in a keycap, `ctrl+⇧+p`, read from the shortcuts the person set; it also carries `aria-keyshortcuts`) and the window buttons (44 px). In a narrow window the shortcut leaves the button first (below 640 px), then its word (below 440 px).
- **The bar of the favorites and the actions** (`dense-toolbar`) is 30 px under the title bar, the width of the window, and wraps in a narrow one. The favorites (`favorites`) are chips of 22 px with their name (`favorite-label`): a favorite tab, a profile (a terminal mark) and a project action (a play mark); a state square (`favorite-dot`, 6 px) comes before the name while an agent in the tab waits (amber) or a command, an agent or an action runs (green). With none the bar says how to add one, in one line. The project actions (`space-header`) are at the right end after the word **actions**: a button for each, its mark (a filled triangle, a filled square while it runs) and its label; a running one has the green of the state. The setting of the place of the favorites (`appearance.favorites`) is for the glass style: under dense they are always here.
- **The sidebar** has the spaces as tabs along its top (`space-switcher`, 30 px: a square in the color of the space and its name in capitals; the active one in bold with a line of the color of the space under it), then the tree in rows of 24 px (20 px in compact density): a state square (`item-dot`, 6 px: green running, amber waiting, hollow at rest), the title and, at the end, the branch in the muted text; a tab whose agent waits says so in a word (`item-waiting`) in place of the branch. The folder and the command of a tab are in the header of its pane and are not drawn in the row; the drawing of the layout of a split tab and the marks of what runs are left out (the dot says it, and the panes are listed under the tab). A group is a quiet row with its count at the end. **New tab** is a row with a plus and its shortcut (`ctrl+⇧+t`) at the end; at the foot, **Agents** lists the agents of every space (`sidebar-agents`: a diamond in the color of what the agent does, its name, how it is and for how long; the ones that wait first, and a click goes to it) and **Settings** is the last row (`sidebar-settings`, 28 px, under a line). The title bar has no Settings button while the sidebar is docked, as under glass, so there is exactly one button of that name on the page.
- **The panes** are one pixel apart (the line you drag to resize is that pixel, lit in the highlight while it is pointed at) and the one in focus has a ring of the highlight. Each terminal pane has a **header** (`pane-bar`, 24 px): its number in the tab (`pane-number`, the one in focus lit), what runs (`pane-command`: the command, else the word **Terminal**), its folder (`pane-folder`, muted), how the command is (`pane-state`: a dot and **running** in green, or `exit N` for a failed one; `data-nr-state` `running` or `failed`), the badge **Agent waiting for you** in amber (`pane-agent-badge`, with the header tinted amber and the ring of the pane in amber) and, at the right end, **Split right**, **Split down** and, in a tab with more than one pane, **Zoom pane** / **Restore pane** and **Close pane** (`pane-bar-close`; a tab of one pane has no close, since closing its only pane would close the tab). They are 22 by 20 px, always in sight, with their shortcut in the tooltip. The branch is in the status bar, not in the header. The header is a container: below 300 px the folder gives way, below 240 px the state, below 150 px only the buttons stay and below 100 px zoom and close go as well; with the badge on, the folder and the state go below 480 px. With the pane headers of the settings on (`appearance.paneHeaders`) that header keeps its place above and its zoom and close buttons are the only ones of the pane.
- **The top tabs** (`tab-bar`) are 30 px with a line of the highlight under the one on screen and square corners; the toolbar is above them and the status bar below the panes.
- **The status bar** (`status-bar`) is at the foot of the window, 24 px, the width of it: the space in its color with dark text (`status-space`, the text of a button filled with the highlight, which keeps 4.5:1 on every color a space can have), the folder (`status-folder`) and the branch (`status-branch`) of the pane in focus, a diamond and the number of agents that wait for you in amber (`status-agents`) and, at the right end, how many panes the tab on screen holds (`status-panes`). It follows the pane in focus and the tab on screen, and wraps in a narrow window.
- **Long names** are cut by an ellipsis inside their own box (a tab title, a branch, a space, a favorite, an agent, a command, a folder); nothing leaves the sidebar or overlaps the row next to it from the narrowest sidebar (180 px) to the widest (480 px) (finding 343: the wide font of the dense style cut names at the edge of the 200 px sidebar).

What the design shows and the app has no data for is left out: the time a command or an agent has run in a tab or a pane (the app tells how long an agent has waited, which is in the list of agents), the commits a branch is ahead of its remote, the kind of a profile in front of a tab (`wsl`, `ssh`), the name of an agent in the header of its pane, the button **+ favorite** (a favorite is added by dragging a tab, by the menu of a tab, an action or a profile, or from the palette), and the status of the machine and the toolchain at the foot (the load, the memory, the version of the runtime and the clock). The shortcut of the settings (`ctrl+,`) is not drawn because the settings have no key by default; it shows once the person gives them one.

The window uses five values worked out from the theme, the same in both styles, defined in `style-tokens.css` beside the token sets: `--nr-bar-bg` (the strip of the toolbar), `--nr-chip-bg` (a chip), `--nr-head-bg` (the header of a pane) and `--nr-waiting-text` and `--nr-running-text` (the amber and the green of the states pulled toward the text where they are the color of words, so they keep 4.5:1 on a dark and on a light theme). A color that is a word is never the highlight itself, which can be any color: the space chip of the status bar uses dark text on it, and the number of the pane in focus is the highlight pulled toward the text.

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
- Without a value (or with `null`) under the **glass** style: 0.62, whatever is behind the panels (the picture, the illustrated backdrop or a system effect). The sidebar and the title bar are 0.2 less opaque (0.42), never under 0.2, and solid when the panels are, so a slider at 1 gives a plain opaque window.
- Without a value under the **dense** style: solid, except while the window has an effect, when it is the `ui.opacity` of the theme (0.92 for the built-in themes), and while a picture shows behind the window (below), when it is 0.55, so the picture shows through the sidebar and the terminals. A picture that could not be read does not count: the panels stay solid, since nothing would show through them.
- The **Window** section of the settings screen has a slider for it next to its box. The slider shows its effect in the window at once and the file has the number when you stop moving it; closing the screen keeps it.
- It is applied by the variable `--nr-opacity` (and `--nr-bg-glass`, `--nr-surface-glass`; see the table of variables below), which a mod can use.
- Why 0.3 is the lowest: a test holds every built-in theme to a contrast of 4.5:1 for its text and 3:1 for its muted text, in the interface and in the terminal, at the lowest opacity over the extreme backdrop of its own kind (black for a dark theme, white for a light one). What shows behind the window decides the rest; a backdrop of the other kind cannot be made readable by any opacity, which is why the effect follows the theme.

### The background picture

A picture can sit behind the terminals. It comes from the first of these that has one, and each part (the file, how much of it shows, how blurred it is) is taken from the last layer that says it:

1. the **theme**: `background.image`, `background.opacity` and `background.blur` in the theme file (the built-in themes have no picture);
2. the **settings file**: `appearance.background` (`image`, `opacity`, `blur`), where `"image": null` says no picture even if the theme has one;
3. the **space**: the picture of the space, chosen in its menu (**Background image...**), kept in `state.json`. **Remove background image** in the same menu gives the space back to the layers above.

| Part      | Range                  | When nothing says                                     |
| --------- | ---------------------- | ----------------------------------------------------- |
| `image`   | a file path, see below | no picture                                            |
| `opacity` | 0 (not seen) to 1      | 0.6 (the `background.opacity` of the built-in themes) |
| `blur`    | pixels, 0 to 100       | 0                                                     |

**Only a local file.** The path is an absolute path, or a path inside the config folder (`backgrounds/sky.jpg`, next to `config.jsonc`). Noren refuses, when it reads the file and again in the part that opens it:

- a web address or any other scheme (`http:`, `https:`, `file:`, `data:`, `blob:`), and a network path (`\\server\share\sky.png`): nothing is ever fetched, and nothing reaches the network;
- a path inside the config folder with `..` in it, so it cannot climb out of the folder;
- a name that does not end in `png`, `jpg`, `jpeg`, `webp`, `gif` or `bmp`;
- a file larger than 32 MiB, a folder, or a file whose first bytes are not those of one of those pictures (the name is not trusted: a text file called `sky.png` is refused, and so is a `.svg`).

In a theme file or in `config.jsonc` a refused path makes the theme or the file invalid, with the reason (and the line, for the file). In a space, or when the file cannot be read (it was moved, it is not a picture), the picture is left out and a notice says why; the rest of the window is not affected.

The picture is read by the app (the page is never given a path or an address to fetch: it gets the bytes and shows them from memory), so the file is read again only when the path changes. The picture is drawn under everything, covering the window, and what shows is built in layers, from the bottom:

1. **What the picture is drawn on**: the solid background of the theme (`--nr-background-backing`). While the window has an effect it is the glass of the window instead, so Mica or Acrylic still shows through.
2. **The picture**, at its opacity and blur.
3. **The veil**: the background of the theme again, drawn over the picture at 0.4 (`--nr-background-veil`; 0.55 under the glass style, whose panels let more through), whatever the opacity of the picture is. It is dark on a dark theme and light on a light one, and keeps the text readable on a bright or busy picture even with the opacity at 1.
4. **The panels**, painted over all of it at the opacity of the interface (0.55 while a picture shows and the settings say nothing): the title bar, the sidebar, the tab bar and the favorites bar when it is at the top of the window (`appearance.favorites`) with the `--nr-surface-glass` color, and each terminal with a pane of glass of its own, the background of the terminal at that opacity (`--nr-terminal-glass`). The picture shows through all of them, and **the sidebar, the tab bar and the favorites bar on top blur what they let through** (`ui.blur` of the theme, 18 px for the built-in ones). The terminal does not blur: it repaints all the time, and a blur behind it would be redone for every frame.

The terminal itself draws no background while a picture shows (xterm.js gets a see-through theme), and the opacity of its pane is a CSS color, so moving the opacity of the interface never repaints a terminal. The **Background** section of the settings screen has a slider for the opacity of the picture and one for its blur, and the dialog of a space (**Background image...**) has the same two: they show their effect at once on the window, before **Save** or **Apply**, and **Cancel** takes it back. Typing in the box next to a slider moves the slider and the window too (half a number on the way, such as `0.`, leaves the window as it was).

**Text over the picture.** With the defaults, the text of the sidebar and of the terminal keeps a contrast of at least 3:1 (the level for large text) against the hardest pixel a picture can have (white under a dark theme, black under a light one) in every built-in theme, at least 3.5:1 against a mid-tone pixel, and 4.5:1 against the hardest pixel in the themes whose own text has room for it; a test (`background-panel.test.ts`) measures it with the same sum the stylesheet paints. A theme whose text is already close to 4.5:1 on its own background (Dune, for one) has no room to spare, and a picture that is very light under a light theme, or very dark under a dark one, is the easy case. If a picture is hard to read on, lower its opacity, raise the opacity of the interface or blur the picture.

### Variables and attributes

`--nr-opacity`, `--nr-bg-glass`, `--nr-surface-glass`, `--nr-terminal-glass`, `--nr-panel-blur` and the five `--nr-background-*` variables are in the table of variables below; `data-nr-window-effect` on the root of the window says which effect the window has (not the one that was asked for), `data-nr-picture="shown"` is there while a picture is on screen, and the picture itself is the part `background`, with `background-backing` under it and `background-veil` over it.

### Not verified in a real window

How Mica, Acrylic and vibrancy look, and that the window with no effect looks the same now that it is created see-through (its corners, its shadow and the first frame before the page paints), have not been seen in a window: the Mica of the system and the desktop behind a see-through window are not part of the picture that the web view gives (see below). What was run on the real app is `pnpm smoke`, which gives the hidden window its effect and prints what the system answered.

#### What the pictures of the real app showed

`pnpm shot` (see [DEV.md](DEV.md#pictures-of-the-real-app)) takes the picture of the main window from its own web view, with the window out of sight. It holds what the page paints, so it shows the interface, the terminal and the picture behind them, and does not show the Mica or Acrylic behind the window or what the desktop would show through a see-through window. The first pictures (a settings file with `appearance.background` at 0.6, `appearance.window.opacity` 0.7 and the Dusk theme) showed, in the real app and for the first time:

- **The picture and the see-through interface work in the sidebar and the title bar:** the picture shows through both, at the opacity of the interface, and the text stays readable.
- **The terminal was not see-through, and now is.** Its area was a solid black block that hid the picture. The cause was not the WebGL renderer: xterm.css gives the scrolling box of a terminal (`.xterm-viewport`) a solid `#000` background, the version of xterm.js the app uses paints the color of the theme only on the element inside that box, and so a terminal drawn with a see-through background showed the black of the box behind it, in the real app and in the browser alike, with either renderer. The style of Noren now gives that box no color, and the pane of the terminal is glass of its own (see above). A browser test reads the pixels of the page to check it (the picture really reaches the terminal), and fails without the fix.
- **A picture named in the settings file the app starts with did not show, and now does.** The page asked for the picture before the store that reads it had been given its backend, was answered "No backend is available to read the image.", and took the path as already asked for, so it never asked again. The request now waits for the backend. `pnpm shot --settings <file> --image <png> --name <name>` starts the app with the picture already in the settings, which is the check that catches it.

With the picture at the defaults (0.6, the veil, the panels at 0.55 and the blurred sidebar) the real app shows, for both the Dusk and the Paper theme: the picture behind the sidebar, the title bar and every terminal, the prompt in full contrast, and nothing cut off or overlapping, also in a tab split into three panes.

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

| Variable                  | What it holds                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--nr-bg`                 | Background of the window.                                                                                                                          |
| `--nr-surface`            | Background of the surfaces on top of it: the sidebar, the title bar, the dialogs.                                                                  |
| `--nr-text`               | Text.                                                                                                                                              |
| `--nr-muted`              | Secondary text.                                                                                                                                    |
| `--nr-accent`             | The accent of the theme.                                                                                                                           |
| `--nr-border`             | Lines and borders.                                                                                                                                 |
| `--nr-radius`             | The corner radius, with its unit (`10px`).                                                                                                         |
| `--nr-space-color`        | The color of the active space, or the accent when it has none.                                                                                     |
| `--nr-opacity`            | How opaque the interface is, a number from 0.3 to 1 (see [the opacity](#the-opacity-of-the-interface)).                                            |
| `--nr-bg-glass`           | `--nr-bg` at that opacity: what the window itself is painted with (solid under glass with no system effect, where the backdrop covers the window). |
| `--nr-surface-glass`      | `--nr-surface` at that opacity: what the title bar, the sidebar and the bars on top are painted with.                                              |
| `--nr-background-image`   | The picture behind the terminals as `url(...)`, or `none`.                                                                                         |
| `--nr-background-opacity` | How much of the picture shows, a number from 0 to 1.                                                                                               |
| `--nr-background-blur`    | How blurred the picture is, with its unit (`6px`).                                                                                                 |
| `--nr-background-veil`    | How much of `--nr-bg` is drawn over the picture, a number from 0 to 1 (0.4; 0.55 under glass).                                                     |
| `--nr-background-backing` | What the picture is drawn on: `--nr-bg`, or its glass while the window has an effect.                                                              |
| `--nr-terminal-glass`     | The background of the terminal at the opacity of the interface: the pane of a terminal over a picture.                                             |
| `--nr-panel-blur`         | How much the sidebar blurs the picture it lets through, with its unit (`18px`, the `ui.blur`).                                                     |

#### Style variables

The token set of the interface style (see [the interface style](#the-interface-style-glass-and-dense)): the root element has the set of its `data-nr-style`, so these have a value whatever the theme is. A mod may read them and may set them on the root to change a style.

| Variable                | Glass                                                | Dense                          | What it holds                                                                              |
| ----------------------- | ---------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `--nr-font-ui`          | Geist                                                | JetBrains Mono                 | The font of the interface, with the fonts it falls back to.                                |
| `--nr-font-mono`        | Geist Mono                                           | JetBrains Mono                 | The font of shortcuts, paths and code in the interface.                                    |
| `--nr-font-size`        | `13px`                                               | `12px`                         | The size of the text of the interface.                                                     |
| `--nr-font-size-small`  | `12px`                                               | `11.5px`                       | The size of secondary text.                                                                |
| `--nr-radius-side`      | `14px`                                               | `0px`                          | The corners of the sidebar.                                                                |
| `--nr-radius-panel`     | `12px`                                               | `0px`                          | The corners of the panels (the terminals, the dialogs).                                    |
| `--nr-radius-control`   | `10px`                                               | `3px`                          | The corners of buttons, fields and rows.                                                   |
| `--nr-radius-chip`      | `99px`                                               | `3px`                          | The corners of small labels (the branch, the state of a command).                          |
| `--nr-gap`              | `8px`                                                | `1px`                          | The space between the sidebar and the panels, and between panels.                          |
| `--nr-row-height`       | `44px`                                               | `24px`                         | The height of a row of the tree of tabs.                                                   |
| `--nr-control-height`   | `32px`                                               | `22px`                         | The height of a button of a bar.                                                           |
| `--nr-line`             | 8% of `--nr-text`                                    | `--nr-border`                  | Thin lines and the borders of cards.                                                       |
| `--nr-line-strong`      | 14% of `--nr-text`                                   | 20% of `--nr-text` on the line | The borders of controls.                                                                   |
| `--nr-style-accent`     | `#5EE6C8`                                            | `#2EE6D6`                      | The highlight the style starts from (the accent of the theme stays `--nr-accent`).         |
| `--nr-highlight`        | the color of the active space                        | the color of the active space  | The highlight of the window: the ring of the pane in focus, the handle that is dragged.    |
| `--nr-state-running`    | `#7EE2A8` (dark), `#1E8F5A` (light)                  | `#4ADE80` (dark), `#15803D`    | The dot of a tab with a command running.                                                   |
| `--nr-state-waiting`    | `#F5B84B` (dark), `#B7791F` (light)                  | `#FFB547` (dark), `#B45309`    | The dot of a tab that waits for you.                                                       |
| `--nr-glass-side`       | `--nr-surface` at 0.2 less than `--nr-opacity` (42%) | `--nr-surface`                 | What the sidebar and the title bar are filled with.                                        |
| `--nr-glass-panel`      | `--nr-bg` at `--nr-opacity` (62%)                    | `--nr-bg`                      | What the panels are filled with.                                                           |
| `--nr-glass-blur-side`  | `blur(30px) saturate(160%)`                          | `none`                         | The backdrop filter of the sidebar.                                                        |
| `--nr-glass-blur-panel` | `blur(24px)`                                         | `none`                         | The backdrop filter of the panels.                                                         |
| `--nr-glass-sheet`      | `--nr-bg` at `--nr-opacity` plus 0.12 (74%)          | `--nr-bg`                      | What the card of the settings screen is filled with: a little more opaque, it is all text. |
| `--nr-glass-blur-sheet` | `blur(28px)`                                         | `none`                         | The backdrop filter of the card of the settings screen.                                    |

#### Parts

`data-nr-part` names what an element is. `data-nr-state` (where the table gives values) says what state it is in, and is absent when the element is in none.

| `data-nr-part`           | What it is                                                                                             | `data-nr-state`                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `sidebar`                | The sidebar.                                                                                           | `revealed` or `hidden`, only with compact mode on |
| `space-switcher`         | The row of spaces at the foot of the sidebar.                                                          |                                                   |
| `sidebar-head`           | The head of the glass sidebar: the brand and the button that folds it.                                 |                                                   |
| `sidebar-brand`          | The mark and the name at the head of the glass sidebar.                                                |                                                   |
| `sidebar-collapse`       | The button that folds the glass sidebar (compact mode), not there with the tabs on top.                |                                                   |
| `sidebar-search`         | The button of the glass sidebar that opens the command palette.                                        |                                                   |
| `keycap`                 | The keycap of a shortcut beside a row of the glass sidebar (the search, New tab).                      |                                                   |
| `sidebar-base`           | The foot of the docked glass sidebar: the spaces and the settings button.                              |                                                   |
| `sidebar-settings`       | The settings button at the foot of the glass sidebar.                                                  |                                                   |
| `space-header`           | The card of the project actions of the active space, when it has any.                                  |                                                   |
| `item-dot`               | The state dot at the start of a tab in the glass sidebar.                                              |                                                   |
| `item-meta`              | The second line of a tab: the folder and the branch.                                                   |                                                   |
| `item`                   | A tab, in the sidebar or in the bar on top.                                                            | `active`                                          |
| `item-title`             | The title inside a tab.                                                                                |                                                   |
| `group`                  | A group of tabs.                                                                                       | `expanded` or `collapsed`                         |
| `pinned-list`            | The list of pinned tabs.                                                                               | `over` while a tab is dragged over it             |
| `favorites`              | The bar of favorites, always on screen.                                                                | `over` while a tab is dragged over it             |
| `favorites-hint`         | The line that says how to add a favorite, only while none is.                                          |                                                   |
| `favorite-dot`           | The state dot on the corner of a favorite tile in the glass style, only while it is waiting or busy.   |                                                   |
| `favorite`               | One tile of the bar: a favorite tab, a profile or an action.                                           | `active`, `running` or `unavailable`              |
| `tabbar`                 | The bar of tabs on top, when the tabs are on top.                                                      |                                                   |
| `pane`                   | One terminal pane.                                                                                     |                                                   |
| `pane-header`            | The header of a pane, when pane headers are on.                                                        |                                                   |
| `pane-bar`               | The header of a terminal pane in the glass style: the folder, the branch, the command and the buttons. |                                                   |
| `pane-folder`            | The folder in the header of a glass pane.                                                              |                                                   |
| `pane-branch`            | The branch chip in the header of a glass pane, only while the folder is in a repository.               |                                                   |
| `pane-command`           | The command chip in the header of a glass pane, only after the shell told a command.                   | `running`, `done` or `failed`                     |
| `pane-agent-badge`       | The amber badge "Agent waiting for you" in the header of a glass pane, only while one waits.           |                                                   |
| `pane-bar-actions`       | The buttons at the right end of the header of a glass pane.                                            |                                                   |
| `pane-bar-split-right`   | The Split right button of a glass pane.                                                                |                                                   |
| `pane-bar-split-down`    | The Split down button of a glass pane.                                                                 |                                                   |
| `pane-bar-zoom`          | The Zoom pane or Restore pane button of a glass pane, only in a tab with more than one pane.           |                                                   |
| `titlebar-crumbs`        | The breadcrumb of the dense title bar: the space, the group and the tab on screen.                     |                                                   |
| `titlebar-palette`       | The button of the dense title bar that opens the command palette.                                      |                                                   |
| `dense-toolbar`          | The bar under the dense title bar: the favorites and the project actions.                              |                                                   |
| `favorite-label`         | The name on a favorite chip in the dense style.                                                        |                                                   |
| `space-header-label`     | The word before the project actions in the dense toolbar.                                              |                                                   |
| `space-swatch`           | The square of the color of a space in its tab, in the dense sidebar.                                   |                                                   |
| `space-label`            | The name of a space in its tab, in the dense sidebar.                                                  |                                                   |
| `item-waiting`           | The word that says an agent waits in a tab of the dense sidebar, in place of its branch.               |                                                   |
| `sidebar-agents`         | The agents of every space at the foot of the dense sidebar.                                            |                                                   |
| `sidebar-agent`          | One agent in that list; `data-nr-agent-state` says what it does.                                       |                                                   |
| `pane-number`            | The number of a pane in its tab, in the header of a dense pane.                                        |                                                   |
| `pane-state`             | That the command of a dense pane runs or failed, with its exit code.                                   | `running` or `failed`                             |
| `pane-bar-close`         | The Close pane button of a dense pane, only in a tab with more than one pane.                          |                                                   |
| `status-bar`             | The status bar at the foot of the dense window.                                                        |                                                   |
| `status-space`           | The space, in its color, at the start of the status bar.                                               |                                                   |
| `status-folder`          | The folder of the pane in focus, in the status bar.                                                    |                                                   |
| `status-branch`          | The branch of the pane in focus, in the status bar, only inside a repository.                          |                                                   |
| `status-agents`          | How many agents wait for the person, in the status bar, only while one does.                           |                                                   |
| `status-panes`           | How many panes the tab on screen holds, at the end of the status bar.                                  |                                                   |
| `palette`                | The command palette.                                                                                   |                                                   |
| `library`                | The library of archived and closed tabs.                                                               |                                                   |
| `library-row`            | One tab of the library.                                                                                | `selected`                                        |
| `peek`                   | The peek of a tab: its last lines in a popover beside it.                                              |                                                   |
| `settings`               | The settings screen.                                                                                   |                                                   |
| `settings-search-field`  | The frame of the search of the glass settings screen: the magnifier and the search box.                |                                                   |
| `settings-style`         | The two cards that choose the interface style in the glass settings screen.                            |                                                   |
| `settings-style-card`    | One card of the interface style, with its picture, its name and its line.                              |                                                   |
| `background-picker-name` | The name of the picture of the background in the card of the glass settings screen.                    |                                                   |
| `background-choose`      | The button that opens the file chooser for the picture of the background.                              |                                                   |
| `background-remove`      | The button that takes the picture of the background away.                                              |                                                   |
| `theme-editor`           | The theme editor dialog (a card of glass under the glass style).                                       |                                                   |
| `theme-preview`          | The preview of the theme being edited, inside the theme editor.                                        |                                                   |
| `theme-editor-contrast`  | The reading of the contrast of the text in the glass theme editor, next to its preview.                | `ok` or `low`                                     |
| `glass-backdrop`         | The illustrated backdrop of the glass window, only while no picture and no system effect is behind it. |                                                   |
| `background`             | The picture behind the terminals, only while one is on screen.                                         |                                                   |
| `background-backing`     | What the picture is drawn on, only while a picture shows.                                              |                                                   |
| `background-veil`        | The veil over the picture, only while a picture shows.                                                 |                                                   |

#### Other attributes

| Attribute               | On                                              | Values                                                                        |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `data-nr-focused`       | `pane`                                          | `true` or `false`, only in a tab that is split into panes                     |
| `data-nr-selected`      | `item`                                          | `true` while the tab is part of a selection                                   |
| `data-nr-pinned`        | `item`                                          | `true` for a pinned tab                                                       |
| `data-nr-kind`          | `favorite`                                      | `tab`, `profile` or `action`: what the tile stands for                        |
| `data-nr-placement`     | `favorites`                                     | `sidebar` or `top`: where the bar is (`appearance.favorites`)                 |
| `data-nr-indicator`     | the marks on a tab                              | `running`, `failed`, `unread` or `bell`                                       |
| `data-nr-dot`           | `item-dot`, `favorite-dot`                      | `waiting`, `running` or `idle` (a favorite tile has the first two only)       |
| `data-nr-side`          | the area that holds the sidebar and the content | `left` or `right`: the side of the sidebar                                    |
| `data-nr-density`       | the area that holds the sidebar and the content | `comfortable` or `compact`                                                    |
| `data-nr-style`         | the root of the window                          | `glass` or `dense`: the interface style (`appearance.style`)                  |
| `data-nr-scheme`        | the root of the window                          | `dark` or `light`: the kind of the theme in force                             |
| `data-nr-transparency`  | the root of the window                          | `reduced` while the system has its transparency effects off; absent otherwise |
| `data-nr-window-effect` | the root of the window                          | `none`, `mica`, `acrylic` or `vibrancy`: the effect the window has            |
| `data-nr-picture`       | the root of the window                          | `shown` while a picture is on screen; absent otherwise                        |

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
- The theme editor: `packages/model/src/theme-edit.ts` is the pure part (`readThemeField` reads the text of a box, `typeIntoField` puts it in a theme or answers why not, `setThemeField`, `fieldText`, `NUMBER_RANGES` and `themeContrastWarnings`); `ThemeEditorDialog.tsx` is the dialog (it holds a theme that is valid at every moment, the text of the boxes being typed in and what is wrong with each), `ThemePreview.tsx` the preview (drawn from custom properties of its own element), and `saveEditedTheme` in `themes-section.ts` writes through `Backend.saveUserTheme` after `renameTheme` and `duplicateTheme` (the same checks as a rename and a copy) and only then changes the list. A test holds that every value the boxes can make is a theme the schema accepts and that the file written is read back whole by the loader of the folder and by the importer.
- `Backend.deleteUserTheme(id)` removes `themes/<id>.json` and answers whether there was a file (`ThemeStore::delete` in the core, the command `theme_delete`): the id is checked as a theme id first, a folder is left alone, and a link is removed as the link. The Tauri backend also refuses the ids of the built-in themes and `system` before it asks. `Backend.exportUserTheme({ fileName, text, title, filter })` opens the save chooser of the system and writes `text` to the file chosen (`export_theme_file` in the core, the command `theme_export`, which uses the dialog plugin from the Rust side only, like `background_image_pick`: no window is granted a command of the plugin); it answers the path or `null` for a closed chooser, and checks the text before the chooser opens. `FakeBackend` has a fake chooser a test answers (`setThemeExportPick`), keeps what it wrote (`exportedThemeFiles`) and has `setUserThemeDeleteFailure(error)`; the web build inherits them (its theme files are in the storage, so a delete survives a reload).
- `Backend.listUserThemes()` returns the text of each file; `Backend.saveUserTheme(id, text)` writes `themes/<id>.json`. The id becomes a file name, so one that is not a theme id is refused before anything is written. In `noren-core` it is `themes.rs` (`ThemeStore`, over the same atomic write as `state.json`); the Tauri commands are `theme_list` and `theme_save`. The core does not know the schema of a theme: it only keeps files that can be one, and the interface validates them. The smoke run lists themes but never writes one.
- In the web build the theme files live in the browser storage under `noren.web.themes` (a JSON object from id to text); `FakeBackend.setUserTheme(id, text)` places a file as if by hand and `setUserThemeSaveFailure(error)` makes saves fail.
- The section of the settings screen is `ThemesPanel.tsx` (the cards, the choice of what a click is for and the dialogs), `ThemeThumbnail.tsx` (the miniature, drawn with CSS custom properties from the colors of the theme), `ThemeRenameDialog.tsx` and `themes-section.ts` (duplicate, rename, delete and export: each writes through the backend first and only then changes the list, and answers the sentence to show). The pure parts are `duplicateTheme` and `renameTheme` in `packages/model/src/theme-actions.ts`, which answer a theme that went through the schema again, and the reading of an exported theme in `importers.ts`. The dialogs are drawn into the body of the page, outside the form of the settings screen, and stop Esc so it does not close the screen.
- In the interface, `user-themes-store.ts` holds the list (built-in first, then yours), loaded before the first frame; `scheme-import.ts` is what the action runs for a picked file; `theme-choice.ts` and `use-theme.ts` look themes up in that whole list, while `findTheme` of `@noren/model` stays the built-in themes alone.
- Profiles: `user-profiles.ts` has `splitCommandLine` (the rules above), `userProfilesFromImported` (the ids and the schema check, never throws) and `commandLineOf` (the line shown in the preview); `user-profile-schema.ts` is the schema of one entry of `profiles`, shared with the schema of `config.jsonc`. In the interface, `profile-import.ts` reads the file into a plan (`readProfileFile`) and writes it (`commitProfileImport`, through `ConfigManager.update` with an append to `profiles`), `ProfileImportDialog.tsx` is the preview and `profiles-store.ts` hands the profiles of the file to the backend and keeps the joined list.
- **The window and the background.** The pure parts are in `packages/model/src`: `window-effect.ts` (the effects, `interfaceOpacity`, the lowest opacity), `background.ts` (`backgroundImageProblem`, `sniffImageMime`, `resolveBackground`, and the defaults of a picture: its opacity, the veil and the opacity of the panels) and `background-panel.ts` (`pictureUnderPanel`, the sum of the layers over one pixel of the picture, which the contrast tests measure). The space's picture is `Space.background` (`space/set-background`, checked and clamped by the reducer, read back by `state.json`). `Backend.setWindowEffect(effect, scheme)` and `Backend.readBackgroundImage(path)` are the two calls; `FakeBackend` takes `windowEffects` (what its system can paint) and `images` (files by path; `setImage` places one), and in the web build they are seeded under `noren.web.window-effects` (a list of effect names) and `noren.web.images` (path to base64), which is how the end-to-end tests give the page a system with Mica and a picture (`e2e/fixtures/background.png`).
- In `noren-core`, `window.rs` has the effects, the rule that falls back to an opaque window (`apply_effect` over a `WindowPainter`, tested with a fake painter) and the line for the log; `background.rs` has `path_problem` (the same cases as the TypeScript one), `sniff_image` and `BackgroundStore` (reads a picture: the path, the size and the first bytes are checked before a byte is returned). In the app, `window_effect.rs` paints with the `window-vibrancy` crate, called directly because the Tauri call drops the answer; the commands are `window_effect_set` (also sets the window theme to the scheme asked for) and `background_image_read` (a raw response, not JSON). The main window is `transparent` in `tauri.conf.json` (and `tauri.macos.conf.json`).
- In the interface: `window-effect-store.ts` (asks the backend for the effect and holds the answer), `background-image-store.ts` (reads the picture through the backend into a `blob:` address and keeps a few), `window-appearance.ts` (the pure merge of settings, theme and space into `windowVariables`), `use-window.ts` (follows the picture of the active space), `appearance-preview.ts` (the numbers a slider is trying out, laid over the settings by `windowAppearance` and forgotten when the screen closes) and `WindowBackground.tsx` (the three layers and the notice). `terminalTheme(theme, opacity)` gives the terminal its alpha, and `terminalOpacity` makes it 0 while a picture shows (the pane of glass is CSS, `--nr-terminal-glass`). `SettingsFields.tsx` has the `Slider` the settings screen and the dialog of a space share.
- The fixtures of the tests (a scheme in each format, settings files with hidden profiles and profiles to import, files that are not valid) are in `packages/model/src/import-fixtures.ts`, also used by the end-to-end tests.
