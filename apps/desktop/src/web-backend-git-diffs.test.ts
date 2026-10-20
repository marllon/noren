import { describe, expect, it } from "vitest";
import { WEB_GIT_DIFFS_KEY, WebBackend, seededGitDiffs } from "./web-backend";
import type { StateStorage } from "./web-backend";

// The git diffs a diff pane can read in web mode: seeded in the browser storage before the page
// loads (as the e2e tests do) or placed with `setGitDiff`, and found again after a reload.

const DIFF = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

function memoryStorage(initial: Record<string, string> = {}): StateStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("WebBackend git diffs for a diff pane", () => {
  it("reads the diffs and refusals of the seed, by the folder of the repository", async () => {
    const storage = memoryStorage({
      [WEB_GIT_DIFFS_KEY]: JSON.stringify({
        "/work/repo": DIFF,
        "/work/broken": { reason: "failed", detail: "fatal: x" },
        "/work/big": { reason: "too-large" },
        "/work/odd": { reason: "because" },
        "/work/worse": 3,
        "/work/null": null,
      }),
    });
    expect(seededGitDiffs(storage)).toEqual({
      "/work/repo": DIFF,
      "/work/broken": { kind: "refused", reason: "failed", detail: "fatal: x" },
      "/work/big": { kind: "refused", reason: "too-large" },
    });
    const backend = new WebBackend(storage);
    expect(await backend.readGitDiff("/work/repo/src")).toEqual({ kind: "diff", text: DIFF });
    expect(await backend.readGitDiff("/work/broken")).toEqual({
      kind: "refused",
      reason: "failed",
      detail: "fatal: x",
    });
    expect(await backend.readGitDiff("/work/big")).toEqual({
      kind: "refused",
      reason: "too-large",
    });
    expect(await backend.readGitDiff("/work/elsewhere")).toEqual({
      kind: "refused",
      reason: "not-a-repository",
    });
  });

  it("has no repository without a seed, and ignores a seed that is not an object", async () => {
    expect(seededGitDiffs(memoryStorage())).toBeUndefined();
    expect(seededGitDiffs(memoryStorage({ [WEB_GIT_DIFFS_KEY]: "[1]" }))).toBeUndefined();
    expect(seededGitDiffs(memoryStorage({ [WEB_GIT_DIFFS_KEY]: "{not json" }))).toBeUndefined();
    expect(await new WebBackend(memoryStorage()).readGitDiff("/work/repo")).toEqual({
      kind: "refused",
      reason: "not-a-repository",
    });
  });

  it("keeps a diff placed with setGitDiff in the storage, so a reload finds it", async () => {
    const storage = memoryStorage();
    const first = new WebBackend(storage);
    first.setGitDiff("/work/repo", DIFF);
    first.setGitDiff("/work/other", { kind: "refused", reason: "git-missing" });
    const second = new WebBackend(storage);
    expect(await second.readGitDiff("/work/repo")).toEqual({ kind: "diff", text: DIFF });
    expect(await second.readGitDiff("/work/other")).toEqual({
      kind: "refused",
      reason: "git-missing",
    });
    second.setGitDiff("/work/repo", null);
    const third = new WebBackend(storage);
    expect(await third.readGitDiff("/work/repo")).toEqual({
      kind: "refused",
      reason: "not-a-repository",
    });
    expect(await third.readGitDiff("/work/other")).toEqual({
      kind: "refused",
      reason: "git-missing",
    });
  });
});
