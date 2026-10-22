import { FakeBackend, MAX_THEME_NAME, NOREN_DUSK, THEMES, parseTheme } from "@noren/model";
import type { Theme } from "@noren/model";
import { PLIST_LAGOON } from "@noren/model/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "./i18n";
import { importSchemeFile } from "./scheme-import";
import {
  deleteUserThemeFile,
  duplicateUserTheme,
  exportUserThemeFile,
  isUserTheme,
  renameUserTheme,
} from "./themes-section";
import {
  addUserThemes,
  allThemes,
  getUserThemes,
  loadUserThemes,
  resetUserThemes,
} from "./user-themes-store";

// What the themes section does with a theme: every action writes through the backend first and only
// then changes the list the window has, so what the gallery shows is what is on the disk, and a
// theme that is made or renamed here is always a valid theme file.

beforeEach(() => resetUserThemes());
afterEach(() => setLanguage("en"));

/** A backend whose themes folder holds `files`, and the list of themes the window read from it. */
async function withFiles(files: Record<string, Theme> = {}): Promise<FakeBackend> {
  const backend = new FakeBackend({
    userThemes: Object.fromEntries(
      Object.entries(files).map(([id, theme]) => [id, JSON.stringify(theme)]),
    ),
  });
  await loadUserThemes(backend);
  return backend;
}

const mine: Theme = {
  ...NOREN_DUSK,
  id: "mine",
  name: "Mine",
  ui: { ...NOREN_DUSK.ui, accent: "#10b981" },
  font: { family: "Fira Code", size: 15, lineHeight: 1.3, ligatures: false },
  background: { image: "backgrounds/sky.png", opacity: 0.4, blur: 5 },
};

/** The theme file the backend holds for `id`, read as a theme. */
function savedTheme(backend: FakeBackend, id: string): Theme {
  const text = backend.userThemeFiles[id];
  if (text === undefined) throw new Error(`no file for ${id}`);
  const parsed = parseTheme(JSON.parse(text));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.theme;
}

describe("duplicateUserTheme", () => {
  it("writes a copy of a theme that ships with the app and adds it to the gallery as the user's own", async () => {
    const backend = await withFiles();
    const outcome = await duplicateUserTheme(backend, NOREN_DUSK);
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("“Noren Dusk copy”");
    expect(outcome.theme?.id).toBe("noren-dusk-copy");
    expect(Object.keys(backend.userThemeFiles)).toEqual(["noren-dusk-copy"]);
    expect(savedTheme(backend, "noren-dusk-copy")).toEqual({
      ...NOREN_DUSK,
      id: "noren-dusk-copy",
      name: "Noren Dusk copy",
    });
    expect(allThemes().map((theme) => theme.id)).toEqual([
      ...THEMES.map((t) => t.id),
      "noren-dusk-copy",
    ]);
    const copy = getUserThemes()[0];
    expect(copy !== undefined && isUserTheme(copy)).toBe(true);
    expect(isUserTheme(NOREN_DUSK)).toBe(false);
  });

  it("keeps everything a theme of the user has: the font, the background and the colors", async () => {
    const backend = await withFiles({ mine });
    const outcome = await duplicateUserTheme(backend, mine);
    expect(outcome.theme).toEqual({ ...mine, id: "mine-copy", name: "Mine copy" });
    expect(savedTheme(backend, "mine-copy")).toEqual({
      ...mine,
      id: "mine-copy",
      name: "Mine copy",
    });
    expect(savedTheme(backend, "mine")).toEqual(mine);
  });

  it("gives each copy of the same theme a name and an id of its own", async () => {
    const backend = await withFiles();
    const first = await duplicateUserTheme(backend, NOREN_DUSK);
    const second = await duplicateUserTheme(backend, NOREN_DUSK);
    const third = await duplicateUserTheme(backend, NOREN_DUSK);
    expect([first, second, third].map((outcome) => outcome.theme?.id)).toEqual([
      "noren-dusk-copy",
      "noren-dusk-copy-2",
      "noren-dusk-copy-3",
    ]);
    expect([first, second, third].map((outcome) => outcome.theme?.name)).toEqual([
      "Noren Dusk copy",
      "Noren Dusk copy (2)",
      "Noren Dusk copy (3)",
    ]);
    expect(Object.keys(backend.userThemeFiles)).toHaveLength(3);
  });

  it("says the name of the copy in the language in force", async () => {
    setLanguage("pt-BR");
    const backend = await withFiles();
    const outcome = await duplicateUserTheme(backend, NOREN_DUSK);
    expect(outcome.theme?.name).toBe("Noren Dusk (cópia)");
    expect(outcome.theme?.id).toBe("noren-dusk-copia");
    expect(outcome.message).toBe(
      "Criado “Noren Dusk (cópia)”, uma cópia sua. Renomeie, exporte ou apague pelo cartão dele.",
    );
  });

  it("writes nothing and adds nothing when the disk refuses, and says why", async () => {
    const backend = await withFiles();
    backend.setUserThemeSaveFailure(new Error("disk full"));
    const outcome = await duplicateUserTheme(backend, NOREN_DUSK);
    expect(outcome).toEqual({
      ok: false,
      message: "Could not duplicate “Noren Dusk”: disk full",
    });
    expect(backend.userThemeFiles).toEqual({});
    expect(getUserThemes()).toEqual([]);
  });
});

describe("renameUserTheme", () => {
  it("rewrites the same file with the new name, keeps the id, and the gallery shows it in order", async () => {
    const backend = await withFiles({ mine, other: { ...mine, id: "other", name: "Other" } });
    const outcome = await renameUserTheme(backend, mine, "Zebra");
    expect(outcome).toEqual({
      ok: true,
      message: "Renamed to “Zebra”.",
      theme: { ...mine, name: "Zebra" },
    });
    expect(Object.keys(backend.userThemeFiles).sort()).toEqual(["mine", "other"]);
    expect(savedTheme(backend, "mine")).toEqual({ ...mine, name: "Zebra" });
    expect(getUserThemes().map((theme) => theme.name)).toEqual(["Other", "Zebra"]);
    expect(allThemes().filter((theme) => theme.id === "mine")).toHaveLength(1);
  });

  it("refuses a name that is empty or too long, with a sentence, and changes nothing", async () => {
    const backend = await withFiles({ mine });
    const before = backend.userThemeFiles["mine"];
    expect(await renameUserTheme(backend, mine, "   ")).toEqual({
      ok: false,
      message: "A theme needs a name.",
    });
    expect(await renameUserTheme(backend, mine, "x".repeat(MAX_THEME_NAME + 1))).toEqual({
      ok: false,
      message: `A name has at most ${MAX_THEME_NAME} characters.`,
    });
    expect(backend.userThemeFiles["mine"]).toBe(before);
    expect(backend.callsTo("saveUserTheme")).toHaveLength(0);
    expect(getUserThemes()).toEqual([mine]);
  });

  it("says the refusal in Portuguese when that is the language", async () => {
    setLanguage("pt-BR");
    const backend = await withFiles({ mine });
    expect((await renameUserTheme(backend, mine, "")).message).toBe("Um tema precisa de um nome.");
    expect((await renameUserTheme(backend, mine, "x".repeat(61))).message).toBe(
      "Um nome tem no máximo 60 caracteres.",
    );
  });

  it("keeps the old name on the disk and on the list when the write fails", async () => {
    const backend = await withFiles({ mine });
    backend.setUserThemeSaveFailure(new Error("access denied"));
    const outcome = await renameUserTheme(backend, mine, "Better");
    expect(outcome).toEqual({ ok: false, message: "Could not rename “Mine”: access denied" });
    expect(savedTheme(backend, "mine").name).toBe("Mine");
    expect(getUserThemes()).toEqual([mine]);
  });
});

describe("deleteUserThemeFile", () => {
  it("removes the file and takes the theme out of the gallery, leaving the others", async () => {
    const backend = await withFiles({ mine, other: { ...mine, id: "other", name: "Other" } });
    const outcome = await deleteUserThemeFile(backend, mine);
    expect(outcome).toEqual({ ok: true, message: "Deleted “Mine”." });
    expect(Object.keys(backend.userThemeFiles)).toEqual(["other"]);
    expect(getUserThemes().map((theme) => theme.id)).toEqual(["other"]);
    expect(allThemes().map((theme) => theme.id)).toEqual([...THEMES.map((t) => t.id), "other"]);
  });

  it("never asks the backend to delete a theme that ships with the app", async () => {
    const backend = await withFiles({ mine });
    for (const theme of THEMES) {
      const outcome = await deleteUserThemeFile(backend, theme);
      expect(outcome.ok, theme.id).toBe(false);
      expect(outcome.message).toBe(
        `Could not delete “${theme.name}”: it is not one of your own themes`,
      );
    }
    expect(backend.callsTo("deleteUserTheme")).toHaveLength(0);
    expect(allThemes().map((theme) => theme.id)).toEqual([...THEMES.map((t) => t.id), "mine"]);
  });

  it("keeps the theme on the list and on the disk when the disk refuses", async () => {
    const backend = await withFiles({ mine });
    backend.setUserThemeDeleteFailure(new Error("the file is in use"));
    const outcome = await deleteUserThemeFile(backend, mine);
    expect(outcome).toEqual({ ok: false, message: "Could not delete “Mine”: the file is in use" });
    expect(Object.keys(backend.userThemeFiles)).toEqual(["mine"]);
    expect(getUserThemes()).toEqual([mine]);
  });
});

describe("exportUserThemeFile", () => {
  const words = { title: "Export theme", filter: "Theme files" };

  it("hands the theme to the save chooser as the text of its file, and says where it went", async () => {
    const backend = await withFiles({ mine });
    backend.setThemeExportPick("C:\\Users\\me\\Downloads\\mine.json");
    const outcome = await exportUserThemeFile(backend, mine);
    expect(outcome).toEqual({
      ok: true,
      message: "Exported “Mine” to C:\\Users\\me\\Downloads\\mine.json.",
    });
    const [call] = backend.callsTo("exportUserTheme");
    expect(call?.args.slice(0, 3)).toEqual(["mine.json", words.title, words.filter]);
    // The file is the theme as the theme folder holds it, so importing it again brings it back whole.
    const written = backend.exportedThemeFiles["C:\\Users\\me\\Downloads\\mine.json"];
    expect(written).toBe(`${JSON.stringify(mine, null, 2)}\n`);
  });

  it("says the words on the chooser in the language in force", async () => {
    setLanguage("pt-BR");
    const backend = await withFiles({ mine });
    await exportUserThemeFile(backend, mine);
    expect(backend.callsTo("exportUserTheme")[0]?.args.slice(1, 3)).toEqual([
      "Exportar tema",
      "Arquivos de tema",
    ]);
  });

  it("is not a failure when the chooser is closed, and writes nothing", async () => {
    const backend = await withFiles({ mine });
    expect(await exportUserThemeFile(backend, mine)).toEqual({
      ok: true,
      message: "Nothing was exported: no file was chosen.",
    });
    expect(backend.exportedThemeFiles).toEqual({});
  });

  it("says why when the chooser cannot be opened or the file cannot be written", async () => {
    const backend = await withFiles({ mine });
    backend.setThemeExportPick(new Error("the file chooser could not be opened"));
    expect(await exportUserThemeFile(backend, mine)).toEqual({
      ok: false,
      message: "Could not export “Mine”: the file chooser could not be opened",
    });
  });

  it("brings the theme back whole when the file is imported again, under a new id if the id is taken", async () => {
    const backend = await withFiles({ mine });
    backend.setThemeExportPick("C:\\out\\mine.json");
    await exportUserThemeFile(backend, mine);
    const text = backend.exportedThemeFiles["C:\\out\\mine.json"] ?? "";
    const file = { name: "mine.json", size: text.length, text: () => Promise.resolve(text) };

    // On a window that has the theme: the import takes a new id, and the original is untouched.
    const notice = await importSchemeFile(file, {
      backend,
      existing: getUserThemes(),
      added: addUserThemes,
    });
    expect(notice).toContain("Imported color scheme");
    expect(getUserThemes().map((theme) => theme.id)).toEqual(["mine", "mine-2"]);
    expect(savedTheme(backend, "mine")).toEqual(mine);
    expect(savedTheme(backend, "mine-2")).toEqual({ ...mine, id: "mine-2", name: "Mine (2)" });

    // On a window that does not: it comes back with the same id and everything it said.
    resetUserThemes();
    const fresh = new FakeBackend();
    await importSchemeFile(file, { backend: fresh, existing: [], added: addUserThemes });
    expect(savedTheme(fresh, "mine")).toEqual(mine);
  });

  it("still imports a color scheme of another program, as before", async () => {
    const backend = new FakeBackend();
    const file = {
      name: "Lagoon.itermcolors",
      size: PLIST_LAGOON.length,
      text: () => Promise.resolve(PLIST_LAGOON),
    };
    await importSchemeFile(file, { backend, existing: [], added: addUserThemes });
    expect(Object.keys(backend.userThemeFiles)).toEqual(["lagoon"]);
  });
});
