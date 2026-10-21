import { describe, expect, it } from "vitest";
import { FAKE_GALLERY_INDEX, FAKE_GALLERY_LAGOON, NOREN_DUSK } from "@noren/model";
import type { GalleryIndex, InstalledGalleryItem } from "@noren/model";
import { galleryRows, installedThemeProblem } from "./settings-gallery";

const record = (
  id: string,
  kind: "theme" | "mod",
  version: string,
  sha256 = "a".repeat(64),
): InstalledGalleryItem => ({ id, kind, version, sha256 });

describe("galleryRows", () => {
  it("offers Install for what is not installed, in the order of the index", () => {
    const rows = galleryRows(FAKE_GALLERY_INDEX, []);
    expect(rows.map((row) => row.id)).toEqual(FAKE_GALLERY_INDEX.items.map((item) => item.id));
    expect(rows.every((row) => row.status === "new" && row.action === "install")).toBe(true);
    expect(rows[0]).toEqual({
      id: "lagoon",
      kind: "theme",
      name: "Lagoon",
      indexVersion: "1.1.0",
      status: "new",
      action: "install",
    });
  });

  it("offers Update, with both versions, for an installed item the index has a newer version of", () => {
    const rows = galleryRows(FAKE_GALLERY_INDEX, [record("lagoon", "theme", "1.0.0")]);
    expect(rows[0]).toMatchObject({
      id: "lagoon",
      status: "update",
      action: "update",
      indexVersion: "1.1.0",
      installedVersion: "1.0.0",
    });
  });

  it("offers nothing for an item that is up to date, or installed in a newer version", () => {
    const rows = galleryRows(FAKE_GALLERY_INDEX, [
      record("lagoon", "theme", "1.1.0"),
      record("ember", "theme", "2.0.0"),
    ]);
    expect(rows[0]).toMatchObject({ status: "current", installedVersion: "1.1.0" });
    expect(rows[1]).toMatchObject({ status: "current", installedVersion: "2.0.0" });
    expect(rows[0]).not.toHaveProperty("action");
    expect(rows[1]).not.toHaveProperty("action");
    expect(rows[2]).toMatchObject({ status: "new", action: "install" });
  });

  it("matches by kind as well as by id", () => {
    const rows = galleryRows(FAKE_GALLERY_INDEX, [record("compact-tabs", "theme", "9.0.0")]);
    expect(rows.find((row) => row.id === "compact-tabs")).toMatchObject({
      kind: "mod",
      status: "new",
      action: "install",
    });
  });

  it("is empty for an index with no items", () => {
    const empty: GalleryIndex = { version: 1, items: [] };
    expect(galleryRows(empty, [record("lagoon", "theme", "1.0.0")])).toEqual([]);
  });
});

describe("installedThemeProblem", () => {
  it("finds nothing wrong with a valid theme", () => {
    expect(installedThemeProblem([FAKE_GALLERY_LAGOON], "lagoon")).toBeUndefined();
  });

  it("looks only at the file with the id asked for", () => {
    const other = JSON.stringify({ id: "other", name: "Broken" });
    expect(installedThemeProblem([other, FAKE_GALLERY_LAGOON], "lagoon")).toBeUndefined();
  });

  it("says where a theme that is JSON but not a theme breaks the schema", () => {
    const broken = JSON.stringify({ ...NOREN_DUSK, id: "lagoon", terminal: { ansi: ["#000"] } });
    expect(installedThemeProblem([broken], "lagoon")).toMatch(/terminal/);
  });

  it("says when the file is valid but takes the id of a built-in theme", () => {
    const text = JSON.stringify({ ...NOREN_DUSK });
    expect(installedThemeProblem([text], NOREN_DUSK.id)).toMatch(/another theme already has/);
  });

  it("says when no file has the id", () => {
    expect(installedThemeProblem([], "lagoon")).toMatch(/no theme with this id/);
    expect(installedThemeProblem(["not json"], "lagoon")).toMatch(/no theme with this id/);
  });

  it("reads a file that starts with a byte order mark", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(installedThemeProblem([bom + FAKE_GALLERY_LAGOON], "lagoon")).toBeUndefined();
  });
});
