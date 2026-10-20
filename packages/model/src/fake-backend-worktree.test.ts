import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";

function backend(): FakeBackend {
  const fake = new FakeBackend();
  fake.setGitRepo("/work/repo", { branch: "main", detached: false });
  return fake;
}

describe("worktrees of the fake backend", () => {
  it("lists the main worktree of the repository a folder is in", async () => {
    const list = await backend().listWorktrees("/work/repo/src");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: "/work/repo", branch: "main", main: true });
  });

  it("rejects outside a repository and for a path that is not absolute", async () => {
    await expect(backend().listWorktrees("/tmp")).rejects.toThrow("not inside a git repository");
    await expect(backend().listWorktrees("repo")).rejects.toThrow("not inside a git repository");
  });

  it("creates a worktree next to the repository, on its branch, and lists it", async () => {
    const fake = backend();
    const created = await fake.createWorktree("/work/repo", "feature/login");
    expect(created).toMatchObject({
      path: "/work/repo-feature-login",
      branch: "feature/login",
      main: false,
    });
    expect((await fake.listWorktrees("/work/repo")).map((w) => w.path)).toEqual([
      "/work/repo",
      "/work/repo-feature-login",
    ]);
    // The new folder is a repository of its own on that branch, and lists the same worktrees.
    expect(await fake.gitInfo("/work/repo-feature-login")).toEqual({
      branch: "feature/login",
      detached: false,
    });
    expect((await fake.listWorktrees("/work/repo-feature-login")).map((w) => w.path)).toEqual([
      "/work/repo",
      "/work/repo-feature-login",
    ]);
    // A worktree made from inside another one still lands next to the main repository.
    const second = await fake.createWorktree("/work/repo-feature-login", "two");
    expect(second.path).toBe("/work/repo-two");
  });

  it("refuses an empty or dashed branch, one git would not accept, and one checked out elsewhere", async () => {
    const fake = backend();
    await expect(fake.createWorktree("/work/repo", "")).rejects.toThrow("empty");
    await expect(fake.createWorktree("/work/repo", "-x")).rejects.toThrow("cannot start with '-'");
    await expect(fake.createWorktree("/work/repo", "a b")).rejects.toThrow("not a valid branch");
    await expect(fake.createWorktree("/work/repo", "main")).rejects.toThrow("already used");
    expect(await fake.listWorktrees("/work/repo")).toHaveLength(1);
  });

  it("refuses a folder that exists", async () => {
    const fake = backend();
    await fake.createWorktree("/work/repo", "a/b");
    await expect(fake.createWorktree("/work/repo", "a-b")).rejects.toThrow("already exists");
  });

  it("removes a linked worktree and never the main one or a stranger", async () => {
    const fake = backend();
    const created = await fake.createWorktree("/work/repo", "topic");
    await expect(fake.removeWorktree("/work/repo", "/work/repo")).rejects.toThrow("main worktree");
    await expect(fake.removeWorktree("/work/repo", "/work/other")).rejects.toThrow(
      "not a worktree",
    );
    await fake.removeWorktree("/work/repo", created.path);
    expect(await fake.listWorktrees("/work/repo")).toHaveLength(1);
    expect(await fake.gitInfo("/work/repo-topic")).toBeNull();
  });

  it("refuses to remove a worktree marked as having changes, until it is clean", async () => {
    const fake = backend();
    const created = await fake.createWorktree("/work/repo", "dirty");
    fake.setWorktreeDirty(created.path, true);
    await expect(fake.removeWorktree("/work/repo", created.path)).rejects.toThrow(
      "modified or untracked",
    );
    expect(await fake.listWorktrees("/work/repo")).toHaveLength(2);
    fake.setWorktreeDirty(created.path, false);
    await fake.removeWorktree("/work/repo", created.path);
    expect(await fake.listWorktrees("/work/repo")).toHaveLength(1);
  });

  it("records the calls", async () => {
    const fake = backend();
    await fake.createWorktree("/work/repo", "x");
    expect(fake.callsTo("createWorktree")).toHaveLength(1);
  });
});
