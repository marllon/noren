import { describe, expect, it } from "vitest";
import { setLanguage } from "./i18n";
import { worktreesGroupName } from "./live-groups-service";

describe("worktreesGroupName", () => {
  it("names the group after the last folder of the repository, of either kind of path", () => {
    expect(worktreesGroupName("/work/repo")).toBe("Worktrees of repo");
    expect(worktreesGroupName("/work/repo/")).toBe("Worktrees of repo");
    expect(worktreesGroupName("C:\\work\\noren")).toBe("Worktrees of noren");
    expect(worktreesGroupName("  /srv/a b  ")).toBe("Worktrees of a b");
  });

  it("falls back to the whole path when no folder name is left, and follows the language", () => {
    expect(worktreesGroupName("/")).toBe("Worktrees of ");
    setLanguage("pt-BR");
    expect(worktreesGroupName("/work/repo")).toBe("Worktrees de repo");
    setLanguage("en");
  });
});
