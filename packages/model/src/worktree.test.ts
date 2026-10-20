import { describe, expect, it } from "vitest";
import { branchProblem, worktreeDestination, worktreeFolderName } from "./worktree";

describe("branchProblem", () => {
  it("refuses a blank name, a leading dash and a control character", () => {
    expect(branchProblem("")).toBe("empty");
    expect(branchProblem("   ")).toBe("empty");
    expect(branchProblem("-x")).toBe("dash");
    expect(branchProblem("--detach")).toBe("dash");
    expect(branchProblem("a\nb")).toBe("control");
    expect(branchProblem("a\u0000b")).toBe("control");
  });

  it("leaves a plain name to git", () => {
    expect(branchProblem("feature/login")).toBeUndefined();
    expect(branchProblem("fix-1")).toBeUndefined();
    expect(branchProblem("a b")).toBeUndefined();
  });
});

describe("worktreeFolderName", () => {
  it("joins the repository and the branch with a dash and turns separators into dashes", () => {
    expect(worktreeFolderName("noren", "main")).toBe("noren-main");
    expect(worktreeFolderName("noren", "feature/login")).toBe("noren-feature-login");
    expect(worktreeFolderName("r", "a/b/c")).toBe("r-a-b-c");
    expect(worktreeFolderName("r", 'a:b|c"d')).toBe("r-a-b-c-d");
  });
});

describe("worktreeDestination", () => {
  it("is next to the repository, in its separator", () => {
    expect(worktreeDestination("/work/noren", "fix/x")).toBe("/work/noren-fix-x");
    expect(worktreeDestination("D:\\work\\noren", "fix/x")).toBe("D:\\work\\noren-fix-x");
    expect(worktreeDestination("D:/work/noren/", "x")).toBe("D:/work/noren-x");
    expect(worktreeDestination("/repo", "x")).toBe("/repo-x");
  });

  it("has no place for a root or a bare name", () => {
    expect(worktreeDestination("/", "x")).toBeUndefined();
    expect(worktreeDestination("noren", "x")).toBeUndefined();
    expect(worktreeDestination("", "x")).toBeUndefined();
  });
});
