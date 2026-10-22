// Vitest tests of `pnpm shot` (NOR-F20-05): the pure part in scripts/shot-lib.mjs and the refusal of
// scripts/shot.mjs while the signal of game mode exists. The signal is always a temporary file named
// through NOREN_MODO_JOGO_ARQUIVO, never the real one, and nothing here builds or starts the app.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGNAL_ENV, SIGNAL_PATH, gameModeSignalPresent, signalPath } from "./game-mode.mjs";
import {
  BACKGROUND_FILE,
  BUILTIN_SCENARIOS,
  DEFAULT_OUT,
  REFUSED_EXIT_CODE,
  appArgs,
  backgroundPng,
  backgroundSettings,
  daemonPids,
  isCustom,
  isField,
  isValue,
  isWord,
  missingLines,
  outputName,
  parseArgs,
  refusal,
  requiredLines,
  splitKeysProblem,
} from "./shot-lib.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "shot.mjs");

let dir;
let signal;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "noren-shot-"));
  signal = join(dir, "signal");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Makes the signal file `ageMs` old, or removes it when `ageMs` is `null`. */
function setSignal(ageMs) {
  rmSync(signal, { force: true });
  if (ageMs === null) return;
  writeFileSync(signal, '{"jogo":"test"}');
  const when = new Date(Date.now() - ageMs);
  utimesSync(signal, when, when);
}

describe("the signal of game mode, read by the picture mode", () => {
  it("is present for a file of any age and absent without one", () => {
    const env = { [SIGNAL_ENV]: signal };
    setSignal(null);
    expect(gameModeSignalPresent(env)).toBe(false);
    for (const age of [0, 5_000, 60_000, 3_600_000, 10 * 24 * 3_600_000]) {
      setSignal(age);
      expect(gameModeSignalPresent(env), `${age} ms old`).toBe(true);
    }
    setSignal(null);
    expect(gameModeSignalPresent(env)).toBe(false);
  });

  it("follows the variable, and falls back to the real path only when it is empty or missing", () => {
    expect(signalPath({ [SIGNAL_ENV]: signal })).toBe(signal);
    expect(signalPath({ [SIGNAL_ENV]: "" })).toBe(SIGNAL_PATH);
    expect(signalPath({})).toBe(SIGNAL_PATH);
    expect(SIGNAL_PATH).toBe("D:/Projetos/.modo-jogo");
  });
});

describe("the refusal while the person is playing", () => {
  it("is a sentence that names the file, for a fresh signal and for one left behind long ago", () => {
    const env = { [SIGNAL_ENV]: signal };
    for (const age of [0, 30_000, 3 * 24 * 3_600_000]) {
      setSignal(age);
      const sentence = refusal(env);
      expect(sentence, `${age} ms old`).toContain("game mode is on");
      expect(sentence).toContain(signal);
      expect(sentence).toContain("whatever its age");
      expect(sentence).toContain("pnpm shot");
    }
  });

  it("lets the run go when there is no signal", () => {
    setSignal(null);
    expect(refusal({ [SIGNAL_ENV]: signal })).toBeNull();
  });

  it("stops scripts/shot.mjs with exit code 3 before it reads an argument or builds anything", () => {
    setSignal(1_000);
    const out = join(dir, "out");
    // Bad arguments too: the signal is looked at first.
    for (const argv of [["--out", out], ["--wat"], []]) {
      const started = Date.now();
      const run = spawnSync(process.execPath, [script, ...argv], {
        encoding: "utf8",
        env: { ...process.env, [SIGNAL_ENV]: signal },
        timeout: 20_000,
      });
      expect(run.status, `${argv.join(" ")}: ${run.stderr}`).toBe(REFUSED_EXIT_CODE);
      expect(REFUSED_EXIT_CODE).not.toBe(0);
      expect(run.stderr).toContain("shot: refused: game mode is on");
      expect(run.stderr).toContain(signal);
      // Nothing was built (a build takes minutes) and nothing was made.
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(existsSync(out)).toBe(false);
    }
  });

  it("refuses an old signal in the script too", () => {
    setSignal(2 * 24 * 3_600_000);
    const run = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, [SIGNAL_ENV]: signal },
      timeout: 20_000,
    });
    expect(run.status).toBe(REFUSED_EXIT_CODE);
  });

  it("without the signal, wrong arguments are told with exit code 2 and nothing is built", () => {
    setSignal(null);
    const run = spawnSync(process.execPath, [script, "--wat"], {
      encoding: "utf8",
      env: { ...process.env, [SIGNAL_ENV]: signal },
      timeout: 20_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown argument "--wat"');
  });
});

describe("the arguments of pnpm shot", () => {
  it("default to the five built-in pictures in target/shots", () => {
    expect(parseArgs([])).toEqual({
      out: DEFAULT_OUT,
      prefix: "",
      name: undefined,
      settings: undefined,
      liveSettings: undefined,
      image: undefined,
      splitKeys: false,
      openSettings: undefined,
      themeEditor: undefined,
      editorGroup: undefined,
      editorSet: [],
      build: true,
    });
    expect(isCustom(parseArgs([]))).toBe(false);
    expect(DEFAULT_OUT).toBe("target/shots");
  });

  it("read every option and say a window of its own was asked for", () => {
    const parsed = parseArgs([
      "--out",
      "some/dir",
      "--prefix",
      "after-",
      "--name",
      "sky",
      "--settings",
      "a.jsonc",
      "--live-settings",
      "b.jsonc",
      "--image",
      "c.png",
      "--split-keys",
      "--open-settings",
      "themes",
      "--theme-editor",
      "noren-dusk",
      "--editor-group",
      "terminal",
      "--editor-set",
      "ui.accent=#22d3ee",
      "--editor-set",
      "font.family=Fira Code, monospace",
      "--no-build",
    ]);
    expect(parsed).toEqual({
      out: "some/dir",
      prefix: "after-",
      name: "sky",
      settings: "a.jsonc",
      liveSettings: "b.jsonc",
      image: "c.png",
      splitKeys: true,
      openSettings: "themes",
      themeEditor: "noren-dusk",
      editorGroup: "terminal",
      editorSet: [
        ["ui.accent", "#22d3ee"],
        ["font.family", "Fira Code, monospace"],
      ],
      build: false,
    });
    expect(isCustom(parsed)).toBe(true);
    for (const only of ["--settings", "--live-settings", "--image"]) {
      expect(isCustom(parseArgs([only, "x"])), only).toBe(true);
    }
    // The shortcuts alone are a window of their own too, and do not need a value.
    expect(isCustom(parseArgs(["--split-keys"]))).toBe(true);
    expect(parseArgs(["--split-keys", "--out", "x"]).splitKeys).toBe(true);
    // So are the settings screen and the theme editor (NOR-F20-09b): a window of their own, each alone.
    expect(isCustom(parseArgs(["--open-settings", "themes"]))).toBe(true);
    expect(isCustom(parseArgs(["--theme-editor", "noren-dusk"]))).toBe(true);
    expect(parseArgs(["--theme-editor", "noren-dusk", "--name", "ed"]).name).toBe("ed");
    expect(isCustom(parseArgs(["--out", "x", "--prefix", "y", "--no-build"]))).toBe(false);
  });

  it("refuse what they cannot read, each with its own sentence", () => {
    const cases = [
      [["--wat"], 'unknown argument "--wat"'],
      [["--out"], "--out needs a value"],
      [["--out", "--prefix"], "--out needs a value"],
      [["--out", "a", "--out", "b"], "--out was given twice"],
      [["--prefix", "a b"], "--prefix"],
      [["--prefix", "../x"], "--prefix"],
      [["--settings", "a", "--name", "a/b"], "--name"],
      [["--name", "ok"], "--name names the print"],
      [["--split-keys", "--split-keys"], "--split-keys was given twice"],
      [["--split-keys", "--name", "a/b"], "--name"],
      [["--open-settings"], "--open-settings needs a value"],
      [["--open-settings", "Themes"], "is not a name"],
      [["--open-settings", "a/b"], "is not a name"],
      [["--open-settings", "x--y"], "is not a name"],
      [["--open-settings", "themes", "--open-settings", "terminal"], "was given twice"],
      [["--theme-editor", 'x";alert(1)//'], "is not a name"],
      [["--editor-group", "terminal"], "--theme-editor was not given"],
      [["--editor-set", "ui.accent=#fff"], "--theme-editor was not given"],
      [["--theme-editor", "a", "--editor-set"], "--editor-set needs <field>=<value>"],
      [["--theme-editor", "a", "--editor-set", "ui.accent"], "is not <field>=<value>"],
      [["--theme-editor", "a", "--editor-set", "Ui.accent=#fff"], "not the name of a box"],
      [
        ["--theme-editor", "a", "--editor-set", 'ui.accent=a"b'],
        "has a character a box is never given",
      ],
      [["--theme-editor", "a", "--open-settings", "terminal"], "not from"],
      [["--name", "ok", "--out", "x"], "--name names the print"],
    ];
    for (const [argv, sentence] of cases) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(sentence);
    }
  });
});

describe("what the app is given and must say", () => {
  it("builds the arguments of noren for one picture", () => {
    expect(appArgs("o.png", undefined, undefined, undefined)).toEqual(["--smoke-shot", "o.png"]);
    expect(appArgs("o.png", "s.jsonc", "l.jsonc", "i.png")).toEqual([
      "--smoke-shot",
      "o.png",
      "--settings",
      "s.jsonc",
      "--live-settings",
      "l.jsonc",
      "--image",
      "i.png",
    ]);
    // The shortcuts of the split are one flag, last, and only when asked for.
    expect(appArgs("o.png", undefined, undefined, undefined, true)).toEqual([
      "--smoke-shot",
      "o.png",
      "--split-keys",
    ]);
    expect(appArgs("o.png", "s.jsonc", undefined, undefined, false)).not.toContain("--split-keys");
  });

  it("builds the arguments of the settings screen and the theme editor, in the order the app does them", () => {
    expect(
      appArgs("o.png", undefined, undefined, undefined, false, { openSettings: "themes" }),
    ).toEqual(["--smoke-shot", "o.png", "--open-settings", "themes"]);
    expect(
      appArgs("o.png", "s.jsonc", undefined, undefined, true, {
        themeEditor: "noren-dusk",
        editorGroup: "terminal",
        editorSet: [["ui.accent", "#22d3ee"], "terminal.ansi.1=#ff5555"],
      }),
    ).toEqual([
      "--smoke-shot",
      "o.png",
      "--settings",
      "s.jsonc",
      "--split-keys",
      "--theme-editor",
      "noren-dusk",
      "--editor-group",
      "terminal",
      "--editor-set",
      "ui.accent=#22d3ee",
      "--editor-set",
      "terminal.ansi.1=#ff5555",
    ]);
    // Without steps nothing of them is passed.
    for (const flag of ["--open-settings", "--theme-editor", "--editor-group", "--editor-set"]) {
      expect(appArgs("o.png", undefined, undefined, undefined, false, {})).not.toContain(flag);
    }
  });

  it("knows what a word, a field and a value are, as the app does (a script is made of them)", () => {
    for (const word of ["themes", "noren-dusk", "a", "a1-b2"])
      expect(isWord(word), word).toBe(true);
    for (const word of [
      "",
      "-",
      "a-",
      "a--b",
      "Themes",
      "a b",
      "a_b",
      'a"',
      "a;b",
      "é",
      "a".repeat(49),
    ])
      expect(isWord(word), word).toBe(false);
    for (const field of ["ui.accent", "terminal.ansi.15", "font.size", "background.blur"])
      expect(isField(field), field).toBe(true);
    for (const field of [
      "",
      "ui",
      "ui.",
      ".ui",
      "ui..x",
      "Ui.accent",
      "ui.acc ent",
      "1.a",
      "a.".repeat(20),
    ])
      expect(isField(field), field).toBe(false);
    for (const value of ["#22d3ee", "0.5", "Fira Code, monospace", "backgrounds/sky.png", ""])
      expect(isValue(value), value).toBe(true);
    for (const value of [
      'a"b',
      "a'b",
      "a\\b",
      "a\nb",
      "a;b",
      "a(b)",
      "a{b}",
      "é",
      "a=b",
      "a".repeat(65),
    ])
      expect(isValue(value), value).toBe(false);
  });

  it("names the files and makes the five built-in pictures", () => {
    expect(outputName("", "default")).toBe("default.png");
    expect(outputName("after-", "background")).toBe("after-background.png");
    expect(BUILTIN_SCENARIOS.map((s) => s.name)).toEqual([
      "default",
      "background",
      "split",
      "themes",
      "editor",
    ]);
    expect(BUILTIN_SCENARIOS.map((s) => s.picture)).toEqual([false, true, false, false, false]);
    // Only the third one sends the shortcuts of the split.
    expect(BUILTIN_SCENARIOS.map((s) => s.splitKeys === true)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    // The picture goes in while the app runs: see the note on BUILTIN_SCENARIOS.
    expect(BUILTIN_SCENARIOS.map((s) => s.live)).toEqual([false, true, false, false, false]);
    // The fourth opens the Themes section of the settings screen, the fifth the editor of a theme
    // with two boxes typed into; each of those boxes is one the page has.
    const themes = BUILTIN_SCENARIOS[3];
    expect(themes.openSettings).toBe("themes");
    expect(themes.themeEditor).toBeUndefined();
    const editor = BUILTIN_SCENARIOS[4];
    expect(editor.themeEditor).toBe("noren-dusk");
    expect(editor.openSettings).toBeUndefined();
    for (const set of editor.editorSet) {
      const [field, value] = set.split("=");
      expect(isField(field), field).toBe(true);
      expect(isValue(value), value).toBe(true);
    }
    expect(editor.editorSet.length).toBeGreaterThan(0);
  });

  it("requires the checks of the run in its output, and the picture only when one is asked for", () => {
    const plain = requiredLines(false);
    const picture = requiredLines(true);
    for (const line of [
      "SMOKE SHOT window placed outside every monitor",
      "SMOKE SHOT window never had the focus of the system",
      "SMOKE SHOT window disabled, so nothing can give it the focus",
      "SMOKE SHOT window outside every monitor",
      "SMOKE SHOT window out of the taskbar and Alt+Tab",
      "SMOKE SHOT foreground window unchanged",
      "SMOKE SHOT wrote",
      "SMOKE DAEMON stopped norend pid",
      "SMOKE SHOT OK",
    ]) {
      expect(plain, line).toContain(line);
      expect(picture, line).toContain(line);
    }
    expect(plain).toContain("picture none");
    expect(picture).toContain("picture shown");
    expect(picture).not.toContain("picture none");
  });

  it("requires the lines of the two shortcuts only for a run that sends them", () => {
    const plain = requiredLines(false);
    const keys = requiredLines(false, true);
    expect(plain.some((line) => line.includes("as a key event"))).toBe(false);
    expect(plain.some((line) => line.includes("split keys"))).toBe(false);
    for (const line of [
      "SMOKE SHOT shortcut Ctrl+Shift+D sent to the page as a key event",
      "SMOKE SHOT shortcut Ctrl+Shift+E sent to the page as a key event",
      "SMOKE SHOT split keys: panes",
    ]) {
      expect(keys, line).toContain(line);
    }
    // The end of the run stays last.
    expect(keys[keys.length - 1]).toBe("SMOKE SHOT OK");
  });

  it("reads the pane counts of a split run: each shortcut must add exactly one", () => {
    const line = (a, b, c) =>
      `SMOKE SHOT split keys: panes ${a} -> ${b} -> ${c} (each shortcut added one)`;
    expect(splitKeysProblem(line(1, 2, 3))).toBeNull();
    expect(
      splitKeysProblem(`SMOKE x
${line(2, 3, 4)}
SMOKE SHOT OK`),
    ).toBeNull();
    expect(splitKeysProblem(line(1, 1, 2))).toContain("Ctrl+Shift+D took the tab from 1 to 1");
    expect(splitKeysProblem(line(1, 2, 2))).toContain("Ctrl+Shift+E took the tab from 2 to 2");
    expect(splitKeysProblem(line(1, 3, 4))).toContain("Ctrl+Shift+D");
    expect(splitKeysProblem(line(3, 2, 3))).toContain("Ctrl+Shift+D");
    expect(splitKeysProblem(line(0, 1, 2))).toContain("0 panes before");
    // No line, or a line without the counts, never counts as a pass.
    expect(splitKeysProblem("SMOKE SHOT OK")).toContain("did not say");
    expect(splitKeysProblem("SMOKE SHOT split keys: panes ? -> ? -> ?")).toContain("did not say");
  });

  it("requires the lines of the settings screen and of the editor only for a run that opens them", () => {
    const plain = requiredLines(false);
    expect(plain.some((line) => line.includes("settings opened"))).toBe(false);
    expect(plain.some((line) => line.includes("theme editor"))).toBe(false);
    const settings = requiredLines(false, false, { openSettings: "themes" });
    expect(settings).toContain('SMOKE SHOT settings opened: section "themes"');
    expect(settings.some((line) => line.includes("theme editor"))).toBe(false);
    // An editor opens the Themes section by itself, so that line is required of it too.
    const editor = requiredLines(false, false, {
      themeEditor: "noren-paper",
      editorSet: ["ui.accent=#22d3ee", ["terminal.ansi.1", "#ff5555"]],
    });
    expect(editor).toContain('SMOKE SHOT settings opened: section "themes"');
    expect(editor).toContain('SMOKE SHOT theme editor opened on "noren-paper"');
    expect(editor).toContain("SMOKE SHOT theme editor box ui.accent set to");
    expect(editor).toContain("SMOKE SHOT theme editor box terminal.ansi.1 set to");
    expect(editor[editor.length - 1]).toBe("SMOKE SHOT OK");
    // What the app really prints is what is required.
    const printed = [
      ...requiredLines(false),
      'SMOKE SHOT settings opened: section "themes" at the top of the screen (14 section(s), heading "Themes")',
      'SMOKE SHOT theme editor opened on "noren-paper": 9 group(s), preview of 16 color(s)',
      'SMOKE SHOT theme editor box ui.accent set to "#22d3ee": the preview changed',
      'SMOKE SHOT theme editor box terminal.ansi.1 set to "#ff5555": the preview changed',
    ].join("\n");
    expect(missingLines(printed, editor)).toEqual([]);
    expect(missingLines(requiredLines(false).join("\n"), editor)).toEqual(
      editor.filter((line) => !requiredLines(false).includes(line)),
    );
  });

  it("tells which lines an output lacks", () => {
    const output = requiredLines(false).join("\n");
    expect(missingLines(output, requiredLines(false))).toEqual([]);
    expect(missingLines(output.replace("SMOKE SHOT OK", ""), requiredLines(false))).toEqual([
      "SMOKE SHOT OK",
    ]);
    expect(missingLines(output, requiredLines(true))).toEqual(["picture shown"]);
  });

  it("reads the pids of the daemons a run started", () => {
    const output =
      "SMOKE DAEMON norend pid 4242 on smoke-1-2: session 1 runs in it\nSMOKE DAEMON stopped norend pid 4242 with exit code 0";
    expect(daemonPids(output)).toEqual([4242]);
    expect(daemonPids("SMOKE OK")).toEqual([]);
  });
});

describe("the settings and the picture of the second print", () => {
  it("are a settings file with a picture and a see-through interface, and a picture inside backgrounds/", () => {
    const text = backgroundSettings();
    // The settings are JSONC: take the comment lines out, the rest is JSON.
    const json = JSON.parse(
      text
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n"),
    );
    expect(json.appearance.background.image).toBe(`backgrounds/${BACKGROUND_FILE}`);
    expect(json.appearance.background.opacity).toBeGreaterThan(0.3);
    expect(json.appearance.background.opacity).toBeLessThanOrEqual(1);
    expect(json.appearance.background.blur).toBeGreaterThanOrEqual(0);
    // A see-through interface, inside the range the settings accept (0.3 to 1).
    expect(json.appearance.window.opacity).toBeGreaterThanOrEqual(0.3);
    expect(json.appearance.window.opacity).toBeLessThan(1);
    expect(BACKGROUND_FILE).toMatch(/\.png$/);
  });

  it("make a valid PNG of the size it says, the same every time", () => {
    const png = backgroundPng(96, 60);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Walk the chunks: each one's checksum is that of its type and data.
    const seen = [];
    let at = 8;
    let data = Buffer.alloc(0);
    while (at < png.length) {
      const length = png.readUInt32BE(at);
      const type = png.toString("latin1", at + 4, at + 8);
      const body = png.subarray(at + 8, at + 8 + length);
      const stored = png.readUInt32BE(at + 8 + length);
      expect(crc32(Buffer.concat([Buffer.from(type, "latin1"), body])), type).toBe(stored);
      seen.push(type);
      if (type === "IHDR") {
        expect(body.readUInt32BE(0)).toBe(96);
        expect(body.readUInt32BE(4)).toBe(60);
        expect(body[8]).toBe(8);
        expect(body[9]).toBe(2);
      }
      if (type === "IDAT") data = Buffer.concat([data, body]);
      at += 12 + length;
    }
    expect(seen).toEqual(["IHDR", "IDAT", "IEND"]);
    // Every row has its filter byte and three bytes a pixel.
    expect(inflateSync(data).length).toBe((96 * 3 + 1) * 60);
    expect(backgroundPng(96, 60).equals(png)).toBe(true);
    // The default is a picture a window is covered by, big enough to be seen as a picture.
    expect(backgroundPng().length).toBeGreaterThan(1000);
  });
});
