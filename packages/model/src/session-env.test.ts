import { describe, expect, it } from "vitest";
import { spaceSessionEnv } from "./session-env";
import type { Space } from "./types";

const spaceWith = (defaults: Partial<Space["defaults"]>): Space =>
  ({ defaults: { profileId: "default", env: {}, ...defaults } }) as unknown as Space;

describe("spaceSessionEnv", () => {
  it("is the variables of the space when there is no git identity", () => {
    expect(spaceSessionEnv(spaceWith({ env: { A: "1" } }))).toEqual({ A: "1" });
  });

  it("adds the git identity as author and committer", () => {
    const space = spaceWith({ gitIdentity: { name: "Ada", email: "ada@example.com" } });
    expect(spaceSessionEnv(space)).toEqual({
      GIT_AUTHOR_NAME: "Ada",
      GIT_COMMITTER_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_EMAIL: "ada@example.com",
    });
  });

  it("leaves out a blank name or email", () => {
    const space = spaceWith({ gitIdentity: { name: "", email: "ada@example.com" } });
    expect(Object.keys(spaceSessionEnv(space)).sort()).toEqual([
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_EMAIL",
    ]);
  });

  it("lets the variables of the space win, ignoring case", () => {
    const space = spaceWith({
      env: { git_author_name: "Someone" },
      gitIdentity: { name: "Ada", email: "" },
    });
    expect(spaceSessionEnv(space)).toEqual({
      GIT_COMMITTER_NAME: "Ada",
      git_author_name: "Someone",
    });
  });
});
