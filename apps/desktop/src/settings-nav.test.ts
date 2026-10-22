import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  columnMove,
  currentSection,
  foldText,
  matchesWords,
  navPart,
  searchWords,
  sectionPart,
  visibleRows,
} from "./settings-nav";

describe("the sections", () => {
  it("are the ones of the old screen, each once, with Themes second and Window beside Background", () => {
    expect([...SETTINGS_SECTIONS]).toEqual([
      "appearance",
      "themes",
      "window",
      "background",
      "terminal",
      "profiles",
      "shortcuts",
      "notifications",
      "archive",
      "ai",
      "mods",
      "gallery",
      "sync",
      "updates",
      "import",
    ]);
    expect(new Set(SETTINGS_SECTIONS).size).toBe(SETTINGS_SECTIONS.length);
  });

  it("have a part name for the section and one for its button in the column", () => {
    expect(sectionPart("terminal")).toBe("settings-terminal");
    expect(navPart("terminal")).toBe("settings-nav-terminal");
    // `pnpm shot --open-settings <section>` looks for the first (the old part names are the same).
    for (const section of SETTINGS_SECTIONS) {
      expect(sectionPart(section)).toMatch(/^settings-[a-z]+$/);
    }
  });
});

describe("foldText", () => {
  it("drops case, accents and extra spaces", () => {
    expect(foldText("  Sincronização   por ")).toBe("sincronizacao por");
    expect(foldText("Notificações")).toBe("notificacoes");
    expect(foldText("Português (Brasil)")).toBe("portugues (brasil)");
    expect(foldText("")).toBe("");
  });
});

describe("searchWords and matchesWords", () => {
  it("make no words of an empty search, which keeps everything", () => {
    expect(searchWords("")).toEqual([]);
    expect(searchWords("   ")).toEqual([]);
    expect(matchesWords([], ["anything"])).toBe(true);
    expect(matchesWords([], [])).toBe(true);
  });

  it("find a word in any text, with accents and case ignored", () => {
    expect(matchesWords(searchWords("SINCRONIZACAO"), ["Sincronização"])).toBe(true);
    expect(matchesWords(searchWords("scroll"), ["Scrollback (lines)"])).toBe(true);
    expect(matchesWords(searchWords("scrollbak"), ["Scrollback (lines)"])).toBe(false);
  });

  it("need every word, wherever they are", () => {
    const texts = ["Cursor shape", "Block", "Bar"];
    expect(matchesWords(searchWords("shape block"), texts)).toBe(true);
    expect(matchesWords(searchWords("block sync"), texts)).toBe(false);
  });
});

describe("visibleRows", () => {
  const rows = [["Font size (px)"], ["Cursor shape", "Block", "Bar"], ["Scrollback (lines)"]];

  it("keeps every row when the search is empty", () => {
    expect(visibleRows([], "Terminal", rows)).toEqual([true, true, true]);
  });

  it("keeps the section whole when its title has every word", () => {
    expect(visibleRows(searchWords("terminal"), "Terminal", rows)).toEqual([true, true, true]);
    expect(visibleRows(searchWords("TERMINAL"), "Terminal options", rows)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("keeps the rows that have the words, with the title counting as one of the texts", () => {
    expect(visibleRows(searchWords("scroll"), "Terminal", rows)).toEqual([false, false, true]);
    expect(visibleRows(searchWords("terminal cursor"), "Terminal", rows)).toEqual([
      false,
      true,
      false,
    ]);
    expect(visibleRows(searchWords("underline"), "Terminal", rows)).toEqual([false, false, false]);
  });

  it("finds a word that is one of the choices of a row", () => {
    expect(visibleRows(searchWords("bar"), "Terminal", rows)).toEqual([false, true, false]);
  });
});

describe("currentSection", () => {
  const tops = [0, 300, 700, 1100];

  it("is the first section at the start and for a position above all of them", () => {
    expect(currentSection(tops, 0)).toBe(0);
    expect(currentSection([40, 300], 0)).toBe(0);
    expect(currentSection([], 120)).toBe(0);
  });

  it("is the last section whose top is at or above the top of the visible part", () => {
    expect(currentSection(tops, 299 - 8)).toBe(0);
    expect(currentSection(tops, 300)).toBe(1);
    expect(currentSection(tops, 699)).toBe(2);
    expect(currentSection(tops, 5000)).toBe(3);
  });

  it("counts a section scrolled to the top by a click, give or take a few pixels", () => {
    expect(currentSection(tops, 300 - 5)).toBe(1);
    expect(currentSection(tops, 300 - 9)).toBe(0);
    expect(currentSection(tops, 300 - 20, 24)).toBe(1);
  });
});

describe("columnMove", () => {
  it("goes down and up one item and stops at the ends", () => {
    expect(columnMove(0, "ArrowDown", 4)).toBe(1);
    expect(columnMove(3, "ArrowDown", 4)).toBe(3);
    expect(columnMove(2, "ArrowUp", 4)).toBe(1);
    expect(columnMove(0, "ArrowUp", 4)).toBe(0);
  });

  it("goes to the first and the last with Home and End", () => {
    expect(columnMove(2, "Home", 4)).toBe(0);
    expect(columnMove(1, "End", 4)).toBe(3);
  });

  it("leaves every other key to the page, and an empty column to nobody", () => {
    expect(columnMove(1, "Enter", 4)).toBeUndefined();
    expect(columnMove(1, "ArrowRight", 4)).toBeUndefined();
    expect(columnMove(1, "a", 4)).toBeUndefined();
    expect(columnMove(0, "ArrowDown", 0)).toBeUndefined();
  });
});
