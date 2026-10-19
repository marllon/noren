import { describe, expect, it } from "vitest";
import { FakeBackend, createDefaultWorkspace, createSequentialIds } from "@noren/model";
import type { Pane, Workspace } from "@noren/model";
import { layoutPanes } from "@noren/model";
import {
  loadScrollbackForRestore,
  restoredScrollbackOf,
  setRestoredScrollback,
} from "./scrollback-restore";

// What the app reads of the saved scrollback when it opens, and what it leaves out.

const ESC = "\x1b";
const NOW = new Date(2026, 9, 19, 14, 5).getTime();

/** A workspace with the given panes in its first space, each a tab of its own. */
function workspaceWith(
  panes: { id: string; ref?: string }[],
  spaceSaves = true,
): { workspace: Workspace; itemOf: (paneId: string) => string } {
  const base = createDefaultWorkspace({
    newId: createSequentialIds("n"),
    clock: { now: () => 0 },
  });
  const space = base.spaces[0];
  if (!space) throw new Error("no space");
  const items: Workspace["spaces"][number]["items"] = {};
  const itemIds = new Map<string, string>();
  for (const { id, ref } of panes) {
    const pane: Pane = {
      id,
      type: "terminal",
      profileId: "default",
      status: "idle",
      unread: false,
      bell: false,
      ...(ref !== undefined ? { scrollbackRef: ref } : {}),
    };
    const itemId = `item-${id}`;
    itemIds.set(id, itemId);
    items[itemId] = {
      id: itemId,
      titleLocked: false,
      layout: { kind: "pane", pane },
      focusedPaneId: id,
      lastActivityAt: 0,
    };
  }
  const workspace: Workspace = {
    ...base,
    spaces: [
      {
        ...space,
        saveScrollback: spaceSaves,
        pinned: [],
        tree: Object.keys(items).map((id) => ({ kind: "item" as const, id })),
        items,
        activeItemId: Object.keys(items)[0] as string,
      },
    ],
  };
  // The panes really are in it.
  expect(
    workspace.spaces.flatMap((s) => Object.values(s.items)).flatMap((i) => layoutPanes(i.layout)),
  ).toHaveLength(panes.length);
  return { workspace, itemOf: (paneId) => itemIds.get(paneId) ?? "" };
}

describe("loadScrollbackForRestore", () => {
  it("reads the snapshot of a pane that records one and makes the text that shows it again", async () => {
    const backend = new FakeBackend({ scrollback: { "pane-1": "old one\nold two" } });
    const { workspace } = workspaceWith([{ id: "pane-1", ref: "pane-1.txt" }]);
    const restore = await loadScrollbackForRestore(backend, workspace, { enabled: true, now: NOW });
    expect(restore.stale).toEqual([]);
    expect([...restore.texts.keys()]).toEqual(["pane-1"]);
    const text = restore.texts.get("pane-1") ?? "";
    expect(text).toContain("old one\r\nold two");
    expect(text).toContain("session restored 2026-10-19 14:05");
    expect(text.startsWith(`${ESC}[0m${ESC}[2m`)).toBe(true);
    expect(backend.callsTo("loadScrollback").map((c) => c.args[0])).toEqual(["pane-1"]);
  });

  it("does not look for a snapshot of a pane that records none", async () => {
    const backend = new FakeBackend({ scrollback: { "pane-1": "left over" } });
    const { workspace } = workspaceWith([{ id: "pane-1" }]);
    const restore = await loadScrollbackForRestore(backend, workspace, { enabled: true, now: NOW });
    expect(restore.texts.size).toBe(0);
    expect(restore.stale).toEqual([]);
    expect(backend.callsTo("loadScrollback")).toEqual([]);
  });

  it("reads each pane's own snapshot", async () => {
    const backend = new FakeBackend({ scrollback: { a: "text of a", b: "text of b" } });
    const { workspace } = workspaceWith([
      { id: "a", ref: "a.txt" },
      { id: "b", ref: "b.txt" },
      { id: "c" },
    ]);
    const restore = await loadScrollbackForRestore(backend, workspace, { enabled: true, now: NOW });
    expect((restore.texts.get("a") ?? "").includes("text of a")).toBe(true);
    expect((restore.texts.get("b") ?? "").includes("text of b")).toBe(true);
    expect(restore.texts.has("c")).toBe(false);
  });

  it("shows nothing and removes the file when the space says never, without reading it", async () => {
    const backend = new FakeBackend({ scrollback: { "pane-1": "must not come back" } });
    const { workspace, itemOf } = workspaceWith([{ id: "pane-1", ref: "pane-1.txt" }], false);
    const restore = await loadScrollbackForRestore(backend, workspace, { enabled: true, now: NOW });
    expect(restore.texts.size).toBe(0);
    expect(restore.stale).toEqual([{ paneId: "pane-1", itemId: itemOf("pane-1"), remove: true }]);
    expect(backend.callsTo("loadScrollback")).toEqual([]);
  });

  it("shows nothing and removes the file when the setting of the app says never", async () => {
    const backend = new FakeBackend({ scrollback: { "pane-1": "must not come back" } });
    const { workspace, itemOf } = workspaceWith([{ id: "pane-1", ref: "pane-1.txt" }]);
    const restore = await loadScrollbackForRestore(backend, workspace, {
      enabled: false,
      now: NOW,
    });
    expect(restore.texts.size).toBe(0);
    expect(restore.stale).toEqual([{ paneId: "pane-1", itemId: itemOf("pane-1"), remove: true }]);
    expect(backend.callsTo("loadScrollback")).toEqual([]);
  });

  it("a note whose file is gone is stale and there is nothing to remove", async () => {
    const backend = new FakeBackend();
    const { workspace, itemOf } = workspaceWith([{ id: "pane-1", ref: "pane-1.txt" }]);
    const restore = await loadScrollbackForRestore(backend, workspace, { enabled: true, now: NOW });
    expect(restore.texts.size).toBe(0);
    expect(restore.stale).toEqual([{ paneId: "pane-1", itemId: itemOf("pane-1"), remove: false }]);
  });

  it("a file with nothing to show is stale and goes", async () => {
    const backend = new FakeBackend({
      scrollback: { a: "", b: "\r\n  \r\n", c: `${ESC}]52;c;SGVsbG8=\x07` },
    });
    const { workspace } = workspaceWith([
      { id: "a", ref: "a.txt" },
      { id: "b", ref: "b.txt" },
      { id: "c", ref: "c.txt" },
    ]);
    const restore = await loadScrollbackForRestore(backend, workspace, { enabled: true, now: NOW });
    expect(restore.texts.size).toBe(0);
    expect(restore.stale.map((s) => [s.paneId, s.remove])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
  });

  it("leaves a file it cannot read alone: the pane opens without it and keeps its note", async () => {
    const backend = new FakeBackend({ scrollback: { "pane-1": "ok" } });
    backend.loadScrollback = () => Promise.reject(new Error("could not read"));
    const { workspace } = workspaceWith([{ id: "pane-1", ref: "pane-1.txt" }]);
    const restore = await loadScrollbackForRestore(backend, workspace, { enabled: true, now: NOW });
    expect(restore.texts.size).toBe(0);
    expect(restore.stale).toEqual([]);
  });

  it("only text and colors reach the terminal, whatever the file held", async () => {
    const hostile = `visible${ESC}]52;c;SGVsbG8=\x07 text${ESC}[6n${ESC}[?1049h\u009b6n\x05 end`;
    const backend = new FakeBackend({ scrollback: { "pane-1": hostile } });
    const { workspace } = workspaceWith([{ id: "pane-1", ref: "pane-1.txt" }]);
    const restore = await loadScrollbackForRestore(backend, workspace, { enabled: true, now: NOW });
    const text = restore.texts.get("pane-1") ?? "";
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^(?:[^\x00-\x1f\x7f-\x9f]|\t|\r\n|\x1b\[[0-9;:]*m)*$/);
    expect(text).toContain("visible text");
    expect(text).not.toContain("SGVsbG8");
  });

  it("a workspace with no note asks for nothing", async () => {
    const backend = new FakeBackend();
    const restore = await loadScrollbackForRestore(backend, createDefaultWorkspace(), {
      enabled: true,
      now: NOW,
    });
    expect(restore.texts.size).toBe(0);
    expect(restore.stale).toEqual([]);
    expect(backend.calls).toEqual([]);
  });
});

describe("the text kept for the terminals", () => {
  it("hands each terminal the text of its own pane, and nothing to a pane that has none", () => {
    setRestoredScrollback(new Map([["pane-1", "text of pane 1"]]));
    expect(restoredScrollbackOf("pane-1")).toBe("text of pane 1");
    expect(restoredScrollbackOf("pane-2")).toBeUndefined();
    // Asking again gives the same: a terminal that mounts twice (the dev build does) shows it twice.
    expect(restoredScrollbackOf("pane-1")).toBe("text of pane 1");
  });

  it("replaces what was kept", () => {
    setRestoredScrollback(new Map([["pane-1", "one"]]));
    setRestoredScrollback(new Map([["pane-2", "two"]]));
    expect(restoredScrollbackOf("pane-1")).toBeUndefined();
    expect(restoredScrollbackOf("pane-2")).toBe("two");
    setRestoredScrollback(new Map());
    expect(restoredScrollbackOf("pane-2")).toBeUndefined();
  });
});
