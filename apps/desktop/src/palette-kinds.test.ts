import { FakeBackend, createSequentialIds, restoreWorkspace } from "@noren/model";
import { describe, expect, it } from "vitest";
import { buildEntries, searchEntries } from "./palette";
import type { PaletteEntry } from "./palette";
import { THEMES } from "./theme";
import { createWorkspaceStore } from "./workspace-store";

// The profile, recent folder and theme entries of the palette (the tab, space and action entries
// are in palette.test.ts).

const clock = { now: () => 1000 };

const profiles = [
  { id: "pwsh", name: "PowerShell", default: true },
  { id: "bash", name: "Git Bash", default: false },
];
const folders = ["C:\\Users\\me\\api", "/srv/docs", "C:\\Users\\me\\web"];

async function entriesFor(choice: string | null = "noren-dusk", withKinds = true) {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  return buildEntries({
    workspace: store.getState().workspace,
    chords: {},
    home: "C:\\Users\\me",
    ...(withKinds ? { profiles, folders, themes: { list: THEMES, choice } } : {}),
  });
}

const ofKind = (entries: readonly PaletteEntry[], kind: PaletteEntry["kind"]) =>
  entries.filter((entry) => entry.kind === kind);
const titles = (entries: readonly PaletteEntry[]) => entries.map((entry) => entry.title);
const kindsOf = (entries: readonly PaletteEntry[], query: string) => [
  ...new Set(searchEntries(entries, query).map((entry) => entry.kind)),
];

describe("profile entries", () => {
  it("lists one entry per profile, opening in the active space", async () => {
    const entries = await entriesFor();
    const space = entries.find((entry) => entry.kind === "space")?.title ?? "";
    expect(ofKind(entries, "profile")).toMatchObject([
      { title: "New PowerShell tab", detail: `in ${space}`, profileId: "pwsh" },
      { title: "New Git Bash tab", detail: `in ${space}`, profileId: "bash" },
    ]);
  });

  it("finds a profile by part of its name", async () => {
    const entries = await entriesFor();
    expect(titles(searchEntries(entries, "git bash"))).toEqual(["New Git Bash tab"]);
    expect(titles(searchEntries(entries, ">powershell"))).toEqual(["New PowerShell tab"]);
  });
});

describe("recent folder entries", () => {
  it("lists the folders in the order given, with the short form as the title", async () => {
    const entries = await entriesFor();
    expect(ofKind(entries, "folder")).toMatchObject([
      { title: "~\\api", path: "C:\\Users\\me\\api" },
      { title: "/srv/docs", path: "/srv/docs" },
      { title: "~\\web", path: "C:\\Users\\me\\web" },
    ]);
  });

  it("keeps the most recent first when nothing is typed", async () => {
    const entries = await entriesFor();
    const listed = searchEntries(entries, ">").filter((entry) => entry.kind === "folder");
    expect(titles(listed)).toEqual(["~\\api", "/srv/docs", "~\\web"]);
  });

  it("finds a folder by its full path even where the title is short", async () => {
    const entries = await entriesFor();
    expect(titles(searchEntries(entries, "users me web"))).toEqual(["~\\web"]);
    expect(titles(searchEntries(entries, ">docs"))).toEqual(["/srv/docs"]);
  });
});

describe("theme entries", () => {
  it("lists every theme and the choice to follow the system, marking the one in use", async () => {
    const entries = await entriesFor("noren-dusk");
    expect(ofKind(entries, "theme")).toMatchObject([
      { title: "Theme: Noren Dusk", themeId: "noren-dusk", current: true, detail: "Dark · in use" },
      { title: "Theme: Noren Paper", themeId: "noren-paper", current: false, detail: "Light" },
      { title: "Theme: Noren Nightshade", themeId: "noren-nightshade", detail: "Dark" },
      { title: "Theme: Noren Fjord", themeId: "noren-fjord", detail: "Dark" },
      { title: "Theme: Noren Midnight", themeId: "noren-midnight", detail: "Dark" },
      { title: "Theme: Noren Meadow", themeId: "noren-meadow", detail: "Dark" },
      { title: "Theme: Noren Dune", themeId: "noren-dune", detail: "Light" },
      { title: "Theme: Noren Oat", themeId: "noren-oat", detail: "Light" },
      { title: "Follow system theme", themeId: null, current: false },
    ]);
  });

  it("marks the system choice when no theme was picked", async () => {
    const themes = ofKind(await entriesFor(null), "theme");
    expect(themes.map((entry) => entry.kind === "theme" && entry.current)).toEqual([
      ...THEMES.map(() => false),
      true,
    ]);
  });

  it("finds a theme by part of its name", async () => {
    const entries = await entriesFor();
    expect(titles(searchEntries(entries, "paper"))).toEqual(["Theme: Noren Paper"]);
    expect(titles(searchEntries(entries, "fjord"))).toEqual(["Theme: Noren Fjord"]);
    expect(titles(searchEntries(entries, "follow system"))).toEqual(["Follow system theme"]);
  });
});

describe("the new kinds and the prefixes", () => {
  it("are listed with no prefix and under >, but not under @ or #", async () => {
    const entries = await entriesFor();
    expect(kindsOf(entries, "")).toEqual(["tab", "space", "action", "profile", "folder", "theme"]);
    expect(kindsOf(entries, ">")).toEqual(["action", "profile", "folder", "theme"]);
    expect(kindsOf(entries, "@")).toEqual(["tab"]);
    expect(kindsOf(entries, "#")).toEqual(["space"]);
  });

  it("are left out when the sources do not carry them", async () => {
    const entries = await entriesFor("noren-dusk", false);
    expect(kindsOf(entries, "")).toEqual(["tab", "space", "action"]);
  });
});
