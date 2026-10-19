import { describe, expect, it } from "vitest";
import { describeConfigError, parseConfigText } from "./config";
import { editConfigText } from "./config-edit";
import { FakeBackend } from "./fake-backend";
import { MAX_MOD_BYTES, MAX_MODS } from "./mods";
import { reduce } from "./reducer";
import { applyChecked, testContext } from "./test-helpers";
import type { Workspace } from "./types";
import { createDefaultWorkspace } from "./default-workspace";

// The pieces of mods that sit in other modules: the `mods` key of `config.jsonc`, writing a whole
// list into the text of the file, the `space/set-mods` action, and the mod files of the fake backend.

/** The errors of a text, one line each, or an empty list when it is valid. */
function problems(text: string): string[] {
  const parsed = parseConfigText(text);
  return parsed.ok ? [] : parsed.errors.map(describeConfigError);
}

describe("the mods key of config.jsonc", () => {
  it("is a list of file names, in order", () => {
    const parsed = parseConfigText('{ "mods": ["b.css", "a.css"] }');
    expect(parsed).toEqual({ ok: true, config: { mods: ["b.css", "a.css"] } });
    expect(parseConfigText('{ "mods": [] }')).toEqual({ ok: true, config: { mods: [] } });
  });

  it("refuses a name that is not a mod file name, at the line of the name", () => {
    const text = '{\n  "mods": [\n    "good.css",\n    "../escape.css"\n  ]\n}\n';
    const [first, ...others] = problems(text);
    expect(first).toMatch(/^line 4, column \d+: mods\[1\]: Not a mod file name/);
    expect(others).toEqual([]);
  });

  it("refuses the names that are paths, device names, other files and the wrong case", () => {
    for (const name of [
      "a/b.css",
      "a\\b.css",
      "C:\\a.css",
      "con.css",
      "aux.v2.css",
      "a.txt",
      "a",
      "A.CSS",
      "has space.css",
      ".css",
      "",
    ]) {
      expect(problems(JSON.stringify({ mods: [name] })), JSON.stringify(name)).not.toEqual([]);
    }
  });

  it("refuses a name listed twice, at the second one", () => {
    const [first] = problems('{\n  "mods": ["a.css", "b.css", "a.css"]\n}');
    expect(first).toMatch(/^line 2, column \d+: mods\[2\]: The mod "a.css" is listed twice/);
  });

  it("refuses more than MAX_MODS names, and a value that is not a list", () => {
    const many = Array.from({ length: MAX_MODS + 1 }, (_, i) => `m${i}.css`);
    expect(problems(JSON.stringify({ mods: many }))).not.toEqual([]);
    expect(problems(JSON.stringify({ mods: many.slice(0, MAX_MODS) }))).toEqual([]);
    expect(problems('{ "mods": "a.css" }')).not.toEqual([]);
    expect(problems('{ "mods": [1] }')).not.toEqual([]);
  });
});

describe("editConfigText with a whole list", () => {
  const edit = (text: string | null, mods: readonly string[]): string =>
    editConfigText(text, [{ path: ["mods"], value: mods }]);

  it("writes the key where the schema lists it, on one line, in a file that has none", () => {
    const text = '// mine\n{\n  "appearance": { "density": "compact" },\n  "keybindings": {}\n}\n';
    const next = edit(text, ["a.css", "b.css"]);
    expect(next).toBe(
      '// mine\n{\n  "appearance": { "density": "compact" },\n  "mods": ["a.css", "b.css"],\n  "keybindings": {}\n}\n',
    );
    expect(parseConfigText(next)).toEqual({
      ok: true,
      config: {
        appearance: { density: "compact" },
        mods: ["a.css", "b.css"],
        keybindings: {},
      },
    });
  });

  it("makes the file when there is none", () => {
    expect(edit(null, ["a.css"])).toBe('{\n  "mods": ["a.css"]\n}\n');
  });

  it("replaces the list the file has and leaves everything around it", () => {
    const text = [
      "{",
      "  // my mods",
      '  "mods": ["old.css", "older.css"], // for work',
      "  /* shells */",
      '  "notifications": { "enabled": false },',
      "}",
      "",
    ].join("\n");
    expect(edit(text, ["new.css"])).toBe(text.replace('["old.css", "older.css"]', '["new.css"]'));
  });

  it("writes an empty list as []", () => {
    expect(edit('{ "mods": ["a.css"] }', [])).toBe('{ "mods": [] }');
  });

  it("writes a list that was over several lines on one line, and keeps CRLF and a BOM", () => {
    const text =
      '\uFEFF{\r\n  "mods": [\r\n    "a.css", // first\r\n    "b.css"\r\n  ],\r\n  "keybindings": {}\r\n}\r\n';
    const next = edit(text, ["b.css", "a.css"]);
    expect(next).toBe('\uFEFF{\r\n  "mods": ["b.css", "a.css"],\r\n  "keybindings": {}\r\n}\r\n');
    expect(parseConfigText(next).ok).toBe(true);
  });

  it("is a no-op for the same list", () => {
    const text = '{\n  "mods": ["a.css", "b.css"]\n}\n';
    expect(edit(text, ["a.css", "b.css"])).toBe(text);
  });
});

describe("space/set-mods", () => {
  const { ctx } = testContext();
  const start = (): Workspace => createDefaultWorkspace({ newId: ctx.newId, clock: ctx.clock });
  const spaceId = (ws: Workspace): string => ws.spaces[0]?.id ?? "";
  const modsOf = (ws: Workspace): string[] => ws.spaces[0]?.modIds ?? [];

  it("sets the mods of the space, in order", () => {
    const ws = start();
    const next = applyChecked(ws, {
      type: "space/set-mods",
      spaceId: spaceId(ws),
      modIds: ["b.css", "a.css"],
    });
    expect(modsOf(next)).toEqual(["b.css", "a.css"]);
    expect(modsOf(ws)).toEqual([]);
  });

  it("keeps the names once, in the order given, and drops what is not a mod name", () => {
    const ws = start();
    const next = applyChecked(ws, {
      type: "space/set-mods",
      spaceId: spaceId(ws),
      modIds: ["a.css", "../x.css", "b.css", "a.css", "", "con.css", "Has Space.css", "c.css"],
    });
    expect(modsOf(next)).toEqual(["a.css", "b.css", "c.css"]);
  });

  it("keeps a name the folder does not have, so a mod that comes back is still on", () => {
    const ws = start();
    const next = applyChecked(ws, {
      type: "space/set-mods",
      spaceId: spaceId(ws),
      modIds: ["not-on-disk-now.css"],
    });
    expect(modsOf(next)).toEqual(["not-on-disk-now.css"]);
  });

  it("turns them off with an empty list", () => {
    const ws = start();
    const on = applyChecked(ws, {
      type: "space/set-mods",
      spaceId: spaceId(ws),
      modIds: ["a.css"],
    });
    const off = applyChecked(on, { type: "space/set-mods", spaceId: spaceId(on), modIds: [] });
    expect(modsOf(off)).toEqual([]);
  });

  it("changes nothing for the list the space has, an unknown space, or something that is not a list", () => {
    const ws = start();
    const on = applyChecked(ws, {
      type: "space/set-mods",
      spaceId: spaceId(ws),
      modIds: ["a.css", "b.css"],
    });
    expect(
      applyChecked(on, {
        type: "space/set-mods",
        spaceId: spaceId(on),
        modIds: ["a.css", "b.css"],
      }),
    ).toBe(on);
    // A list in another order is a change: the order is what wins.
    expect(
      applyChecked(on, {
        type: "space/set-mods",
        spaceId: spaceId(on),
        modIds: ["b.css", "a.css"],
      }),
    ).not.toBe(on);
    expect(applyChecked(ws, { type: "space/set-mods", spaceId: "nope", modIds: ["a.css"] })).toBe(
      ws,
    );
    expect(applyChecked(ws, { type: "space/set-mods", spaceId: spaceId(ws), modIds: [] })).toBe(ws);
    const broken = { type: "space/set-mods", spaceId: spaceId(ws), modIds: "a.css" } as never;
    expect(reduce(ws, broken, ctx)).toBe(ws);
  });

  it("holds at most MAX_MODS names", () => {
    const ws = start();
    const many = Array.from({ length: MAX_MODS + 20 }, (_, i) => `m${i}.css`);
    const next = applyChecked(ws, {
      type: "space/set-mods",
      spaceId: spaceId(ws),
      modIds: many,
    });
    expect(modsOf(next)).toEqual(many.slice(0, MAX_MODS));
  });

  it("changes only the space it names", () => {
    const first = start();
    const ws = applyChecked(first, { type: "space/create", name: "Second" });
    const second = ws.spaces[1];
    expect(second).toBeDefined();
    const next = applyChecked(ws, {
      type: "space/set-mods",
      spaceId: second?.id ?? "",
      modIds: ["a.css"],
    });
    expect(next.spaces.map((space) => space.modIds)).toEqual([[], ["a.css"]]);
  });
});

describe("FakeBackend mod files", () => {
  it("lists the files by name, as the real folder does", async () => {
    const backend = new FakeBackend({ mods: { "b.css": "b", "a.css": "a" } });
    expect(await backend.listMods()).toEqual([
      { name: "a.css", text: "a" },
      { name: "b.css", text: "b" },
    ]);
    expect(backend.callsTo("listMods")).toHaveLength(1);
  });

  it("leaves out what the real folder leaves out", async () => {
    const backend = new FakeBackend({
      mods: {
        "good.css": "ok",
        "Bad Name.css": "x",
        "con.css": "x",
        "notes.txt": "x",
        "big.css": "x".repeat(MAX_MOD_BYTES + 1),
        "edge.css": "x".repeat(MAX_MOD_BYTES),
      },
    });
    expect((await backend.listMods()).map((file) => file.name)).toEqual(["edge.css", "good.css"]);
  });

  it("lists the first MAX_MODS by name", async () => {
    const mods = Object.fromEntries(
      Array.from({ length: MAX_MODS + 3 }, (_, i) => [`m${String(i).padStart(3, "0")}.css`, ""]),
    );
    const files = await new FakeBackend({ mods }).listMods();
    expect(files).toHaveLength(MAX_MODS);
    expect(files[0]?.name).toBe("m000.css");
  });

  it("tells the watchers the whole list when a file is added, edited or removed", async () => {
    const backend = new FakeBackend({ mods: { "a.css": "1" } });
    const heard: string[][] = [];
    const stop = backend.watchMods((files) => heard.push(files.map((f) => `${f.name}=${f.text}`)));

    backend.setMod("b.css", "2");
    backend.setMod("a.css", "1 edited");
    backend.setMod("a.css", null);
    expect(heard).toEqual([["a.css=1", "b.css=2"], ["a.css=1 edited", "b.css=2"], ["b.css=2"]]);

    // The same text, a file the folder would not list, and a file that was not there: no change.
    backend.setMod("b.css", "2");
    backend.setMod("notes.txt", "x");
    backend.setMod("gone.css", null);
    expect(heard).toHaveLength(3);

    stop();
    backend.setMod("c.css", "3");
    expect(heard).toHaveLength(3);
    expect(await backend.listMods()).toEqual([
      { name: "b.css", text: "2" },
      { name: "c.css", text: "3" },
    ]);
  });

  it("can fail to list, as a folder that cannot be read does", async () => {
    const backend = new FakeBackend({ mods: { "a.css": "" } });
    backend.setModListFailure(new Error("no permission"));
    await expect(backend.listMods()).rejects.toThrow("no permission");
    backend.setModListFailure(undefined);
    expect(await backend.listMods()).toHaveLength(1);
  });

  it("hands out copies, so a watcher cannot change the files", async () => {
    const backend = new FakeBackend();
    let seen: { name: string; text: string }[] = [];
    backend.watchMods((files) => {
      seen = files;
      const first = files[0];
      if (first) first.text = "changed by the watcher";
    });
    backend.setMod("a.css", "kept");
    expect(seen).toHaveLength(1);
    expect(await backend.listMods()).toEqual([{ name: "a.css", text: "kept" }]);
    expect(backend.modFiles).toEqual({ "a.css": "kept" });
  });
});
