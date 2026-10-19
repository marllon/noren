import { describe, expect, it } from "vitest";
import { NOREN_DUSK, NOREN_PAPER } from "./builtin-themes";
import { FakeBackend } from "./fake-backend";
import { PLIST_LAGOON } from "./import-fixtures";
import { importColorSchemes } from "./importers";
import type { Theme } from "./theme";
import { parseUserThemes, serializeTheme } from "./user-themes";

function imported(name: string): Theme {
  const result = importColorSchemes(PLIST_LAGOON, { name });
  if (!result.ok) throw new Error(result.errors.join(" | "));
  return result.themes[0] as Theme;
}

describe("serializeTheme", () => {
  it("writes the JSON of the theme, indented, with a final line break, and it reads back the same", () => {
    const theme = imported("Lagoon");
    const text = serializeTheme(theme);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "id": "lagoon",');
    expect(JSON.parse(text)).toEqual(theme);
    expect(parseUserThemes([text])).toEqual({ themes: [theme], ignored: [] });
  });
});

describe("parseUserThemes", () => {
  it("keeps the valid themes, in order of name", () => {
    const bay = imported("Bay");
    const lagoon = imported("Lagoon");
    const apple = imported("apple");
    const result = parseUserThemes([lagoon, bay, apple].map(serializeTheme));
    expect(result.themes.map((theme) => theme.name)).toEqual(["apple", "Bay", "Lagoon"]);
    expect(result.ignored).toEqual([]);
  });

  it("leaves out a file that is not JSON or not a valid theme, and says why", () => {
    const good = serializeTheme(imported("Lagoon"));
    const noAnsi = JSON.stringify({
      ...imported("Cove"),
      terminal: { ...imported("Cove").terminal, ansi: [] },
    });
    const result = parseUserThemes(["{ not json", good, "[]", noAnsi, "", "null"]);
    expect(result.themes.map((theme) => theme.id)).toEqual(["lagoon"]);
    expect(result.ignored).toHaveLength(5);
    expect(result.ignored[0]).toBe("A file of the themes folder is not JSON");
    expect(result.ignored[2]).toMatch(/not a valid theme/);
  });

  it("leaves out a theme that takes the id of a built-in theme, or of an earlier file", () => {
    const first = imported("Lagoon");
    const copy = { ...imported("Other"), id: "lagoon" };
    const result = parseUserThemes([
      serializeTheme(first),
      JSON.stringify(copy),
      serializeTheme(NOREN_DUSK),
      JSON.stringify({ ...NOREN_PAPER, id: "system" }),
    ]);
    expect(result.themes.map((theme) => theme.id)).toEqual(["lagoon"]);
    expect(result.themes[0]?.name).toBe("Lagoon");
    expect(result.ignored).toEqual([
      'The theme "lagoon" is left out: another theme already has that id',
      'The theme "noren-dusk" is left out: another theme already has that id',
      'The theme "system" is left out: another theme already has that id',
    ]);
  });

  it("reads a file that starts with a byte order mark", () => {
    const text = String.fromCharCode(0xfeff) + serializeTheme(imported("Lagoon"));
    expect(parseUserThemes([text]).themes).toHaveLength(1);
  });
});

describe("FakeBackend theme files", () => {
  it("saves a theme file by id, lists the files in order of id, and records the calls", async () => {
    const backend = new FakeBackend();
    expect(await backend.listUserThemes()).toEqual([]);
    await backend.saveUserTheme("zeta", "{}\n");
    await backend.saveUserTheme("alpha", '{"a":1}\n');
    expect(await backend.listUserThemes()).toEqual(['{"a":1}\n', "{}\n"]);
    expect(backend.userThemeFiles).toEqual({ alpha: '{"a":1}\n', zeta: "{}\n" });
    await backend.saveUserTheme("alpha", "{}\n");
    expect(backend.userThemeFiles["alpha"]).toBe("{}\n");
    expect(backend.callsTo("saveUserTheme")).toHaveLength(3);
    expect(backend.callsTo("listUserThemes")).toHaveLength(2);
  });

  it("refuses an id that is not a theme id, as the real one does (it becomes a file name)", async () => {
    const backend = new FakeBackend();
    for (const id of ["", "../x", "a/b", "A", "a b", "-a", "a-", "a--b"]) {
      await expect(backend.saveUserTheme(id, "{}")).rejects.toThrow(/not a valid theme id/);
    }
    expect(backend.userThemeFiles).toEqual({});
  });

  it("rejects when the disk refuses, and writes nothing", async () => {
    const backend = new FakeBackend();
    backend.setUserThemeSaveFailure(new Error("disk full"));
    await expect(backend.saveUserTheme("a", "{}")).rejects.toThrow("disk full");
    expect(backend.userThemeFiles).toEqual({});
    backend.setUserThemeSaveFailure(undefined);
    await backend.saveUserTheme("a", "{}");
    expect(backend.userThemeFiles).toEqual({ a: "{}" });
  });

  it("starts with the files it is given, and a file placed by hand shows in the list", async () => {
    const backend = new FakeBackend({ userThemes: { one: "1" } });
    backend.setUserTheme("two", "2");
    expect(await backend.listUserThemes()).toEqual(["1", "2"]);
    backend.setUserTheme("one", null);
    expect(await backend.listUserThemes()).toEqual(["2"]);
  });
});
