import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";
import { parseGitDiff } from "./git-diff";

const REPO = "/work/repo";
const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("FakeBackend.readGitDiff", () => {
  it("answers the diff a repository was given, and records the question", async () => {
    const backend = new FakeBackend({ gitDiffs: { [REPO]: DIFF } });
    expect(await backend.readGitDiff(REPO)).toEqual({ kind: "diff", text: DIFF });
    expect(backend.callsTo("readGitDiff").map((call) => call.args)).toEqual([[REPO]]);
    expect(parseGitDiff(DIFF).map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("answers the same diff for a folder inside the repository", async () => {
    const backend = new FakeBackend({ gitDiffs: { [REPO]: DIFF } });
    expect(await backend.readGitDiff(`${REPO}/src/deep`)).toEqual({ kind: "diff", text: DIFF });
    expect(await backend.readGitDiff(`${REPO}/`)).toEqual({ kind: "diff", text: DIFF });
  });

  it("compares folders the way the system does: a Windows path ignores case and separators", async () => {
    const backend = new FakeBackend({ gitDiffs: { "C:\\Work\\Repo": DIFF } });
    expect(await backend.readGitDiff("c:/work/repo/src")).toEqual({ kind: "diff", text: DIFF });
    expect(await backend.readGitDiff("/work/repo")).toEqual({
      kind: "refused",
      reason: "not-a-repository",
    });
  });

  it("answers a refusal it was given, with its detail", async () => {
    const backend = new FakeBackend({
      gitDiffs: { [REPO]: { kind: "refused", reason: "failed", detail: "fatal: bad object" } },
    });
    expect(await backend.readGitDiff(REPO)).toEqual({
      kind: "refused",
      reason: "failed",
      detail: "fatal: bad object",
    });
  });

  it("answers no changes for a fake repository that has no diff, and refuses a folder in none", async () => {
    const backend = new FakeBackend();
    backend.setGitRepo(REPO, { branch: "main", detached: false });
    expect(await backend.readGitDiff(`${REPO}/sub`)).toEqual({ kind: "diff", text: "" });
    expect(await backend.readGitDiff("/elsewhere")).toEqual({
      kind: "refused",
      reason: "not-a-repository",
    });
  });

  it.each([
    ["repo", "relative"],
    ["./repo", "relative"],
    ["C:repo", "relative"],
    ["\\\\server\\share\\repo", "network"],
    ["//server/share/repo", "network"],
    ["", "invalid"],
    ["/work/a\u0000b", "invalid"],
  ])("refuses the folder %j as %s before looking anywhere", async (cwd, reason) => {
    const backend = new FakeBackend({ gitDiffs: { [REPO]: DIFF } });
    expect(await backend.readGitDiff(cwd)).toEqual({ kind: "refused", reason });
  });

  it("changes its answer with setGitDiff, and takes the entry away with null", async () => {
    const backend = new FakeBackend({ gitDiffs: { [REPO]: DIFF } });
    backend.setGitDiff(REPO, "");
    // The hook is not a Backend call, so it is not recorded.
    expect(backend.calls).toEqual([]);
    expect(await backend.readGitDiff(REPO)).toEqual({ kind: "diff", text: "" });
    backend.setGitDiff(REPO, { kind: "refused", reason: "too-large" });
    expect(await backend.readGitDiff(REPO)).toEqual({ kind: "refused", reason: "too-large" });
    backend.setGitDiff(REPO, null);
    expect(await backend.readGitDiff(REPO)).toEqual({
      kind: "refused",
      reason: "not-a-repository",
    });
  });

  it("does not answer for the git information of a folder that only has a diff", async () => {
    const backend = new FakeBackend({ gitDiffs: { [REPO]: DIFF } });
    expect(await backend.gitInfo(REPO)).toBeNull();
  });
});
