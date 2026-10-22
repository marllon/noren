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

describe("FakeBackend deleteUserTheme", () => {
  it("removes that file only and says whether there was one, twice is harmless", async () => {
    const backend = new FakeBackend({ userThemes: { lagoon: "1", bay: "2" } });
    await expect(backend.deleteUserTheme("lagoon")).resolves.toBe(true);
    expect(backend.userThemeFiles).toEqual({ bay: "2" });
    await expect(backend.deleteUserTheme("lagoon")).resolves.toBe(false);
    await expect(backend.deleteUserTheme("never-saved")).resolves.toBe(false);
    expect(await backend.listUserThemes()).toEqual(["2"]);
    expect(backend.callsTo("deleteUserTheme").map((call) => call.args)).toEqual([
      ["lagoon"],
      ["lagoon"],
      ["never-saved"],
    ]);
  });

  it("refuses an id that is not a theme id, as the real one does (it names a file)", async () => {
    const backend = new FakeBackend({ userThemes: { keep: "1" } });
    for (const id of ["", "../keep", "a/b", "..", "A", "a b", "keep.json", "con"]) {
      await expect(backend.deleteUserTheme(id), id).rejects.toThrow(/not a valid theme id/);
    }
    expect(backend.userThemeFiles).toEqual({ keep: "1" });
  });

  it("refuses the themes that ship with the app and the word system, which are not files", async () => {
    const backend = new FakeBackend({ userThemes: { "noren-dusk": "x" } });
    for (const id of ["noren-dusk", "noren-paper", "noren-oat", "system"]) {
      await expect(backend.deleteUserTheme(id), id).rejects.toThrow(/comes with Noren/);
    }
    expect(backend.userThemeFiles).toEqual({ "noren-dusk": "x" });
  });

  it("rejects when the disk refuses, and removes nothing", async () => {
    const backend = new FakeBackend({ userThemes: { lagoon: "1" } });
    backend.setUserThemeDeleteFailure(new Error("access denied"));
    await expect(backend.deleteUserTheme("lagoon")).rejects.toThrow("access denied");
    expect(backend.userThemeFiles).toEqual({ lagoon: "1" });
    backend.setUserThemeDeleteFailure(undefined);
    await expect(backend.deleteUserTheme("lagoon")).resolves.toBe(true);
  });
});

describe("FakeBackend exportUserTheme", () => {
  const words = { title: "Export theme", filter: "Theme files" };
  const text = serializeTheme(imported("Lagoon"));
  const lagoon = "C:\\Downloads\\lagoon.json";
  const again = "C:\\Downloads\\again.json";

  it("is a fake save chooser: it answers what was queued, in order, and null when nothing is", async () => {
    const backend = new FakeBackend();
    const ask = () => backend.exportUserTheme({ fileName: "lagoon.json", text, ...words });
    await expect(ask()).resolves.toBeNull();
    backend.setThemeExportPick(lagoon);
    backend.setThemeExportPick(null);
    backend.setThemeExportPick(again);
    await expect(ask()).resolves.toBe(lagoon);
    await expect(ask()).resolves.toBeNull();
    await expect(ask()).resolves.toBe(again);
    await expect(ask()).resolves.toBeNull();
    expect(Object.keys(backend.exportedThemeFiles)).toEqual([lagoon, again]);
  });

  it("keeps the text under the path chosen, adds .json to a name without it, and replaces a file", async () => {
    const backend = new FakeBackend();
    backend.setThemeExportPick("D:\\shared\\mine");
    await expect(
      backend.exportUserTheme({ fileName: "lagoon.json", text, ...words }),
    ).resolves.toBe("D:\\shared\\mine.json");
    expect(backend.exportedThemeFiles).toEqual({ "D:\\shared\\mine.json": text });
    backend.setThemeExportPick("D:\\shared\\mine.JSON");
    await backend.exportUserTheme({ fileName: "x.json", text: "{}", ...words });
    backend.setThemeExportPick("D:\\shared\\mine.json");
    await backend.exportUserTheme({ fileName: "x.json", text: "{ }", ...words });
    expect(backend.exportedThemeFiles).toEqual({
      "D:\\shared\\mine.json": "{ }",
      "D:\\shared\\mine.JSON": "{}",
    });
  });

  it("records the name offered, the words on the chooser and the text", async () => {
    const backend = new FakeBackend();
    await backend.exportUserTheme({ fileName: "lagoon.json", text, ...words });
    expect(backend.callsTo("exportUserTheme").map((call) => call.args)).toEqual([
      ["lagoon.json", "Export theme", "Theme files", text],
    ]);
  });

  it("checks the text before the chooser is asked, so no queued answer is used up", async () => {
    const backend = new FakeBackend();
    backend.setThemeExportPick("C:\\out.json");
    for (const bad of ["just words", "[1, 2]", "", "x".repeat(300 * 1024)]) {
      await expect(
        backend.exportUserTheme({ fileName: "a.json", text: bad, ...words }),
      ).rejects.toThrow();
    }
    await expect(backend.exportUserTheme({ fileName: "a.json", text, ...words })).resolves.toBe(
      "C:\\out.json",
    );
  });

  it("rejects with the error queued, for a chooser that cannot open or a file that cannot be written", async () => {
    const backend = new FakeBackend();
    backend.setThemeExportPick(new Error("could not write the theme file"));
    await expect(backend.exportUserTheme({ fileName: "a.json", text, ...words })).rejects.toThrow(
      "could not write the theme file",
    );
    expect(backend.exportedThemeFiles).toEqual({});
  });
});
