import { FakeBackend, THEMES, parseUserThemes } from "@noren/model";
import type { Theme } from "@noren/model";
import {
  JSON_SETTINGS,
  KEY_VALUE_BAD_COLOR,
  KEY_VALUE_LAGOON,
  NOT_A_SCHEME,
  PLIST_LAGOON,
  PLIST_MISSING_COLOR,
} from "@noren/model/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_SCHEME_FILE_BYTES, importSchemeFile, nameFromFile } from "./scheme-import";
import type { PickedFile } from "./scheme-import";
import {
  addUserThemes,
  allThemes,
  getUserThemes,
  loadUserThemes,
  resetUserThemes,
} from "./user-themes-store";

function fileOf(name: string, text: string): PickedFile {
  return { name, size: new TextEncoder().encode(text).length, text: () => Promise.resolve(text) };
}

/** Imports `file` the way the app does: into the backend and the list of themes. */
function runImport(backend: FakeBackend, file: PickedFile): Promise<string> {
  return importSchemeFile(file, { backend, existing: getUserThemes(), added: addUserThemes });
}

beforeEach(() => resetUserThemes());

describe("nameFromFile", () => {
  it("is the file name without its extension and without the folders", () => {
    expect(nameFromFile("Lagoon.itermcolors")).toBe("Lagoon");
    expect(nameFromFile("C:\\Users\\me\\Downloads\\Lagoon Dark.itermcolors")).toBe("Lagoon Dark");
    expect(nameFromFile("/home/me/lagoon.theme.json")).toBe("lagoon.theme");
    expect(nameFromFile("lagoon")).toBe("lagoon");
    expect(nameFromFile(".hidden")).toBe(".hidden");
  });
});

describe("importSchemeFile", () => {
  it("writes the theme as a file of the themes folder, puts it on the list and says how to use it", async () => {
    const backend = new FakeBackend();
    const notice = await runImport(backend, fileOf("Lagoon.itermcolors", PLIST_LAGOON));
    expect(notice).toBe(
      'Imported color scheme "Lagoon". Pick it with "Theme: Lagoon" in the command palette.',
    );
    expect(Object.keys(backend.userThemeFiles)).toEqual(["lagoon"]);
    // What was written reads back as the theme that is on the list.
    const written = parseUserThemes(await backend.listUserThemes());
    expect(written.ignored).toEqual([]);
    expect(written.themes).toEqual(getUserThemes());
    expect(allThemes().map((theme) => theme.id)).toEqual([...THEMES.map((t) => t.id), "lagoon"]);
  });

  it("reads a file with no extension by what is in it", async () => {
    const backend = new FakeBackend();
    const notice = await runImport(backend, fileOf("lagoon-colors", KEY_VALUE_LAGOON));
    expect(notice).toContain('Imported color scheme "lagoon-colors"');
    expect(Object.keys(backend.userThemeFiles)).toEqual(["lagoon-colors"]);
  });

  it("gives an id no theme has when the name is taken, by the built-in themes or by the user's", async () => {
    const backend = new FakeBackend();
    await runImport(backend, fileOf("Noren Dusk.itermcolors", PLIST_LAGOON));
    await runImport(backend, fileOf("Noren Dusk.itermcolors", PLIST_LAGOON));
    expect(Object.keys(backend.userThemeFiles)).toEqual(["noren-dusk-2", "noren-dusk-3"]);
    expect(getUserThemes().map((theme) => theme.name)).toEqual([
      "Noren Dusk (2)",
      "Noren Dusk (3)",
    ]);
  });

  it("imports every valid scheme of a file and says what it left out", async () => {
    const backend = new FakeBackend();
    const notice = await runImport(backend, fileOf("settings.json", JSON_SETTINGS));
    expect(notice).toBe(
      'Imported 2 color schemes: "Lagoon", "Noren Dusk (2)". Pick one with "Theme: ..." in the command palette. Left out: Scheme "Broken": "red" is missing',
    );
    expect(Object.keys(backend.userThemeFiles)).toEqual(["lagoon", "noren-dusk-2"]);
    expect(getUserThemes().map((theme) => theme.id)).toEqual(["lagoon", "noren-dusk-2"]);
  });

  it("says why a file is not a scheme, and writes nothing", async () => {
    const backend = new FakeBackend();
    for (const [name, text, reason] of [
      ["notes.txt", NOT_A_SCHEME, "This file is not a color scheme Noren can read."],
      ["bad.itermcolors", PLIST_MISSING_COLOR, '"Ansi 3 Color" is missing'],
      ["bad", KEY_VALUE_BAD_COLOR, "is not a color"],
    ] as const) {
      const notice = await runImport(backend, fileOf(name, text));
      expect(notice).toContain(`Could not import "${name}": `);
      expect(notice).toContain(reason);
    }
    expect(backend.callsTo("saveUserTheme")).toHaveLength(0);
    expect(backend.userThemeFiles).toEqual({});
    expect(getUserThemes()).toEqual([]);
  });

  it("does not read a file that is too large to be a scheme", async () => {
    const backend = new FakeBackend();
    let read = false;
    const notice = await runImport(backend, {
      name: "huge.itermcolors",
      size: MAX_SCHEME_FILE_BYTES + 1,
      text: () => {
        read = true;
        return Promise.resolve(PLIST_LAGOON);
      },
    });
    expect(notice).toBe(
      'Could not import "huge.itermcolors": the file is too large to be a color scheme.',
    );
    expect(read).toBe(false);
    expect(backend.callsTo("saveUserTheme")).toHaveLength(0);
  });

  it("says so when the file cannot be read", async () => {
    const backend = new FakeBackend();
    const notice = await runImport(backend, {
      name: "gone.itermcolors",
      size: 10,
      text: () => Promise.reject(new Error("permission denied")),
    });
    expect(notice).toBe('Could not import "gone.itermcolors": the file could not be read.');
    expect(backend.callsTo("saveUserTheme")).toHaveLength(0);
  });

  it("does not put a theme on the list that it could not write", async () => {
    const backend = new FakeBackend();
    backend.setUserThemeSaveFailure(new Error("disk full"));
    const notice = await runImport(backend, fileOf("Lagoon.itermcolors", PLIST_LAGOON));
    expect(notice).toBe('Could not save the color scheme "Lagoon": disk full');
    expect(getUserThemes()).toEqual([]);
    expect(allThemes()).toBe(THEMES);
  });

  it("keeps the schemes that were written when a later one fails", async () => {
    const backend = new FakeBackend();
    const original = backend.saveUserTheme.bind(backend);
    backend.saveUserTheme = async (id, text) => {
      if (id === "noren-dusk-2") throw new Error("disk full");
      await original(id, text);
    };
    const notice = await runImport(backend, fileOf("settings.json", JSON_SETTINGS));
    expect(notice).toBe('Could not save the color scheme "Noren Dusk (2)": disk full');
    expect(getUserThemes().map((theme) => theme.id)).toEqual(["lagoon"]);
  });
});

describe("the list of the themes of the user", () => {
  const theme = (id: string, name: string): Theme => ({ ...(THEMES[0] as Theme), id, name });

  it("is the built-in list itself until the user has a theme", () => {
    expect(allThemes()).toBe(THEMES);
    addUserThemes([theme("bay", "Bay")]);
    expect(allThemes()).not.toBe(THEMES);
    resetUserThemes();
    expect(allThemes()).toBe(THEMES);
  });

  it("keeps the user's themes after the built-in ones, by name, and replaces a theme of the same id", () => {
    addUserThemes([theme("lagoon", "Lagoon"), theme("apple", "apple")]);
    addUserThemes([theme("bay", "Bay"), theme("lagoon", "Lagoon again")]);
    expect(getUserThemes().map((t) => t.name)).toEqual(["apple", "Bay", "Lagoon again"]);
    expect(allThemes().slice(0, THEMES.length)).toEqual([...THEMES]);
  });

  it("is loaded from the backend, leaving out files that are not valid themes", async () => {
    const backend = new FakeBackend({
      userThemes: { good: JSON.stringify(theme("good", "Good")), bad: "{ not json" },
    });
    await loadUserThemes(backend);
    expect(getUserThemes().map((t) => t.id)).toEqual(["good"]);
  });

  it("stays as it was when the folder cannot be read", async () => {
    addUserThemes([theme("bay", "Bay")]);
    const backend = new FakeBackend();
    backend.listUserThemes = () => Promise.reject(new Error("access denied"));
    await expect(loadUserThemes(backend)).rejects.toThrow("access denied");
    expect(getUserThemes().map((t) => t.id)).toEqual(["bay"]);
  });
});
