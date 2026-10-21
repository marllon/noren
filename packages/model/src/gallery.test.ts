import { describe, expect, it } from "vitest";
import {
  GALLERY_LIMITS,
  compareGalleryVersions,
  compareWithInstalled,
  parseGalleryIndex,
} from "./gallery";
import type { GalleryIndex, InstalledGalleryItem } from "./gallery";

const HASH = "a".repeat(64);

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lagoon",
    kind: "theme",
    name: "Lagoon",
    version: "1.0.0",
    url: "https://example.com/lagoon.json",
    sha256: HASH,
    size: 1200,
    ...overrides,
  };
}

function index(...items: Record<string, unknown>[]): unknown {
  return { version: 1, items };
}

function errorsOf(value: unknown): string[] {
  const result = parseGalleryIndex(value);
  if (result.ok) throw new Error("the index was accepted");
  return result.errors;
}

describe("parseGalleryIndex", () => {
  it("accepts an index with a theme and a mod, and an empty one", () => {
    const result = parseGalleryIndex(
      index(item(), item({ id: "compact-tabs", kind: "mod", name: "Compact tabs", size: 300 })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.index.items.map((entry) => entry.kind)).toEqual(["theme", "mod"]);
    expect(parseGalleryIndex(index()).ok).toBe(true);
  });

  it("refuses what is not an index", () => {
    for (const value of [null, 3, "text", [], {}, { items: [] }, { version: 1 }]) {
      expect(parseGalleryIndex(value).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it("refuses another version of the index and a field that is not known", () => {
    expect(errorsOf({ version: 2, items: [] }).join()).toContain("version");
    expect(errorsOf({ version: 1, items: [], extra: true }).length).toBeGreaterThan(0);
    expect(errorsOf(index(item({ homepage: "https://example.com" }))).length).toBeGreaterThan(0);
  });

  it("refuses an id that is not safe as a file name", () => {
    for (const id of [
      "",
      "Lagoon",
      "../lagoon",
      "a/b",
      "a\\b",
      "a.b",
      "con",
      "-a",
      "a--b",
      "a b",
      "x".repeat(65),
      3,
    ]) {
      expect(errorsOf(index(item({ id }))).join(), String(id)).toContain("items.0.id");
    }
  });

  it("refuses a kind that is not theme or mod", () => {
    expect(errorsOf(index(item({ kind: "plugin" }))).join()).toContain("items.0.kind");
  });

  it("refuses an empty or long name and a version that does not look like 1.2.3", () => {
    expect(errorsOf(index(item({ name: "  " }))).join()).toContain("items.0.name");
    expect(errorsOf(index(item({ name: "n".repeat(61) }))).join()).toContain("items.0.name");
    for (const version of ["1", "1.2", "v1.2.3", "1.2.3.4", "", "1.2.3 beta"]) {
      expect(errorsOf(index(item({ version }))).join(), version).toContain("items.0.version");
    }
  });

  it("accepts only an https address with no user name", () => {
    for (const url of [
      "http://example.com/a.json",
      "ftp://example.com/a.json",
      "file:///etc/passwd",
      "//example.com/a.json",
      "https://",
      "https://user:pass@example.com/a.json",
      "https://example.com/a b.json",
      "javascript:alert(1)",
      "",
      `https://example.com/${"x".repeat(GALLERY_LIMITS.urlChars)}`,
    ]) {
      expect(errorsOf(index(item({ url }))).join(), url).toContain("items.0.url");
    }
    expect(parseGalleryIndex(index(item({ url: "https://example.com:8443/a.json?x=1" }))).ok).toBe(
      true,
    );
  });

  it("refuses a sha256 that is not 64 lower case hexadecimal digits", () => {
    for (const sha256 of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      `${"a".repeat(63)} `,
      12,
    ]) {
      expect(errorsOf(index(item({ sha256 }))).join(), String(sha256)).toContain("items.0.sha256");
    }
  });

  it("limits the size of an item", () => {
    for (const size of [0, -1, 1.5, GALLERY_LIMITS.itemBytes + 1, "1200", Number.NaN]) {
      expect(errorsOf(index(item({ size }))).join(), String(size)).toContain("items.0.size");
    }
    expect(parseGalleryIndex(index(item({ size: GALLERY_LIMITS.itemBytes }))).ok).toBe(true);
    expect(parseGalleryIndex(index(item({ size: 1 }))).ok).toBe(true);
  });

  it("refuses an id listed twice, even with another kind, and says which one", () => {
    const errors = errorsOf(index(item(), item({ id: "other" }), item({ kind: "mod" })));
    expect(errors).toEqual(['items.2.id: id "lagoon" is listed twice']);
  });

  it("refuses an index with too many items", () => {
    const items = Array.from({ length: GALLERY_LIMITS.items + 1 }, (_, n) =>
      item({ id: `item-${n}` }),
    );
    expect(errorsOf(index(...items)).join()).toContain("at most");
  });
});

describe("compareGalleryVersions", () => {
  it("orders the numbers, not the text", () => {
    expect(compareGalleryVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareGalleryVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareGalleryVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareGalleryVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("puts a pre-release before the plain version and ignores build metadata", () => {
    expect(compareGalleryVersions("1.0.0-beta", "1.0.0")).toBeLessThan(0);
    expect(compareGalleryVersions("1.0.0", "1.0.0-beta")).toBeGreaterThan(0);
    expect(compareGalleryVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareGalleryVersions("1.0.0+build5", "1.0.0")).toBe(0);
  });
});

describe("compareWithInstalled", () => {
  const parsed = parseGalleryIndex(
    index(
      item({ id: "lagoon", version: "1.2.0" }),
      item({ id: "ember", version: "1.0.0" }),
      item({ id: "dusk", version: "1.0.0" }),
      item({ id: "compact-tabs", kind: "mod", version: "2.0.0" }),
    ),
  );
  if (!parsed.ok) throw new Error("fixture index is invalid");
  const gallery: GalleryIndex = parsed.index;

  const installed = (
    id: string,
    version: string,
    kind: InstalledGalleryItem["kind"] = "theme",
  ): InstalledGalleryItem => ({ id, kind, version, sha256: HASH });

  it("tells new, updatable and up to date, in the order of the index", () => {
    const entries = compareWithInstalled(gallery, [
      installed("lagoon", "1.1.0"),
      installed("ember", "1.0.0"),
    ]);
    expect(entries.map((entry) => [entry.item.id, entry.status, entry.installedVersion])).toEqual([
      ["lagoon", "update", "1.1.0"],
      ["ember", "current", "1.0.0"],
      ["dusk", "new", undefined],
      ["compact-tabs", "new", undefined],
    ]);
  });

  it("calls an installed version that is newer than the index's up to date", () => {
    const entries = compareWithInstalled(gallery, [installed("lagoon", "3.0.0")]);
    expect(entries[0]).toMatchObject({ status: "current", installedVersion: "3.0.0" });
  });

  it("matches the kind too: a theme with the id of a mod does not count as the mod", () => {
    const entries = compareWithInstalled(gallery, [installed("compact-tabs", "2.0.0", "theme")]);
    expect(entries[3]?.status).toBe("new");
    const mod = compareWithInstalled(gallery, [installed("compact-tabs", "1.0.0", "mod")]);
    expect(mod[3]?.status).toBe("update");
  });

  it("lists nothing for an item that is installed and not in the index", () => {
    const entries = compareWithInstalled(gallery, [installed("gone", "1.0.0")]);
    expect(entries).toHaveLength(4);
    expect(entries.every((entry) => entry.status === "new")).toBe(true);
  });

  it("with nothing installed every item is new, and an empty index has no entries", () => {
    expect(compareWithInstalled(gallery, []).every((entry) => entry.status === "new")).toBe(true);
    expect(compareWithInstalled({ version: 1, items: [] }, [installed("a", "1.0.0")])).toEqual([]);
  });
});
