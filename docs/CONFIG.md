# The settings file

Noren keeps its settings in one text file, `config.jsonc`. It is JSON that allows comments (`//` and `/* */`) and a comma after the last item, so it can be edited by hand and annotated. Nothing is stored anywhere else that you need to know about: this file is the place to look. You can edit it with any editor, or change the same settings in the settings screen of Noren, which writes this file and leaves your comments where they are.

## Where it is

| System  | Path                                                                 |
| ------- | -------------------------------------------------------------------- |
| Windows | `%APPDATA%\io.github.marllon.noren\config.jsonc`                     |
| macOS   | `~/Library/Application Support/io.github.marllon.noren/config.jsonc` |
| Linux   | `~/.config/io.github.marllon.noren/config.jsonc`                     |

It is the config folder of the app (Tauri `app_config_dir`), next to `state.json` on Windows. The file does not exist until something is saved: Noren creates it (and its folder) the first time you save the settings screen, import profiles or drag the sidebar handle, with only the settings you changed. Without it every setting has its default.

## The settings screen

The **Settings** button (the gear in the title bar), or **Open settings** in the command palette (`Ctrl+Shift+P`, then `>`), opens the screen. It has eleven sections:

- **Appearance**: the language of the interface (see [Language](#language)), the side of the sidebar and its width, where the tabs are (the sidebar or a bar on top), density, compact mode, keeping the sidebar open, and the pane headers.
- **Window**: the effect the system paints behind the window (None, Mica, Acrylic or Vibrancy) and how opaque the interface is. If the system could not paint the effect that is saved, the section says so under the choices, with the reason (see [The window and the background](#the-window-and-the-background)).
- **Background**: the picture file behind the terminals, how much of it shows and how blurred it is. The picture of one space is chosen in the menu of the space instead.
- **Terminal**: the font list (names separated by commas; an **Installed font** choice, from the monospaced fonts this computer has, writes that name followed by `monospace`), the font size, the line height, ligatures, the shape of the cursor and whether it blinks, the scrollback, and what the bell does. A saved change reaches the terminals that are open at once and leaves their sessions alone (see [The terminal](#the-terminal)).
- **Profiles**: the shells of your own (see [Profiles](#profiles)): each one has a name, a program, arguments (one to a line) and an optional start folder, which you can edit, and a button to remove it; **Add profile** adds an empty one. **Add SSH profile** adds one for a shell on another machine (see [A shell on another machine](#a-shell-on-another-machine-kind-ssh)): the boxes are the host, the user, the port, the key file and the known hosts file, and the program, arguments and start folder of the shell there, all optional but the host. There is no box for a password, a passphrase or the text of a key. A new profile gets the id of its name (`Build Box` is `build-box`, with a number added when another shell has the id). Saving a profile starts nothing.
- **Shortcuts**: which preset is in force (safe or browser), and a button that opens the screen to see and record the keys of every action (see [KEYBINDINGS.md](KEYBINDINGS.md)).
- **Notifications**: system notifications on or off, and how many seconds a command runs before it notifies when it ends out of sight.
- **Auto-archive**: the switch for putting idle tabs in the archive and the hours a tab is left alone before it goes (see [Auto-archive](#auto-archive)).
- **AI**: the switch for the AI (`ai.enabled`, off until you turn it on) and, for each function (Ask, Explain and Command), the provider (Ollama, or one listed under `ai.providers` in the file) and the model typed as text (`ai.defaults.ask`, `ai.defaults.explain` and `ai.defaults.command`). A function needs both: a provider with no model, or a model with no provider, is refused where you type it. Choose no provider and empty the model to take the function out of the file. Above them is **Providers** (see [The AI](#the-ai)): Ollama with the models found on this computer, the providers of `ai.providers` with their key and a connection test, a form that adds one and a button that removes one. Unlike the rest of the screen those act at once, and are not part of the draft.
- **Mods**: the CSS files of the `mods` folder, a box for each to turn it on for every space, and arrows that move the ones that are on earlier or later (the mod applied last wins). A name that is on but has no file in the folder stays listed, marked, so you can turn it off. It is a draft like the rest and Save writes the whole `mods` list (see [Mods](#mods)).
- **Import**: **Import color scheme...** (the same as the palette action: a theme from a color scheme file, see [THEMING.md](THEMING.md)) and **Import profiles...** (the shell profiles of another program's settings file, see [Profiles](#profiles)). Unlike the other sections these act at once and are not part of the draft: a color scheme is added as soon as the file is read, and profiles are added when you confirm the preview. What happened is told under the buttons.

What you change is a draft until you press **Save** (Enter in a box saves too; **Cancel** or Esc drops it). Save writes **only the settings you changed**: a setting you put back where it was is not written, the rest of the file stays exactly as it was, with every comment, blank line and trailing comma in place, and a new setting is added where the list below puts it. The change shows at once in the window, with no restart and no reload, because the window follows the file. A value the schema of the file would refuse (a number outside its range, a font list that is not names, a profile with no name or program) is refused where you type it, with the reason, and nothing is written.

If the file has a problem of its own (see below), Save is off and the screen says where the problem is: Noren does not edit a file it could not read. Fix the file, or delete it, and the screen saves again. If the disk refuses the write, the screen stays open with the reason and your draft.

The layout modes of the Appearance section can also be switched from the command palette without opening the screen (_Switch sidebar side_, _Widen sidebar_, _Narrow sidebar_, _Switch density_, _Toggle compact mode_, _Toggle keep sidebar open_, _Toggle tabs on top_; see [KEYBINDINGS.md](KEYBINDINGS.md)). Each writes only its own setting, the same way Save does, and shows a notice if it cannot (the file has a problem, or the disk refused).

Dragging the handle on the edge of the sidebar (or pressing the arrow keys on it) saves `appearance.sidebar.width` the same way, when you let go. The handle does nothing while the file has a problem.

## Reload without a restart

Noren watches the folder of the file (and creates that folder, empty, when it is missing, so a file created later is seen too). When you save it, from an editor, a script or the settings screen, the new settings apply at once, with no restart and no reload of the window: move `appearance.sidebar.position` to `"right"` and the sidebar moves.

If the saved text has a problem (it is not JSON, a value is of the wrong kind or out of its range, a setting does not exist), **nothing changes**: Noren keeps the last valid settings and shows a notice in the corner that names the first problem with its line, for example:

```
The settings file has a problem, so the last valid settings stay in use.
config.jsonc, line 3, column 19: appearance.sidebar.position: Invalid option: expected one of "left"|"right"
```

The notice does not block anything; close it with its button. It goes away by itself when the file is valid again. A file that is wrong when the app starts means the defaults until it is fixed. Deleting the file puts the defaults back.

A setting that is missing is "not set here": it has its default. The file is the only place a setting lives, so a setting you take out of the file is back at its default.

## Settings

Every setting is optional. Unknown settings are an error, so a typo does not go unnoticed. The editor can complete and check the file with the schema: add `"$schema": "./config.schema.json"` (the schema is [config.schema.json](config.schema.json) in this folder of the repository).

```jsonc
{
  "language": "system", // "system" | "en" | "pt-BR", see Language below
  "appearance": {
    "theme": "system", // a theme id such as "noren-dusk"; "system" or no value follows the system
    "sidebar": {
      "position": "left", // "left" | "right"
      "width": 200, // whole pixels, 180 to 480
      "compact": false, // the sidebar hides and shows when the pointer touches the edge
      "keepOpen": false, // in compact mode, keeps it open
    },
    "density": "comfortable", // "comfortable" | "compact"
    "tabs": "sidebar", // "sidebar" | "top"
    "paneHeaders": false, // a header on every pane
    "window": {
      "effect": "none", // "none" | "mica" | "acrylic" | "vibrancy"
      "opacity": null, // 0.3 to 1; null or missing: solid, or the opacity of the theme with an effect
    },
    "background": {
      "image": null, // a picture file on this computer; null: none
      "opacity": null, // 0 to 1; null or missing: the theme says
      "blur": null, // pixels, 0 to 100; null or missing: the theme says
    },
  },
  "terminal": {
    "font": {
      "family": "Cascadia Mono, Consolas, DejaVu Sans Mono, monospace", // font names; the first found is used
      "size": 14, // pixels, 6 to 72
      "lineHeight": 1, // times the font size, 1 to 3
      "ligatures": false, // accepted, no effect yet (see The terminal)
    },
    "cursor": {
      "style": "block", // "block" | "bar" | "underline"
      "blink": true,
    },
    "scrollback": 10000, // lines kept above the screen, 0 to 100000
    "bell": "none", // "none" | "visual" | "sound" | "both"
    "saveScrollback": true, // false: never save the lines of a pane, see Saved scrollback below
  },
  "mods": [], // CSS files of the mods folder that are on for every space, see Mods below
  "profiles": [], // shells of your own, see Profiles below
  "keybindings": {
    "preset": "safe", // "safe" | "browser"
  },
  "notifications": {
    "enabled": true, // false: never ask the system for a notification
    "longCommandSeconds": 30, // a longer command that ends out of sight notifies
  },
  "archive": {
    "enabled": true, // false: never put a tab in the archive on its own
    "afterHours": 12, // hours a tab is left alone before it is archived; a fraction is fine
  },
  "agents": {
    "resumeOnRestore": false, // true: after a restart of the machine, a tab that had a catalog agent gets its "resume" command typed, see ARCHITECTURE.md
  },
  "sessions": {
    "keepOnClose": true, // false: closing the window ends every shell, see Sessions below
  },
  "ai": {
    "enabled": false, // nothing is sent to any provider until this is true, see The AI below
    "providers": [], // providers of your own; no key goes here, it lives in the system keychain
    "defaults": {}, // { "ask": { "provider": "ollama", "model": "llama3" } } and the same for "explain" and "command"
  },
}
```

The values above are the defaults. The schema is the list of what exists now. Your own shortcuts (the keys you record for an action) and a few other preferences (the recent folders, the answers to the question about running a project action) are still kept in the browser storage of the window, not in this file, until their settings get a place here.

## The terminal

`terminal` sets how the text of every terminal looks and how much it keeps. A file without it gives the terminal what it had before these settings existed (the values in the example above).

- `terminal.font.family` is a list of font names separated by commas, such as `"Cascadia Code, Consolas, monospace"`. The first one installed on this computer is used, so end the list with a font every system has (`monospace`). A name can have quotes around it. **Only names of font families are accepted**: letters, digits, spaces and `. _ + & -`, at most 64 characters each, at most 12 names and 300 characters in all. A web address, `url(...)`, a semicolon, a brace, a quote or a backslash inside a name is an error of the file, shown with its line like any other, and the last valid settings stay in force. This is deliberate: the text of the file (and of a theme file somebody gave you) is never handed to the page as CSS. Noren writes each name between quotes in the value it gives the terminal, so nothing in it can be read as anything but a name. `monospace`, `serif`, `sans-serif` and the other generic families of CSS are accepted without quotes.
- `terminal.font.size` is the size of the text in pixels, 6 to 72 (a decimal such as 13.5 is fine). **Ctrl+=** makes the text one pixel bigger, **Ctrl+-** one pixel smaller and **Ctrl+0** goes back to this size, for every terminal of the window (the panes of a tab and the other tabs too, and the ones opened afterwards). The zoom stops at 6 and at 72, is also in the command palette (_Increase font size_, _Decrease font size_, _Reset font size_, see [KEYBINDINGS.md](KEYBINDINGS.md)), and is **never written to the file**: it only lasts as long as the window is open. If the file changes `size` while the window is zoomed, the zoom keeps its steps over the new size.
- `terminal.font.lineHeight` is the height of a row as a multiple of the font size, 1 to 3. 1 is the tightest the terminal can draw.
- `terminal.font.ligatures` is accepted but **has no effect yet**. Drawing the ligatures of a font (such as `=>` or `!=` as one sign) needs the terminal to read the font file, and the addon that does it for xterm.js looks the file up through Node.js or through a browser permission to read the installed fonts, neither of which the window of the app has. Noren does not draw its own text to get around that. The setting is kept in the schema so a file that already has it stays valid when the support arrives.
- `terminal.cursor.style` is `"block"`, `"bar"` or `"underline"`, and `terminal.cursor.blink` says whether it blinks.
- `terminal.scrollback` is how many lines the terminal keeps above the screen, 0 to 100000. Every line takes memory in every terminal that is open, so the ceiling is there on purpose. A smaller value than before drops the oldest lines at once.
- `terminal.bell` is what happens when a program rings the bell (`BEL`): `"none"` (the default), `"visual"` (the pane lights up for a moment), `"sound"` (a short quiet beep) or `"both"`. A tab in the background is marked as unread whichever it is (see [SHELL_INTEGRATION.md](SHELL_INTEGRATION.md)). The beep needs the system to let the page play sound; if it does not, there is silence and no error.

The terminal follows the file like every other setting: save it and the terminals that are open change at once, with no restart, and **their sessions are not touched** (no shell starts again, nothing printed is lost). The font of a theme (the `font` of the theme format) is not used for the terminal: the terminal reads its font here only.

The list of the monospaced fonts installed on this computer comes from the Rust side (`Backend.listMonospaceFonts`, see For contributors); the Terminal section of the settings screen offers it as the **Installed font** choice.

### Saved scrollback

- `terminal.saveScrollback` is `true` unless the file says `false`. It is the switch for **everything below**, in every space.

Noren keeps what each pane showed, so that opening the app again does not start from a blank screen:

- **When it is saved.** The last 2,000 lines of every pane (the text and its colors) are saved when the window closes, and every minute for the panes that printed something since their last snapshot. A pane that has been quiet is not written again. The files are in the `scrollback` folder next to `state.json` (`scrollback/<paneId>.txt`), one per pane, written atomically like `state.json`, and at most 4 MiB each. Only the normal screen is kept: a program on the alternate screen (an editor, a pager) leaves the lines of the shell under it, which are what is saved.
- **What you see when the app opens.** The pane shows the saved lines dimmed, then the line `session restored <date and time>`, and under it the prompt of a new shell, started in the folder the old one was in. The shell is new: the processes that were running are not. The next snapshot keeps the old lines above the new ones, so the history grows across restarts, up to the 2,000 lines.
- **Never.** `terminal.saveScrollback: false` turns it off for the whole app; `saveScrollback: false` on a space (in `state.json`) turns it off for that space only. With either one off, **nothing is written** for that pane, a snapshot saved before is **not shown** and its **file is removed** (at the next start, or at once when the setting is turned off while the app runs). Nothing is read, either: a pane that is not allowed to have a snapshot never has one opened.
- **Leftover files.** When the app opens it removes the files in `scrollback` that no pane owns (an open, closed or archived tab), such as the ones a crash left; see [LIBRARY.md](LIBRARY.md#the-scrollback-folder-at-start). The library searches the text of these files, see [LIBRARY.md](LIBRARY.md#what-the-library-shows).
- **The file on disk is not trusted.** A snapshot is text that somebody could have changed, so what is read from it passes through a filter before it reaches the terminal: only printable text, tabs, line breaks and colors/styles get through. Every other escape sequence is dropped, so a snapshot cannot change a mode of the terminal (the alternate screen, mouse tracking), set the title, write to the clipboard, move the cursor, reset the terminal, or make it send an answer to the shell. The same filter runs before a snapshot is written, so the files only ever hold text and colors.
- **Where it is lost.** Closing the window waits (up to a couple of seconds) for the snapshots to be written; if the app is ended without that wait (the process is killed, the computer loses power, the system shuts down), what was printed since the last minute is not in the file. The cursor position, the selection and the state of a running program are not saved.

The space has no checkbox for this in the interface yet; until it does, a space that never saves is one with `"saveScrollback": false` in `state.json`.

## Auto-archive

`archive` decides which tabs Noren puts away on its own. A tab that nobody uses goes to the **archive**, keeping the place it had and the output it showed, and comes back from the library (see [LIBRARY.md](LIBRARY.md)).

- `archive.enabled` is `true` unless the file says `false`. Off, nothing is archived on its own (a tab you close yourself still goes to the closed ones, and the library still works).
- `archive.afterHours` is how many hours a tab has to be left alone before it is archived, `12` unless the file says otherwise. It must be above zero and a fraction is fine: `0.5` is half an hour, and a value of a few seconds' worth (such as `0.001`) is what the tests use. Zero, a negative number or text is an error of the file, shown with its line like any other.

A tab is **left alone** when none of these is true: a command is running in one of its panes (the shell said so through OSC 133, see [SHELL_INTEGRATION.md](SHELL_INTEGRATION.md)), a pane printed something, a pane is unread or has a bell nobody has looked at, or it is the tab on screen. A **pinned** tab and a **favorite** are never archived. The check runs every minute, so a tab goes within a minute of reaching the time. The time counts from the last output of the tab, from the moment it was last on screen and from the moment Noren opened, at the latest: a Noren that was closed for days does not archive every tab a minute after it opens.

The settings are read at every check, so a saved change applies without a restart. A shell without the Noren integration never reports a running command, so a program that prints nothing for hours looks quiet to the archive: turn the archive off, or pin the tab, if you run such programs.

## Sessions

`sessions.keepOnClose` is `true` unless the file says `false`. It decides what becomes of the shells of your panes when you close Noren.

- **On (the default).** Closing the window leaves the shell of every pane running in the background, in the session daemon (`norend`, see [DAEMON.md](DAEMON.md)), and opening Noren again gives each restored pane **its own shell back**: the same process, with what it printed meanwhile (the daemon keeps the latest 1 MiB of each shell's output). A program that was running in the shell is still running. The pane is told apart by its id in `state.json`; the daemon also checks that the shell is the process the pane had, so a daemon that was started again (the machine booted) never hands a pane somebody else's shell. A pane that has no shell to come back to (it is new, its shell ended while Noren was closed, or the daemon is not there) gets a new shell, as before.
- **Off.** Closing the window ends every shell, as it always did, and a shell left behind (by a crash, or from before you turned this off) is ended when Noren opens.
- **Shells with no pane do not stay.** The shell of the quick terminal window, and one promoted from it to a tab, end with the app. A shell that no pane comes back for is ended when Noren opens (nobody could reach it), unless another program is attached to it.
- **No daemon, no persistence.** When there is no `norend` next to the app (the log has a line that says so), the shells live inside the app and end with it whatever this says.
- **The app stays too.** With the setting on and the sessions in the daemon, closing the window only hides it: Noren stays in the notification area (the tray icon) and its shells keep running. **Open Noren** (or a click on the icon) brings the window back; **Quit Noren and end all sessions** ends the shells, the daemon and the app for real. With the setting off, or with no `norend`, closing the window quits the app as it always did. See [DAEMON.md](DAEMON.md#the-tray-icon-and-quitting-for-real).
- It follows the file like every other setting: turn it off while Noren is open and the next close ends the shells. There is no checkbox for it in the settings screen yet.

## The AI

The AI is optional and off until you turn it on. `ai.enabled` is `false` unless the file says `true`, and while it is off nothing is offered and nothing is sent to any provider. Even when it is on, **a space can turn it off for itself** (see below).

### Providers

A provider is a service that answers questions: the Ollama on this computer, or one of your own. Ollama is always there, with the id `ollama`, and needs nothing in the file. Your own go in `ai.providers`, each with exactly four settings:

```jsonc
"ai": {
  "enabled": true,
  "providers": [
    { "id": "my-openai", "kind": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "gpt-x" },
    { "id": "work", "kind": "anthropic", "baseUrl": "https://api.anthropic.com", "model": "a-model" },
  ],
  "defaults": {
    "ask": { "provider": "ollama", "model": "llama3" },
    "explain": { "provider": "work", "model": "a-model" },
  },
}
```

- `id` is lower case letters, digits, `-` and `_`, up to 64, starting with a letter or a digit. It is unique, `ollama` is taken, and it is the name of the key in the keychain.
- `kind` is `openai-compatible` (Ollama, LM Studio, vLLM, OpenRouter, OpenAI, Groq and the like; the address is the API root) or `anthropic`.
- `baseUrl` starts with `http://` or `https://`, names a host, and has no user name or password in it.
- `model` is the model the provider uses when a function does not name one.
- `defaults.ask`, `defaults.explain` and `defaults.command` each name a `provider` (`ollama` or an id of the list) and a `model`. The AI section of the settings screen edits them.

There is no setting for a key, and one written in a provider is an error of the file: a key is never in `config.jsonc`.

### Keys

An API key is stored in the **keychain of your system** (Credential Manager on Windows, the Keychain on macOS, the Secret Service on Linux) under the id of its provider, and only there. In the settings screen, type or paste it in the **API key** box of the provider (or of the form that adds one) and press **Store key**: the box is emptied at once, and the key goes to the keychain and nowhere else, not to this file, not to the saved state, not to a log. **Remove key** takes it out of the keychain, and **Remove provider** takes the key out with the provider. The screen tells whether a key is stored; it can never show it again.

### The providers part of the settings screen

- **Ollama** is always listed. Noren asks the Ollama of this computer (`http://localhost:11434`) for the models it has installed and lists them; **Check Ollama again** asks again after you installed one. Ollama not running is not an error: the line says it was not found.
- Each provider of the file shows its kind, address and model, whether a key is stored, and **Test connection**. The test asks the provider for its list of models with the stored key: it costs nothing, needs no model and sends no question. The result is written under the provider: that the connection works, or why it does not (a rejected key, an address that does not answer, no answer in time). The text never holds the key.
- **Add provider** takes an id, a kind, an address, a model and, if the provider needs one, a key. It appends the provider to `ai.providers` right away, keeping every comment of the file (the list is created when the file has none), and stores the key if there is one. What is refused is told under its box and writes nothing: an id that is empty, badly written, `ollama` or already used; an address that is not an `http` or `https` one, or has a user name or password in it; an empty model; more than 50 providers.
- **Remove provider** takes only that entry out of the file. A provider that a function uses in `ai.defaults` is **not removed**: the screen says which functions use it. Choose another provider for them (or none), press Save, and remove it then.
- While the file lists no provider and Ollama is not running or has no model, the part shows the **steps** to a first one: install Ollama and a model in it, or add a provider of your own, then turn the AI on and choose a provider and a model for each function.

### From the file to the app

The providers of the file are handed to the Rust side, the only one that talks to a provider, when Noren starts and every time the list changes: by the settings screen, by your editor, by a reload. A change to any other setting hands nothing over. If the Rust side refuses the list the settings screen says why, in the Providers part, and the app goes on with the providers it had.

### The AI in one space

A space has its own switch, in its menu (right-click the space, or the **Space options** button): **AI in this space**. A new space has it on. The AI works in a space only when the settings turn it on **and** the space has not turned it off; off in either place means off. The choice belongs to the space, so it is kept in `state.json` with the rest of the space, not in this file. When the AI is off in the settings the menu says so, and the switch of the space has no effect until it is on.

## The window and the background

`appearance.window` and `appearance.background` change how the window itself looks. What they do, the systems each effect works on, and how the layers of the picture are put together are in [THEMING.md](THEMING.md#the-window-effect-opacity-and-background); in short:

- `appearance.window.effect` is `"none"` (the default), `"mica"`, `"acrylic"` or `"vibrancy"`. A system that cannot paint the effect keeps the window opaque, with no error of the file; the settings screen and a line in the log say why. The effect is painted dark or light like the theme you chose (and like the system while the theme follows the system).
- `appearance.window.opacity` is a number from 0.3 to 1: how opaque the window, the title bar, the sidebar, the tab bar and the terminals are. Without a value the window is solid, and with an effect on it takes the `ui.opacity` of the theme. `null` is the same as no value.
- `appearance.background.image` is a picture file on this computer (png, jpg, jpeg, webp, gif or bmp): an absolute path, or a path inside the folder of this file (`backgrounds/sky.jpg`). A web address, a network path, a path that climbs out of the folder with `..` and anything that is not a picture extension are errors of the file, with their line. `null` shows no picture, even where the theme has one. `opacity` (0 to 1) and `blur` (pixels, 0 to 100) say how much of it shows and how blurred it is; without them the theme says.

The picture of one space is not a setting of this file: it is kept with the space in `state.json` (`background`), chosen in the menu of the space, and wins over this one for the parts it sets.

## Mods

`mods` lists the files of the `mods` folder (next to this file) that are turned on for every space, in the order they are applied; the last one wins:

```jsonc
"mods": ["tinted-sidebar.css", "accent-bar.css"],
```

- Each item is a file name: letters, digits, `.`, `_` and `-` (the first a letter or digit), ending in `.css` in lower case, and not a device name such as `con.css`. A name that is not one, a name listed twice and more than 100 names are errors of the file, shown with their line like any other.
- A name with no file in the folder is not an error of the file: the mod is ignored and a notice says so. Mods can be turned on for one space too, in the menu of the space; that list is kept with the space in `state.json`, not here.
- The file follows the folder and the folder follows the editor: edit a mod, add one or delete one, and the window changes with no reload. What a mod is, the cascade layer it is put in and the variables and attributes it can use are in [THEMING.md](THEMING.md#mods-your-own-css).
- The settings screen writes the list whole, on one line, where the schema puts it (after `appearance`), so a comment inside the old list goes with it; the comments around the list stay.

## Profiles

Noren finds the shells of the machine by itself (PowerShell, Command Prompt, Git Bash and the WSL distributions on Windows; the shells of `$SHELL` and `/etc/shells` elsewhere). `profiles` lists shells of your own, which join them in the command palette (_New ... tab_, see [PALETTE.md](PALETTE.md)):

```jsonc
"profiles": [
  {
    "id": "dev-shell", // lower case words joined by hyphens; unique
    "name": "Dev Shell", // shown in the palette
    "program": "pwsh.exe", // the program, or a full path
    "args": ["-NoLogo"], // optional: one item for each argument
    "cwd": "C:\\work", // optional: where a session starts
  },
],
```

- `id`, `name` and `program` are required; `args` and `cwd` are optional. A program or a name that is empty (or only blanks) is an error of the file, shown with its line like any other. So is an `id` used twice or `default` (a pane uses that word for "the default shell").
- `%NAME%` in the program, the arguments and `cwd` is replaced by the environment variable `NAME` when the profile is loaded (so `%SystemRoot%\\System32\\cmd.exe` and `%USERPROFILE%` work); one that is not set stays as written.
- A session starts in the folder of the call when there is one (a tab opened in a folder, the folder of the space), else in `cwd`, else where the shell starts. A `cwd` that is not a folder is an error when the tab opens, with the folder named.
- The shell integration (the prompt marks and the folder reported by the shell, see [SHELL_INTEGRATION.md](SHELL_INTEGRATION.md)) is on for a profile of yours as for a detected one; it only does anything for the shells it knows, and leaves a command line that says what the shell runs (`/c`, `-Command`) alone.
- The list follows the file like the other settings: add a profile by hand, save, and it is in the palette with no reload; take it out and it is gone. The default shell is always one of the machine's (the first profile of yours only when the machine has none).
- An `id` that is one of the machine's shells (`pwsh`, `cmd`, `git-bash`, `wsl-Ubuntu`...) is refused when the profiles are loaded: the whole list is not applied, the profiles in force stay, and a notice in the corner says which profile and why. Pick another id.

### A shell on another machine (kind `ssh`)

A profile with `"kind": "ssh"` opens its shell in a `norend` on another machine, through the `ssh` of the system (see [DAEMON.md](DAEMON.md#ssh-profiles-in-the-app)). The shell lives there: when the connection drops, the tab reconnects by itself and the shell is where you left it.

```jsonc
"profiles": [
  {
    "kind": "ssh",
    "id": "build-box",
    "name": "Build box",
    "host": "build.example.org", // a name or an address; required
    "user": "deploy", // optional: else what ssh decides
    "port": 2222, // optional: else 22 or what ssh decides
    "identityFile": "%USERPROFILE%\\.ssh\\id_ed25519", // optional: the private key; only this one is offered
    "knownHostsFile": "%USERPROFILE%\\.ssh\\known_hosts", // optional: else the one of the user
    "program": "bash", // optional: what runs there; else the login shell of the user there
    "args": ["-l"], // optional
    "cwd": "/srv/app", // optional: a folder there; else the home folder of the user there
  },
],
```

- `kind`, `id`, `name` and `host` are required. `host` and `user` are a short word (letters, digits, `.`, `-`, `_`, and `:` for an address), never starting with `-`; `port` is 1 to 65535. A profile without `kind` is a shell on this machine, as before.
- **Keys only.** `ssh` runs in batch mode: no password, no passphrase, no question. The key is a file you name (`identityFile`) or one of the keys `ssh` and its agent already know; a key with a passphrase works only through an agent. Noren stores no password, passphrase or key, and the file has nowhere to put one.
- **The host must be known.** A host that is not in the known hosts file, or whose key changed, is refused with a sentence; it is never accepted on the first visit and never asked about. Add it first with a normal `ssh` after checking its fingerprint, or point `knownHostsFile` at a file that has it.
- `%NAME%` is replaced by the environment variable `NAME` in `identityFile` and `knownHostsFile` (files of this machine) and nowhere else: `program`, `args` and `cwd` are on the other machine and are used as written.
- **What the shell there gets** is what the profile says and nothing of this machine: not the folder of the space or the tab, not the environment of the tab, not the shell integration scripts. Without `cwd` it starts in the home folder of the user there; without `program` it is that user's login shell.
- `norend` must be installed there, found by the `PATH` of a non-interactive login, and the machine must not print anything from a startup file for such a login (see [DAEMON.md](DAEMON.md#the-remote-bridge-ssh)).
- **In the settings screen** the Profiles section creates, edits and removes these profiles (**Add SSH profile**), checked by the same schema as the file: a box that is wrong is marked with the reason and Save stays off until it is fixed (a port that is not a whole number, a host that is empty or starts with `-`, a control character in a path). A box left empty is left out of the file. An SSH profile and a shell profile keep their kind: the screen never turns one into the other.
- **On the tab.** While the connection is up the tab looks like any other. While it reconnects the tab says so with the attempt (`Reconnecting, attempt 3 of 10. What you type is not sent.`: the keys typed while the connection is down are dropped, not queued), and once it gave up it says why (`Connection failed: Permission denied (publickey).`) and offers **Try again**, which starts the attempts over. In the sidebar that is a line under the tab; in the bar of the top tabs it is a few words in the tab (`Reconnecting 3/10`, `Failed`) with the same sentence as its description and its tooltip. A tab with several panes shows the worst of them.

**Import profiles...** in the settings screen fills this list from the settings file of another program: it shows what it would add and, when you confirm, appends the profiles to `profiles` keeping your comments (see [THEMING.md](THEMING.md#profiles-in-a-settings-file)). Its `colorScheme` is not carried over. The Profiles section of the settings screen edits and removes them (see above), each change written alone, so the comments around the list and the other profiles stay.

## Language

`language` is the language of the interface: `"en"` (English), `"pt-BR"` (Brazilian Portuguese), or `"system"` (also what a missing key means), which follows the language of the computer as the web view reports it (`navigator.language`). Any other language of the system, and any value the file might one day hold that this build does not know, is English. Another Portuguese, such as `pt-PT`, reads as `pt-BR`.

The **Language** choice in the Appearance section of the settings screen writes it like every other setting (the comments of the file stay) and the interface changes at once, with no restart and no reload; the `lang` of the page follows. Shortcut keys, the chords written out (`Ctrl+Shift+T`), shell commands and the keys of this file are not translated, only the words around them. The names of the themes you choose from, the names of your own spaces, tabs and profiles, and the text of the file are yours or the theme author's and are never changed.

The description of each field (the words the generated JSON Schema shows an editor) is shown in the language in force as the tooltip of its control in the settings screen. `docs/config.schema.json` and `@noren/model` keep the English words; the Portuguese ones are in the dictionary under `field.<path>`.

The texts are in `apps/desktop/src/i18n/`; see [For contributors](#for-contributors).

## Themes

`appearance.theme` is the id of the theme. Without it, or with `"system"`, the theme follows the light or dark color scheme of the operating system (Noren Dusk when it is dark, Noren Paper when it is light), live. The id has to be lower case words joined by hyphens; one that is not is an error of the file, and an id that is well formed but that this build does not have follows the system, with no error.

The eight built-in themes:

| Id                 | Name             | Kind  |
| ------------------ | ---------------- | ----- |
| `noren-dusk`       | Noren Dusk       | dark  |
| `noren-paper`      | Noren Paper      | light |
| `noren-nightshade` | Noren Nightshade | dark  |
| `noren-fjord`      | Noren Fjord      | dark  |
| `noren-midnight`   | Noren Midnight   | dark  |
| `noren-meadow`     | Noren Meadow     | dark  |
| `noren-dune`       | Noren Dune       | light |
| `noren-oat`        | Noren Oat        | light |

You pick one in the command palette (_Theme: <name>_, see [PALETTE.md](PALETTE.md)), which previews the highlighted theme live and, on Enter, writes the id here like the settings screen does (the comments stay), or by writing the id in the file yourself. The theme of one space is not a setting of this file: a space can have its own theme (`themeId`), chosen in the menu of the space or by **Set theme for this space** in the palette, and it is saved with the space in `state.json`, so it follows the space (not the file) and is not touched by editing `config.jsonc`. The theme the window shows is, in order: the one being previewed in a list, the theme of the active space when this build has a theme with that id, then `appearance.theme`, then the system's; an id of a space the build does not have (a later build, a theme since removed) falls to the global theme with no error. See [PALETTE.md](PALETTE.md). The six themes after the first two are ports of color schemes published under permissive licenses; where each comes from, and its license, is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Your own themes join these: a theme file in the `themes` folder next to this file, or a color scheme imported with **Import color scheme...** in the palette, is a theme like the built-in ones, and its id can be the value of `appearance.theme` or the theme of a space. The folder, the formats the import reads and how the interface colors are derived are in [THEMING.md](THEMING.md). (An id this file names that no theme has, built-in or yours, follows the system, as above.)

A theme is data, in the format of the spec (`ThemeSchema` in `packages/model/src/theme.ts`; the type `Theme` comes from it): `id`, `name`, `kind` (`dark` or `light`), `ui` (the colors `bg`, `surface`, `text`, `muted`, `accent`, `border`, and `radius`, `blur`, `opacity`), `terminal` (`foreground`, `background`, `cursor`, `selection` and the 16 `ansi` colors), `font` and `background` (`image`, `opacity` and an optional `blur`). Colors are `#rrggbb` (the selection may add an alpha, `#rrggbbaa`); an unknown field, a missing one, a color that is not a color or a number out of its range makes the theme invalid. Every built-in theme goes through the schema when the app starts, and a test holds all of them to a contrast of at least 4.5:1 (WCAG 2.x, level AA) between `ui.text` and `ui.bg`, and between `terminal.foreground` and `terminal.background`. The interface reads a theme only through the `--nr-*` variables (see the API for mods in the spec).

## What happened to the choices made before the settings screen

Before the settings screen, the layout, the notification settings and the shortcut preset were kept in the browser storage of the window (`noren.ui.layout`, `noren.ui.notifications` and the `preset` of `noren.ui.keybindings`), with a small panel in the title bar to change them, and the theme was kept in `noren.ui.theme`. That panel is gone and the storage is no longer read for them. So that nobody loses what they chose, the first start after the upgrade **moves those choices into the file once**:

- the theme you had picked in the palette (`noren.ui.theme`) becomes `appearance.theme`, unless the file already names one;
- only what is not the default is written (a width of 200, the left side, comfortable density... are the defaults and add nothing), in the same way the screen writes it, with your comments in place if the file already exists, and the file is created if it does not;
- a setting the file already has is left as the file says: **the file wins**;
- after that the old keys are removed (for the shortcuts only the `preset` goes; your own recorded keys stay);
- if the file has a problem, or cannot be written, nothing is moved and nothing is removed, and the next start tries again.

## For contributors

- **`state.json` panes.** A pane of `state.json` is `type: "terminal"` (a shell: `profileId`, `cwd`, `scrollbackRef`...) or `type: "browser"`, which has a `url` (an `http://` or `https://` address; `localhost` and numeric addresses are fine, names that end in `.localhost` are not) and no `sessionId`. A file with a browser pane whose `url` is missing or is not such an address, or whose pane holds a session, is quarantined like any other broken file (`parseState`, `checkInvariants`). A file from before this field loads as it always did: every pane is a terminal. See [ARCHITECTURE.md](ARCHITECTURE.md#the-browser-pane). A pane can also be `type: "preview"`, which has a `path` (a full path of a file on this computer: `/home/me/notes.md` or `C:\Users\me\notes.md`, not a relative one and not a network path) and no `sessionId` and no `url`; a terminal or browser pane with a `path`, or a preview pane without a usable one, quarantines the file the same way. Only the path is saved, never the contents. See [ARCHITECTURE.md](ARCHITECTURE.md#the-preview-pane).
- The schema is written with zod in `packages/model/src/config.ts` (`ConfigSchema`); `parseConfigText` reads the text (it uses `jsonc-parser`, so errors know their line) and never throws. `ConfigManager` (`config-manager.ts`) keeps the settings in force: a valid text replaces them, an invalid one keeps them and reports the errors.
- `docs/config.schema.json` is generated from that schema. A Vitest test fails when it is out of date; run `pnpm --filter @noren/model config:schema` to regenerate it.
- `noren-core` (`crates/noren-core/src/config.rs`) reads, writes atomically (temporary file in the same folder, flush, rename) and watches the file with the `notify` crate; the Tauri commands are `config_load`, `config_save` and `config_watch`, and the change reaches the page as the `config-changed` event with the new text (`null` when the file was removed).
- `Backend.loadConfig()`, `Backend.saveConfig(text)` and `Backend.watchConfig(callback)` are the interface. `FakeBackend.setConfig(text)` replaces the text of the in-memory file as another program would and tells the watchers; `saveConfig` does the same as the app does (and is recorded). In the web build the text lives in the browser storage under `noren.web.config`, and the test hook `window.__norenTest.setConfig(text)` is how the end-to-end tests edit "the file" (`failConfigSaves(message)` makes the next saves fail).
- **Editing the text.** `editConfigText(text, changes)` (`packages/model/src/config-edit.ts`) is the only way the app writes the file. A setting the text already has gets only its value replaced (`modify` and `applyEdits` of `jsonc-parser`); a new one is inserted by hand as a line of its own, indented like its neighbors, under the line of the setting before it (so the comment at the end of that line stays with it), in the order the schema lists the settings, creating the groups it needs; an object written on one line stays on one line; line breaks (LF or CRLF), indentation and a byte order mark are kept. `modify`'s own formatting is not used for an insertion because it reformats every line it touches. A setting is not taken out by writing a different value: one that may be left unset (the opacity of the window, the picture of the background) is written as `null`. An entry that has to leave the file (a profile, or the arguments or the folder of one) is a **removal** (`{ path: ["profiles", 1], remove: true }`): only that entry goes, with the comment at the end of its line, and the comments on the lines around it stay. A path may go through a list with the index of an item (`["profiles", 0, "name"]`); the edits run in order, so removals go last item first. Besides setting a value, an edit can **append** items to a list (`{ path: ["profiles"], append: [...] }`): the items go under the last one, indented like it and as objects over several lines, a list written on one line stays on one line, a trailing comma the list had is kept, and a list the file lacks is created in the place the schema lists it.
- `ConfigManager.update(changes)` reads the file now, refuses when it has a problem or when the result would not be valid (nothing is written), edits it, saves it through the backend and applies the new text at once; the watcher then reports the same text and it is ignored. Updates queue up, so two quick ones both land.
- **Profiles.** `UserProfileSchema` (`user-profile-schema.ts`) is the schema of one entry and is part of `ConfigSchema`. `profiles-store.ts` hands the `profiles` of the settings in force to the backend with `Backend.setUserProfiles` (at start, before any shell is restored, and at every change of that list) and keeps the joined list `listProfiles` answers; a list the backend refuses is `getProfilesProblem`, shown as a notice. In `noren-core` (`profiles.rs`) `UserProfile` is validated and `ProfileSet::with_user_profiles` joins it to the detected shells (`%NAME%` replaced through an injected environment); the Tauri command is `profiles_set_user`, and `AppState` keeps the detected set and the joined one. `FakeBackend` checks the list with the same rules (`profilesProblem`) and starts a session of a profile of the user in its `cwd`.
- **Mods.** The `mods` key is `modsSchema` in `config.ts` (the name rule is `MOD_FILE_NAME_PATTERN` of `mods.ts`, the same rule the Rust store applies to the folder). An edit whose value is a list of names (`{ path: ["mods"], value: [...] }`) replaces the list the file has, or creates it where the schema puts it; this is how the screen writes it (`MODS_PATH` and `planSave` in `settings-screen.ts`). See [THEMING.md](THEMING.md#for-contributors) for the rest.
- **The terminal.** The keys are `terminalSchema` in `config.ts`; the limits, the defaults and the rule for font names are `terminal-options.ts` (`parseFontFamilies`, `safeFontFamily`, `terminalOptionsOf`, `nextZoom`), with the defaults held to what `TerminalView` hard-coded before. The interface reads the options through `terminal-options-store.ts` (the settings in force with the zoom of the window over the size, the same object while nothing changes) and `TerminalView` applies a new set to its xterm without recreating it; the bell is `bell.ts`. `Backend.listMonospaceFonts()` answers the monospaced families installed on the machine, once each and in alphabetical order, only names (`fontNameList` holds every backend to that). In `noren-core` it is `fonts.rs` (`list_monospace_families`, over the `fontdb` crate, MIT, which scans the system font folders and reads the names and the fixed-pitch flag of each file); the Tauri command is `fonts_list_monospace`. It only reads: the smoke run lists the fonts and never writes. The web build cannot list the fonts of a visitor, so its backend answers the families the terminal falls back to. The tests hold the rest: `terminal-options.test.ts`, `terminal-config.test.ts`, `fonts.rs` (it finds at least one monospaced family on Windows and macOS) and `e2e/terminal-options.spec.ts`.
- **Saved scrollback.** The key is `terminal.saveScrollback` in `terminalSchema` (the default is `DEFAULT_SAVE_SCROLLBACK` in `packages/model/src/scrollback.ts`, which also holds the limits: `SCROLLBACK_SAVE_LINES`, `SCROLLBACK_SAVE_INTERVAL_MS`, `MAX_SCROLLBACK_BYTES`, mirrored by `MAX_SCROLLBACK_BYTES` in Rust). `savesScrollback(setting, space)` is the one place that decides whether a pane keeps a snapshot, and `cleanSnapshot` is the filter (`restoredTerminalText` runs it again on the way in and adds the dimming and the marker line). The files are `scrollback.rs` in `noren-core` (`ScrollbackStore`: the id of the pane becomes a file name, so `is_valid_pane_id` accepts only ASCII letters, digits, `-` and `_` and not a Windows device name, in Rust and in `isScrollbackPaneId` with the same cases), the Tauri commands `scrollback_load`, `scrollback_save`, `scrollback_list` and `scrollback_delete`, and `Backend.loadScrollback`, `saveScrollback`, `listScrollback` and `deleteScrollback`. The smoke run reads the folder and never writes or removes in it (`ScrollbackState::without_writing`); it proves the write path in a folder of its own in the temp folder, which it removes. `scrollback-saver.ts` is the timer and the rules (an injectable clock, the panes with activity, the removal when a space or the setting says never), `scrollback-restore.ts` reads the snapshots when the app opens, `scrollback-service.ts` ties them to the terminals and the closing of the window (`close-handler.ts` and `lifecycle.rs` keep the window open until the page has saved, see [ARCHITECTURE.md](ARCHITECTURE.md)), and the action `pane/set-scrollback` keeps `Pane.scrollbackRef` (the name of the file) in `state.json`. The tests: `scrollback.test.ts` (including a list of hostile sequences and a property test on any text), `scrollback.rs`, `scrollback-saver.test.ts` and `e2e/scrollback.spec.ts`.
- **Sessions.** The key is `sessions.keepOnClose` in `sessionsSchema` of `config.ts` (the default is `DEFAULT_KEEP_SESSIONS`, and `keepSessionsAllowed` is the one place that reads it, both in `packages/model/src/keep-sessions.ts`). `keep-sessions-sync.ts` hands the value to the backend (`Backend.setKeepSessions`, the command `sessions_keep_set`) when the settings first come into force and at every change, and `boot-sessions.ts` does that before the workspace is restored. The Rust side is `persist.rs` and `pane_sessions.rs` (see [DAEMON.md](DAEMON.md#shells-that-outlive-the-app)). The tests: `keep-sessions.test.ts`, `keep-sessions-sync.test.ts`, `boot-sessions.test.ts`.
- **Window and background.** The keys are `windowSchema` and `backgroundSchema` in `config.ts`; the path check is `backgroundImageProblem` (`background.ts`), mirrored by `path_problem` in `crates/noren-core/src/background.rs` and tested with the same cases. The boxes of the screen that may be empty (`OPTIONAL_PATHS` in `settings-screen.ts`) are written as `null` when emptied. See [THEMING.md](THEMING.md#for-contributors) for the rest.
- **The AI.** The keys are `AiProviderSchema` (`ai.ts`) and the `ai` object in `config.ts`; `aiProvidersProblem` is the check the backend repeats. The providers part of the screen is `ProvidersPanel.tsx`; what adding and removing write, and the words it uses, are the pure `settings-providers.ts` (`planAddProvider` appends to `ai.providers`, `planRemoveProvider` removes by index and refuses a provider that `ai.defaults` names), both written through `ConfigManager.update` like the rest. The key box is not a controlled input: it is read when the button is pressed, handed to `Backend.ai.setKey` and wiped, so no state of the page ever holds it, and the text of a failure has it taken out. `ai-providers-sync.ts` (`AiProvidersSync`, the instance `aiProvidersSync` in `config-store.ts`, started by `boot.ts`) hands `ai.providers` to `Backend.ai.configure` at start and at every change of the list, one call after the other, and keeps the reason of a refusal. In the web build the fake Ollama is seeded with the browser storage key `noren.web.ai-ollama` (a JSON list of model names; without it there is no Ollama), and the test hook has `aiConfigures()`, `aiKeyCalls()` and `storedAiKey(id)`. The tests: `settings-providers.test.ts`, `ai-providers-sync.test.ts` and `e2e/ai-providers.spec.ts`.
- **Language.** The key is `language` in `config.ts` (`LANGUAGES`, `LANGUAGE_SETTINGS`, `SYSTEM_LANGUAGE`); `@noren/model` knows only the names of the languages and never imports the dictionary, so what the pure modules hand out are ids and numbers and the interface says them. The texts are `apps/desktop/src/i18n/en.ts` (the source: every key, a value in braces such as `{name}` is filled in) and `pt-BR.ts`, which has the same keys; `tsc` fails when one is missing or extra, and a Vitest test checks that both fill in the same placeholders. `t(key, params)` (in `i18n/index.ts`) says a text in the language in force, and the parameters of a text are checked by `tsc`; `resolveLanguage(setting, system)` is the pure choice (a language of ours as it is, `system` takes the system's, anything else English). `config-store.ts` follows the file with `applyLanguageSetting`, and `main.tsx` starts it from the language of the system; until it is called the language is English, so a test never depends on the computer it runs on. A component that says words draws again when the language changes by calling `useT()` (or `useLanguage()` for a memo that depends on it). The actions of the shortcut registry keep their English `title` and `category`; `i18n/names.ts` says them by id (`actionName`, `categoryName`). To add a language: add it to `LANGUAGES`, write its dictionary and add it to `DICTIONARIES`. The description of a field has the key `field.<path>` (the path of the field in the schema, `item` for an entry of a list, as in `field.profiles.item.id`) in both dictionaries, and `fieldDescription(path)` in `i18n/names.ts` says it by that path; a test fails when a described field has no key, when the English text drifts from `config.ts`, or when a key has no field. A control of the settings screen gets its tooltip by passing the path as its `field`. The strings of the pure modules that name a rule instead of a field (validation messages, the messages of the schema) are still English: the interface has to say them by id first.
- The screen is `SettingsDialog.tsx`; what it shows and what Save writes is the pure `settings-screen.ts` (`settingsOf`, `planSave`). `layout-store.ts`, `notification-settings.ts` and `keybindings-store.ts` read the settings in force; `legacy-settings.ts` is the one-time move described above.
- The theme: `theme-choice.ts` reads `appearance.theme` from the settings in force (`themeChoiceOf`) and plans picking one (`planThemeChoice`, `runThemeChoice`, which hands the change to `ConfigManager.update`). `effectiveThemeChoice` there is the order above (pure, tested), `space-theme.ts` lists what a space can pick, and `use-theme.ts` follows the active space of the store (`followActiveSpaceTheme`, started at boot) and holds the preview of the palette over the saved choice: `previewTheme`, `clearThemePreview` and `chooseTheme`, which keeps the chosen theme on screen until the file has it, so the window does not flicker back. The built-in themes are in `packages/model/src/builtin-themes.ts`; `user-themes-store.ts` holds the list of them and of the user's (see [THEMING.md](THEMING.md)), and `theme-choice.ts` looks a theme up in the list it is given (the built-in ones by default, the whole list where the window asks).
