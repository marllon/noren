import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  UPDATE_LIMITS,
  compareVersions,
  isNewerVersion,
  isVersion,
  parseUpdateCheck,
  parseUpdateProgress,
  parseUpdateStatus,
} from "./update";

// The answers of the app about the update (`update_status`, `update_check` and the
// `update-progress` event of src-tauri/src/update.rs, the wire shapes its tests pin down) and the
// order of versions, which the updater plugin of the app decides with.

const info = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: "Fixes\n- one thing",
  publishedAt: 1_792_584_000,
};

describe("the status of the update", () => {
  it("takes the shape the app answers", () => {
    const fresh = { configured: true, currentVersion: "0.1.0", pending: null };
    expect(parseUpdateStatus(fresh)).toEqual({ ok: true, value: fresh });
    const found = { configured: true, currentVersion: "0.1.0", pending: info };
    expect(parseUpdateStatus(found)).toEqual({ ok: true, value: found });
    const unset = { configured: false, currentVersion: "0.1.0", pending: null };
    expect(parseUpdateStatus(unset)).toEqual({ ok: true, value: unset });
  });

  it("refuses an answer of another shape, naming what is wrong", () => {
    const bad = (value: unknown) => {
      const parsed = parseUpdateStatus(value);
      if (parsed.ok) throw new Error(`accepted ${JSON.stringify(value)}`);
      return parsed.error;
    };
    expect(bad(null)).toBeTruthy();
    expect(bad([])).toBeTruthy();
    expect(bad({ currentVersion: "0.1.0", pending: null })).toContain("configured");
    expect(bad({ configured: "yes", currentVersion: "0.1.0", pending: null })).toContain(
      "configured must be true or false",
    );
    expect(bad({ configured: true, currentVersion: "", pending: null })).toContain(
      "currentVersion is empty",
    );
    expect(bad({ configured: true, currentVersion: "0.1.0" })).toBeTruthy();
    expect(
      bad({ configured: true, currentVersion: "0.1.0", pending: null, extra: 1 }),
    ).toBeTruthy();
    expect(
      bad({ configured: true, currentVersion: "0.1.0", pending: { ...info, version: "" } }),
    ).toContain("version is empty");
  });
});

describe("the update a check found", () => {
  it("is an update or null", () => {
    expect(parseUpdateCheck(null)).toEqual({ ok: true, value: null });
    expect(parseUpdateCheck(info)).toEqual({ ok: true, value: info });
    // Notes and date are optional in a release: they come as null.
    const bare = { ...info, notes: null, publishedAt: null };
    expect(parseUpdateCheck(bare)).toEqual({ ok: true, value: bare });
  });

  it("refuses what is not one", () => {
    for (const value of [
      undefined,
      "0.2.0",
      42,
      {},
      { ...info, notes: 5 },
      { ...info, publishedAt: 1.5 },
      { ...info, publishedAt: "yesterday" },
      { ...info, currentVersion: undefined },
      { ...info, extra: true },
    ]) {
      expect(parseUpdateCheck(value).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it("takes notes up to the ceiling of the app (and the ellipsis of a cut) and no more", () => {
    const notes = (chars: number) => ({ ...info, notes: "x".repeat(chars) });
    expect(parseUpdateCheck(notes(UPDATE_LIMITS.notesChars)).ok).toBe(true);
    expect(parseUpdateCheck(notes(UPDATE_LIMITS.notesChars + 1)).ok).toBe(true);
    const tooLong = parseUpdateCheck(notes(UPDATE_LIMITS.notesChars + 2));
    expect(tooLong).toEqual({ ok: false, error: "notes are too long" });
  });
});

describe("the progress of a download", () => {
  it("is whole numbers, with the total when the server announced one", () => {
    expect(parseUpdateProgress({ downloaded: 10, total: 100 })).toEqual({
      ok: true,
      value: { downloaded: 10, total: 100 },
    });
    expect(parseUpdateProgress({ downloaded: 0, total: null }).ok).toBe(true);
    for (const value of [
      null,
      {},
      { downloaded: -1, total: 10 },
      { downloaded: 1.5, total: 10 },
      { downloaded: 1, total: -5 },
      { downloaded: "1", total: 10 },
      { downloaded: 1 },
    ]) {
      expect(parseUpdateProgress(value).ok, JSON.stringify(value)).toBe(false);
    }
  });
});

describe("the order of versions", () => {
  // The same table as `a_prerelease_of_a_later_version_is_newer_and_one_of_this_version_is_not` in
  // src-tauri/src/update/tests.rs, which runs it through the updater plugin: against 0.1.0.
  it("calls newer what the updater of the app calls newer", () => {
    const table: [string, boolean][] = [
      ["0.2.0-beta.1", true],
      ["0.1.1", true],
      ["1.0.0", true],
      ["0.1.0", false],
      ["0.1.0-rc.1", false],
      ["0.0.9", false],
      ["0.1.0+build.5", false],
    ];
    for (const [announced, newer] of table) {
      expect(isNewerVersion(announced, "0.1.0"), `${announced} against 0.1.0`).toBe(newer);
    }
  });

  it("follows the examples of the semver specification (item 11), in this order", () => {
    const ascending = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "2.0.0",
      "2.1.0",
      "2.1.1",
    ];
    for (const [i, earlier] of ascending.entries()) {
      for (const [j, later] of ascending.entries()) {
        const expected = i === j ? 0 : i < j ? -1 : 1;
        expect(compareVersions(earlier, later), `${earlier} / ${later}`).toBe(expected);
      }
    }
  });

  it("compares numbers as numbers, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0-beta.11", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("10.0.0", "9.99.99")).toBe(1);
  });

  it("leaves out the build metadata and the v of a tag", () => {
    expect(compareVersions("1.2.3+a", "1.2.3+b")).toBe(0);
    expect(compareVersions("1.2.3+5", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.4", "1.2.3")).toBe(1);
  });

  it("does not place what is not a version", () => {
    for (const text of [
      "",
      "1",
      "1.2",
      "1.2.3.4",
      "01.2.3",
      "1.02.3",
      "1.2.3-",
      "1.2.3-01",
      "1.2.3-a..b",
      "1.2.3+",
      "soon",
      "latest",
      " 1.2.3",
      "1.2.3 ",
      "99999999999999999999.0.0",
    ]) {
      expect(isVersion(text), JSON.stringify(text)).toBe(false);
      expect(compareVersions(text, "1.0.0"), JSON.stringify(text)).toBeUndefined();
      expect(isNewerVersion(text, "0.0.1"), JSON.stringify(text)).toBe(false);
      expect(isNewerVersion("9.9.9", text), JSON.stringify(text)).toBe(false);
    }
    for (const text of ["0.0.0", "1.2.3", "v1.2.3", "1.2.3-rc.1+b.5", "1.0.0-x-y-z.--"]) {
      expect(isVersion(text), text).toBe(true);
    }
  });

  const part = fc.integer({ min: 0, max: 30 });
  const identifier = fc.oneof(
    fc.integer({ min: 0, max: 20 }).map(String),
    fc.constantFrom("alpha", "beta", "rc", "x-1"),
  );
  const version = fc
    .tuple(part, part, part, fc.array(identifier, { maxLength: 3 }))
    .map(([major, minor, patch, pre]) => {
      const tag = pre.length === 0 ? "" : `-${pre.join(".")}`;
      return `${major}.${minor}.${patch}${tag}`;
    });

  it("is an order: the same with itself, opposite when reversed, and transitive", () => {
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(compareVersions(a, a)).toBe(0);
        const order = (x: string, y: string): number => {
          const result = compareVersions(x, y);
          if (result === undefined) throw new Error(`${x} / ${y} could not be placed`);
          return result;
        };
        const ab = order(a, b);
        const ba = order(b, a);
        expect(ab).toBe(ba === 0 ? 0 : -ba);
        const bc = order(b, c);
        const ac = order(a, c);
        if (ab <= 0 && bc <= 0) expect(ac).toBeLessThanOrEqual(0);
        if (ab >= 0 && bc >= 0) expect(ac).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
