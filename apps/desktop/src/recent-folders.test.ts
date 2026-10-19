import { describe, expect, it } from "vitest";
import {
  MAX_RECENT_FOLDERS,
  RECENT_FOLDERS_KEY,
  addRecentFolder,
  loadRecentFolders,
  parseRecentFolders,
  saveRecentFolders,
} from "./recent-folders";

describe("addRecentFolder", () => {
  it("puts the newest folder first", () => {
    expect(addRecentFolder(addRecentFolder([], "/a"), "/b")).toEqual(["/b", "/a"]);
  });

  it("moves a folder seen again to the front, in the spelling of the latest report", () => {
    expect(addRecentFolder(["/b", "/a"], "/a")).toEqual(["/a", "/b"]);
    expect(addRecentFolder(["/z", "/x"], "/x/")).toEqual(["/x/", "/z"]);
    expect(addRecentFolder(["/z", "C:\\Work\\api"], "c:/work/API/")).toEqual([
      "c:/work/API/",
      "/z",
    ]);
  });

  it("compares folders as deep links do: separator, trailing slash and Windows case", () => {
    expect(addRecentFolder(["C:\\Work\\api"], "c:/work/API/")).toEqual(["C:\\Work\\api"]);
    // A POSIX path is case sensitive.
    expect(addRecentFolder(["/srv/Docs"], "/srv/docs")).toEqual(["/srv/docs", "/srv/Docs"]);
  });

  it("gives back the same list for a blank path or a folder that is already first", () => {
    const list = ["/a", "/b"];
    expect(addRecentFolder(list, "")).toBe(list);
    expect(addRecentFolder(list, "   ")).toBe(list);
    expect(addRecentFolder(list, "/a")).toBe(list);
    expect(addRecentFolder(list, "/a/")).toBe(list);
  });

  it("keeps at most 200 folders and lets the oldest go", () => {
    let list: readonly string[] = [];
    for (let i = 0; i < MAX_RECENT_FOLDERS + 30; i++) list = addRecentFolder(list, `/dir/${i}`);
    expect(list).toHaveLength(MAX_RECENT_FOLDERS);
    expect(list[0]).toBe(`/dir/${MAX_RECENT_FOLDERS + 29}`);
    expect(list[MAX_RECENT_FOLDERS - 1]).toBe("/dir/30");
    expect(list).not.toContain("/dir/29");
  });
});

describe("parseRecentFolders", () => {
  it("reads a saved list as it is", () => {
    expect(parseRecentFolders(JSON.stringify(["/b", "/a"]))).toEqual(["/b", "/a"]);
  });

  it("reads anything that is not a list as empty", () => {
    for (const raw of [null, "", "not json", "{", "{}", '"/a"', "42", "null", '{"0":"/a"}']) {
      expect(parseRecentFolders(raw)).toEqual([]);
    }
  });

  it("drops entries that are not text or are blank, and repeats of a folder", () => {
    const raw = JSON.stringify(["/a", 3, null, "", "  ", "/b", "/a/", { path: "/c" }, "/c"]);
    expect(parseRecentFolders(raw)).toEqual(["/a", "/b", "/c"]);
  });

  it("cuts a list longer than the maximum, keeping the most recent", () => {
    const long = Array.from({ length: MAX_RECENT_FOLDERS + 50 }, (_, i) => `/dir/${i}`);
    const read = parseRecentFolders(JSON.stringify(long));
    expect(read).toHaveLength(MAX_RECENT_FOLDERS);
    expect(read[0]).toBe("/dir/0");
  });
});

describe("loadRecentFolders and saveRecentFolders", () => {
  it("round-trips through the storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    saveRecentFolders(storage, ["/b", "/a"]);
    expect(values.has(RECENT_FOLDERS_KEY)).toBe(true);
    expect(loadRecentFolders(storage)).toEqual(["/b", "/a"]);
  });

  it("reads a corrupt value as empty and survives a storage that throws or is missing", () => {
    expect(loadRecentFolders({ getItem: () => "{broken", setItem: () => undefined })).toEqual([]);
    const throwing = {
      getItem: (): string => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("full");
      },
    };
    expect(loadRecentFolders(throwing)).toEqual([]);
    expect(() => saveRecentFolders(throwing, ["/a"])).not.toThrow();
    expect(loadRecentFolders(undefined)).toEqual([]);
    expect(() => saveRecentFolders(undefined, ["/a"])).not.toThrow();
  });
});
