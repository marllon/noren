// The pure part of scripts/shot.mjs (`pnpm shot`, NOR-F20-05): the arguments, the refusal
// while the person is playing, the settings and the picture of the second print, the lines the app
// must say and how a leftover daemon is told. Nothing here starts a program; the tests are in
// scripts/shot.vitest.mjs.
//
// `pnpm shot` runs `noren --smoke-shot <png>` (apps/desktop/src-tauri/src/smoke_shot.rs): the real
// app draws its main window out of sight, with no focus, off the taskbar and Alt+Tab and outside
// every monitor, and writes the PNG that its own web view gives. No program is started with a
// window of its own, no key or mouse is sent to the system (the key events of `--split-keys` and the
// calls that open the settings screen and the theme editor are made inside the page) and no desktop is
// captured (this mode is the one that shows nothing on the desktop).
import { crc32, deflateSync } from "node:zlib";
import { gameModeSignalPresent, signalPath } from "./game-mode.mjs";

/** The exit code of a run refused because the person is playing (the app uses the same one). */
export const REFUSED_EXIT_CODE = 3;
/** Where the PNGs go when `--out` is not given (inside `target`, which git ignores). */
export const DEFAULT_OUT = "target/shots";
/** The file name of the picture behind the window, inside `backgrounds/` of the folder of the run. */
export const BACKGROUND_FILE = "background.png";

/**
 * The sentence that refuses the run, or `null` when it may go ahead. The signal of game mode refuses
 * at any age (the readers of the other scripts call a signal older than 60 s stale; this mode does
 * not). The path is `D:/Projetos/.modo-jogo` unless `NOREN_MODO_JOGO_ARQUIVO` names another.
 */
export function refusal(env = process.env) {
  if (!gameModeSignalPresent(env)) return null;
  return `game mode is on (${signalPath(env)} exists, whatever its age): pnpm shot does not run while the person is playing`;
}

/** Whether the arguments ask for one window of their own instead of the built-in prints. */
export function isCustom(parsed) {
  return (
    parsed.settings !== undefined ||
    parsed.liveSettings !== undefined ||
    parsed.image !== undefined ||
    parsed.state !== undefined ||
    parsed.splitKeys ||
    parsed.openSettings !== undefined ||
    parsed.themeEditor !== undefined
  );
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PREFIX = /^[A-Za-z0-9_-]*$/;
/** A section, a group or a theme of the page: lower case words joined by single hyphens (the app checks the same). */
const WORD = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A box of the theme editor: a path of the theme such as `ui.accent` or `terminal.ansi.1`. */
const FIELD = /^[a-z][a-z0-9]*(\.[A-Za-z0-9]+)+$/;
/** What may be typed into a box: letters, digits, spaces and the few signs of a color, a number and a path. */
const VALUE = /^[A-Za-z0-9 #,._/-]*$/;

/** Whether `text` is a word the page can be asked for by (at most 48 characters). */
export const isWord = (text) => text.length <= 48 && WORD.test(text);
/** Whether `text` names a box of the theme editor (at most 32 characters). */
export const isField = (text) => text.length <= 32 && FIELD.test(text);
/** Whether `text` can be typed into a box (at most 64 characters). */
export const isValue = (text) => text.length <= 64 && VALUE.test(text);

/**
 * Reads `pnpm shot [--out <dir>] [--prefix <text>] [--name <name>] [--settings <file>]
 * [--live-settings <file>] [--image <file>] [--state <file>] [--split-keys] [--open-settings <section>]
 * [--theme-editor <theme id>] [--editor-group <group>] [--editor-set <field>=<value>]... [--no-build]`.
 * With `--settings`, `--live-settings`, `--image`, `--state`, `--split-keys`, `--open-settings` or `--theme-editor`
 * one print is made, of that window, called `--name` (`editor` for `--theme-editor` alone, `settings` for
 * `--open-settings` alone, `split` for `--split-keys` alone, `custom` otherwise); without them the five
 * built-in ones are made. `--split-keys` makes the app send Ctrl+Shift+D and Ctrl+Shift+E to its own
 * page as key events and check that each one split a pane. `--open-settings` makes the app open the
 * settings screen from inside its page and click the section (`themes`, `terminal`...) in its column of sections;
 * `--theme-editor` opens the editor of a theme from its card in the Themes section, `--editor-group`
 * scrolls the editor to a group (`terminal`, `font`, `picture`...) and `--editor-set` types a value into
 * a box of the editor (`ui.accent=#22d3ee`; the app checks that the preview followed). `--settings` is
 * the settings file the app starts with; `--live-settings` is written once the app is up, as the
 * settings screen writes it; `--state` is the `state.json` the app starts with (tabs, favorites), for
 * a print of a workspace that has something in it. Throws an Error with a sentence for anything else.
 */
export function parseArgs(argv) {
  const parsed = {
    out: DEFAULT_OUT,
    prefix: "",
    name: undefined,
    settings: undefined,
    liveSettings: undefined,
    image: undefined,
    state: undefined,
    splitKeys: false,
    openSettings: undefined,
    themeEditor: undefined,
    editorGroup: undefined,
    editorSet: [],
    build: true,
  };
  const values = {
    "--out": "out",
    "--prefix": "prefix",
    "--name": "name",
    "--settings": "settings",
    "--live-settings": "liveSettings",
    "--image": "image",
    "--state": "state",
    "--open-settings": "openSettings",
    "--theme-editor": "themeEditor",
    "--editor-group": "editorGroup",
  };
  const words = new Set(["--open-settings", "--theme-editor", "--editor-group"]);
  const seen = new Set();
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (flag === "--no-build") {
      parsed.build = false;
      continue;
    }
    if (flag === "--split-keys") {
      if (parsed.splitKeys) throw new Error("--split-keys was given twice");
      parsed.splitKeys = true;
      continue;
    }
    if (flag === "--editor-set") {
      const pair = argv[++at];
      if (pair === undefined || pair.startsWith("--"))
        throw new Error("--editor-set needs <field>=<value> after it");
      const cut = pair.indexOf("=");
      if (cut < 0) throw new Error(`--editor-set ${JSON.stringify(pair)} is not <field>=<value>`);
      const field = pair.slice(0, cut);
      const value = pair.slice(cut + 1);
      if (!isField(field))
        throw new Error(
          `--editor-set: ${JSON.stringify(field)} is not the name of a box of the editor`,
        );
      if (!isValue(value))
        throw new Error(
          `--editor-set: ${JSON.stringify(value)} has a character a box is never given (letters, digits, space and # , . _ / - only)`,
        );
      parsed.editorSet.push([field, value]);
      continue;
    }
    const key = values[flag];
    if (key === undefined) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[++at];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag} needs a value after it`);
    if (seen.has(flag)) throw new Error(`${flag} was given twice`);
    seen.add(flag);
    if (words.has(flag) && !isWord(value))
      throw new Error(
        `${flag}: ${JSON.stringify(value)} is not a name (lower case letters, digits and hyphens)`,
      );
    parsed[key] = value;
  }
  if (
    parsed.themeEditor === undefined &&
    (parsed.editorGroup !== undefined || parsed.editorSet.length > 0)
  ) {
    throw new Error(
      "--editor-group and --editor-set are for the editor, and --theme-editor was not given",
    );
  }
  if (
    parsed.themeEditor !== undefined &&
    parsed.openSettings !== undefined &&
    parsed.openSettings !== "themes"
  ) {
    throw new Error(
      `--theme-editor opens the editor from the Themes section, not from ${JSON.stringify(parsed.openSettings)}`,
    );
  }
  if (!PREFIX.test(parsed.prefix)) {
    throw new Error(
      `--prefix ${JSON.stringify(parsed.prefix)} may only hold letters, digits, - and _`,
    );
  }
  if (parsed.name !== undefined) {
    if (!NAME.test(parsed.name)) {
      throw new Error(
        `--name ${JSON.stringify(parsed.name)} may only hold letters, digits, - and _`,
      );
    }
    if (!isCustom(parsed)) {
      throw new Error(
        "--name names the print of --settings, --live-settings, --image, --state, --split-keys, --open-settings or --theme-editor, and none was given",
      );
    }
  }
  return parsed;
}

/** The text of the settings of the second print: a picture behind the terminals, a see-through interface. */
export function backgroundSettings() {
  return `// The settings of the second print of pnpm shot: a picture behind the terminals, and an interface
// that lets it through (the picture at 60% and the sidebar, the title bar and the tabs at 70%).
{
  "appearance": {
    "theme": "noren-dusk",
    "background": { "image": "backgrounds/${BACKGROUND_FILE}", "opacity": 0.6, "blur": 0 },
    "window": { "opacity": 0.7 }
  }
}
`;
}

/**
 * The prints made when no window is asked for: the window as it starts, one with a picture behind it
 * and a see-through interface (`pnpm shot` makes the files from [`backgroundSettings`] and
 * [`backgroundPng`]), one of a tab split by the shortcuts Ctrl+Shift+D and Ctrl+Shift+E, which
 * the app sends to its own page as key events (NOR-F20-07b), the settings screen at its Themes section
 * and the theme editor open on Noren Dusk with two boxes typed into, both opened from inside the page
 * (NOR-F20-09b). The second one's settings are written while the app runs, the way the settings
 * screen writes them: the picture named in the settings file the app starts with does not show yet
 * (the page asks for it before the store has its backend), and asking for it that way
 * is still possible with `--settings`, which fails with what the page says.
 */
export const BUILTIN_SCENARIOS = [
  { name: "default", picture: false, live: false },
  { name: "background", picture: true, live: true },
  { name: "split", picture: false, live: false, splitKeys: true },
  { name: "themes", picture: false, live: false, openSettings: "themes" },
  {
    name: "editor",
    picture: false,
    live: false,
    themeEditor: "noren-dusk",
    editorSet: ["ui.accent=#22d3ee", "terminal.ansi.1=#ff5555"],
  },
];

/** The name of the PNG of a print: the prefix, then the name, then `.png`. */
export function outputName(prefix, name) {
  return `${prefix}${name}.png`;
}

/**
 * The arguments of `noren` for one print. `settings`, `liveSettings`, `image` and `state` are paths,
 * or `undefined`; `splitKeys` asks the app to send the split shortcuts to its page; `steps` is what
 * the app does in its page besides that (`openSettings`, `themeEditor`, `editorGroup` and
 * `editorSet`, a list of `<field>=<value>` texts or of `[field, value]` pairs), all optional.
 */
export function appArgs(
  out,
  settings,
  liveSettings,
  image,
  splitKeys = false,
  steps = {},
  state = undefined,
) {
  const args = ["--smoke-shot", out];
  if (settings !== undefined) args.push("--settings", settings);
  if (liveSettings !== undefined) args.push("--live-settings", liveSettings);
  if (image !== undefined) args.push("--image", image);
  if (state !== undefined) args.push("--state", state);
  if (splitKeys) args.push("--split-keys");
  if (steps.openSettings !== undefined) args.push("--open-settings", steps.openSettings);
  if (steps.themeEditor !== undefined) args.push("--theme-editor", steps.themeEditor);
  if (steps.editorGroup !== undefined) args.push("--editor-group", steps.editorGroup);
  for (const set of steps.editorSet ?? []) {
    args.push("--editor-set", Array.isArray(set) ? `${set[0]}=${set[1]}` : set);
  }
  return args;
}

/**
 * The lines one run must print, in the output of the app. They are the checks of the run (the
 * window out of sight, with no focus, with the foreground window of the system unchanged) and its
 * result; a run that lacks one did not do what it promised.
 */
export function requiredLines(picture, splitKeys = false, steps = {}) {
  const fieldOf = (set) => (Array.isArray(set) ? set[0] : set.split("=")[0]);
  return [
    "SMOKE app-ready received",
    "SMOKE SHOT window placed outside every monitor",
    "SMOKE SHOT page drawn:",
    picture ? "picture shown" : "picture none",
    "SMOKE SHOT window never had the focus of the system",
    "SMOKE SHOT window disabled, so nothing can give it the focus",
    "SMOKE SHOT window outside every monitor",
    "SMOKE SHOT window out of the taskbar and Alt+Tab",
    "SMOKE SHOT foreground window unchanged",
    "SMOKE SHOT wrote",
    "SMOKE global shortcut none registered",
    "SMOKE DAEMON stopped norend pid",
    ...(splitKeys
      ? [
          "SMOKE SHOT shortcut Ctrl+Shift+D sent to the page as a key event",
          "SMOKE SHOT shortcut Ctrl+Shift+E sent to the page as a key event",
          "SMOKE SHOT split keys: panes",
        ]
      : []),
    ...(steps.openSettings !== undefined || steps.themeEditor !== undefined
      ? [`SMOKE SHOT settings opened: section "${steps.openSettings ?? "themes"}"`]
      : []),
    ...(steps.themeEditor !== undefined
      ? [`SMOKE SHOT theme editor opened on "${steps.themeEditor}"`]
      : []),
    ...(steps.editorSet ?? []).map((set) => `SMOKE SHOT theme editor box ${fieldOf(set)} set to`),
    "SMOKE SHOT OK",
  ];
}

/**
 * What is wrong with the pane counts a `--split-keys` run printed (`SMOKE SHOT split keys: panes 1 -> 2
 * -> 3`), or `null` when each shortcut added exactly one pane. The app fails the run itself when it
 * did not; this reads the line again, so a run whose line is missing or wrong never counts.
 */
export function splitKeysProblem(stdout) {
  const found = /SMOKE SHOT split keys: panes (\d+) -> (\d+) -> (\d+)/.exec(stdout);
  if (found === null) return "the run did not say how many panes the shortcuts left";
  const [start, afterD, afterE] = found.slice(1).map(Number);
  if (start < 1) return `the tab had ${start} panes before the shortcuts`;
  if (afterD !== start + 1)
    return `Ctrl+Shift+D took the tab from ${start} to ${afterD} panes, not ${start + 1}`;
  if (afterE !== afterD + 1)
    return `Ctrl+Shift+E took the tab from ${afterD} to ${afterE} panes, not ${afterD + 1}`;
  return null;
}

/** The lines of `required` that `stdout` does not have. */
export function missingLines(stdout, required) {
  return required.filter((line) => !stdout.includes(line));
}

/** The pids of the daemons a run said it started (`SMOKE DAEMON norend pid <n>`). */
export function daemonPids(stdout) {
  return [...stdout.matchAll(/SMOKE DAEMON norend pid (\d+)/g)].map((match) => Number(match[1]));
}

/** Whether a process with this pid is running. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // No permission to signal it still means it exists.
    return error.code === "EPERM";
  }
}

/** Waits up to `ms` for the process to end. */
export function waitForExit(pid, ms) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return !alive(pid);
}

// ---- the picture behind the window -----------------------------------------------------------------

/** One chunk of a PNG: length, type, data and the checksum of the type and the data. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A PNG of `width` x `height` pixels to put behind the window: a colour gradient with light
 * diagonal bands, so a see-through part of the interface shows the bands and a part that is not
 * hides them. Made here so no picture has to be kept in the repository.
 */
export function backgroundPng(width = 960, height = 600) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // truecolour (RGB)
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    rows[row] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const band = (x + y) % 120 < 14 ? 60 : 0;
      const at = row + 1 + x * 3;
      rows[at] = Math.min(255, 40 + Math.round((170 * x) / width) + band);
      rows[at + 1] = Math.min(255, 70 + Math.round((110 * y) / height) + band);
      rows[at + 2] = Math.min(255, 190 - Math.round((100 * x) / width) + band);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
