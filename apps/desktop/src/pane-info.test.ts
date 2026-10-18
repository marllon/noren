import type { Item, LayoutNode, Pane } from "@noren/model";
import { describe, expect, it } from "vitest";
import { failureLabel, indicatorLabels, shortCwd, summarizeItem } from "./pane-info";

describe("shortCwd", () => {
  it("turns the home folder into ~ and keeps what follows it", () => {
    expect(shortCwd("/home/ada", "/home/ada")).toBe("~");
    expect(shortCwd("/home/ada/", "/home/ada")).toBe("~");
    expect(shortCwd("/home/ada/proj", "/home/ada")).toBe("~/proj");
    expect(shortCwd("/home/ada/proj/noren", "/home/ada")).toBe("~/proj/noren");
  });

  it("keeps the last two segments behind an ellipsis when the path is longer", () => {
    expect(shortCwd("/home/ada/work/proj/noren", "/home/ada")).toBe("\u2026/proj/noren");
    expect(shortCwd("/usr/local/share/doc")).toBe("\u2026/share/doc");
    expect(shortCwd("/a/b/c", undefined, 3)).toBe("/a/b/c");
    expect(shortCwd("/a/b/c/d", undefined, 3)).toBe("\u2026/b/c/d");
  });

  it("leaves short absolute paths whole", () => {
    expect(shortCwd("/")).toBe("/");
    expect(shortCwd("/tmp")).toBe("/tmp");
    expect(shortCwd("/usr/bin")).toBe("/usr/bin");
  });

  it("does not take a sibling of the home folder for the home folder", () => {
    expect(shortCwd("/home/ada2", "/home/ada")).toBe("/home/ada2");
    expect(shortCwd("/home/ad", "/home/ada")).toBe("/home/ad");
  });

  it("reads a Windows path with backslashes and keeps the separator", () => {
    expect(shortCwd("C:\\Users\\ada", "C:\\Users\\ada")).toBe("~");
    expect(shortCwd("C:\\Users\\ada\\dev\\noren", "C:\\Users\\ada")).toBe("~\\dev\\noren");
    expect(shortCwd("C:\\Users\\ada\\dev\\noren\\apps", "C:\\Users\\ada")).toBe(
      "\u2026\\noren\\apps",
    );
    expect(shortCwd("D:\\Projects\\noren\\apps")).toBe("\u2026\\noren\\apps");
    expect(shortCwd("D:\\Projects\\noren")).toBe("D:\\Projects\\noren");
    expect(shortCwd("C:\\")).toBe("C:\\");
    expect(shortCwd("C:\\Windows")).toBe("C:\\Windows");
  });

  it("compares a Windows path with home ignoring case and slash direction", () => {
    expect(shortCwd("c:\\users\\ADA\\dev", "C:\\Users\\ada")).toBe("~\\dev");
    expect(shortCwd("C:/Users/ada/dev", "C:\\Users\\ada\\")).toBe("~/dev");
    expect(shortCwd("C:/Users/ada2", "C:\\Users\\ada")).toBe("C:/Users/ada2");
  });

  it("reads a UNC path", () => {
    expect(shortCwd("\\\\server\\share\\team\\app")).toBe("\u2026\\team\\app");
  });

  it("keeps a path that already starts with ~", () => {
    expect(shortCwd("~")).toBe("~");
    expect(shortCwd("~/proj")).toBe("~/proj");
    expect(shortCwd("~/a/b/c")).toBe("\u2026/b/c");
  });

  it("is case sensitive on POSIX and needs a home to shorten", () => {
    expect(shortCwd("/Home/ada", "/home/ada")).toBe("/Home/ada");
    expect(shortCwd("/home/ada")).toBe("/home/ada");
    expect(shortCwd("/home/ada", "")).toBe("/home/ada");
  });

  it("gives an empty string for a blank path", () => {
    expect(shortCwd("")).toBe("");
    expect(shortCwd("   ")).toBe("");
  });
});

const pane = (id: string, extra: Partial<Pane> = {}): Pane => ({
  id,
  type: "terminal",
  profileId: "bash",
  status: "idle",
  unread: false,
  bell: false,
  ...extra,
});

const item = (layout: LayoutNode, focusedPaneId: string): Item => ({
  id: "i1",
  titleLocked: false,
  layout,
  focusedPaneId,
  lastActivityAt: 0,
});

const leaf = (p: Pane): LayoutNode => ({ kind: "pane", pane: p });

describe("summarizeItem", () => {
  it("has nothing to show for a plain idle pane without a folder", () => {
    expect(summarizeItem(item(leaf(pane("p1")), "p1"))).toEqual({
      running: false,
      unread: false,
      bell: false,
    });
  });

  it("takes the folder and the branch of the pane, and the default folder of the space otherwise", () => {
    const withCwd = item(leaf(pane("p1", { cwd: "/work", gitBranch: "main" })), "p1");
    expect(summarizeItem(withCwd, "/space")).toMatchObject({ cwd: "/work", gitBranch: "main" });
    const without = item(leaf(pane("p1")), "p1");
    expect(summarizeItem(without, "/space")).toMatchObject({ cwd: "/space" });
    expect(summarizeItem(without, "  ")).not.toHaveProperty("cwd");
    expect(summarizeItem(item(leaf(pane("p1", { gitBranch: "" })), "p1"))).not.toHaveProperty(
      "gitBranch",
    );
  });

  it("flags running, unread and bell", () => {
    const summary = summarizeItem(
      item(leaf(pane("p1", { status: "running", unread: true, bell: true })), "p1"),
    );
    expect(summary).toMatchObject({ running: true, unread: true, bell: true });
    expect(summary).not.toHaveProperty("failed");
  });

  it("flags an exit with a code other than 0, or without a code, but not a clean exit", () => {
    const exited = (exitCode?: number) =>
      summarizeItem(
        item(
          leaf(pane("p1", { status: "exited", ...(exitCode !== undefined ? { exitCode } : {}) })),
          "p1",
        ),
      );
    expect(exited(2).failed).toBe(2);
    expect(exited(130).failed).toBe(130);
    expect(exited().failed).toBeNull();
    expect(exited(0)).not.toHaveProperty("failed");
  });

  it("reads the focused pane for the folder and every pane for the flags", () => {
    const split: LayoutNode = {
      kind: "split",
      dir: "row",
      sizes: [50, 50],
      children: [
        leaf(pane("p1", { cwd: "/one", gitBranch: "one" })),
        leaf(
          pane("p2", { cwd: "/two", gitBranch: "two", status: "exited", exitCode: 3, bell: true }),
        ),
      ],
    };
    expect(summarizeItem(item(split, "p1"))).toMatchObject({
      cwd: "/one",
      gitBranch: "one",
      failed: 3,
      bell: true,
    });
    expect(summarizeItem(item(split, "p2"))).toMatchObject({ cwd: "/two", gitBranch: "two" });
  });
});

describe("indicatorLabels", () => {
  it("lists what is on, in drawing order", () => {
    const base = { running: false, unread: false, bell: false };
    expect(indicatorLabels(base)).toEqual([]);
    expect(indicatorLabels({ running: true, failed: 2, unread: true, bell: true })).toEqual([
      "Running",
      "Exited with code 2",
      "Unread output",
      "Bell",
    ]);
    expect(indicatorLabels({ ...base, failed: 0 })).toEqual(["Exited with code 0"]);
  });
});

describe("failureLabel", () => {
  it("names the code", () => {
    expect(failureLabel(2)).toBe("Exited with code 2");
    expect(failureLabel(null)).toBe("Exited with an error");
  });
});
