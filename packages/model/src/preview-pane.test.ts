import { describe, expect, it } from "vitest";
import { createDefaultWorkspace } from "./default-workspace";
import { createBrowserPane, createPreviewPane, DEFAULT_PROFILE_ID } from "./factories";
import { FakeBackend } from "./fake-backend";
import { createSequentialIds } from "./ids";
import { checkInvariants } from "./invariants";
import { reduce } from "./reducer";
import { restoreWorkspace } from "./restore";
import { layoutPanes, liveSessionIds } from "./sessions";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked, testContext } from "./test-helpers";
import type { Item, LayoutNode, Pane, Workspace } from "./types";

const PATH = "/home/me/notes.md";

/** The first item of the first space. */
function firstItem(ws: Workspace): Item {
  const item = Object.values(ws.spaces[0]?.items ?? {})[0];
  if (!item) throw new Error("the workspace has no item");
  return item;
}

/** The default workspace with its only tab made a split of one terminal pane and a preview pane. */
function withPreviewPane(): { ws: Workspace; previewId: string; terminalId: string } {
  const base = createDefaultWorkspace({ newId: createSequentialIds("d") });
  const space = base.spaces[0];
  const item = firstItem(base);
  const first = layoutPanes(item.layout)[0];
  if (!space || !first) throw new Error("the default workspace has no pane");
  const preview = createPreviewPane("pv", PATH);
  const terminal: Pane = { ...first, id: "pt" };
  delete terminal.sessionId;
  const next: Item = {
    ...item,
    layout: {
      kind: "split",
      dir: "row",
      sizes: [50, 50],
      children: [
        { kind: "pane", pane: terminal },
        { kind: "pane", pane: preview },
      ],
    },
    focusedPaneId: "pt",
  };
  const ws: Workspace = {
    ...base,
    spaces: [{ ...space, items: { ...space.items, [item.id]: next } }, ...base.spaces.slice(1)],
  };
  return { ws, previewId: preview.id, terminalId: terminal.id };
}

const allPanes = (ws: Workspace): Pane[] =>
  ws.spaces.flatMap((space) =>
    Object.values(space.items).flatMap((item) => layoutPanes(item.layout)),
  );

const paneOf = (ws: Workspace, id: string): Pane => {
  const found = allPanes(ws).find((pane) => pane.id === id);
  if (!found) throw new Error(`no pane ${id}`);
  return found;
};

function replacePane(ws: Workspace, paneId: string, change: (pane: Pane) => Pane): Workspace {
  const layout = (node: LayoutNode): LayoutNode =>
    node.kind === "split"
      ? { ...node, children: node.children.map(layout) }
      : node.pane.id === paneId
        ? { kind: "pane", pane: change(node.pane) }
        : node;
  return {
    ...ws,
    spaces: ws.spaces.map((space) => ({
      ...space,
      items: Object.fromEntries(
        Object.entries(space.items).map(([id, item]) => [
          id,
          { ...item, layout: layout(item.layout) },
        ]),
      ),
    })),
  };
}

/** The pane without its path. */
function withoutPath(pane: Pane): Pane {
  const next: Pane = { ...pane };
  delete next.path;
  return next;
}

describe("createPreviewPane", () => {
  it("makes a pane with a path, no session and the default profile", () => {
    expect(createPreviewPane("p1", PATH)).toEqual({
      id: "p1",
      type: "preview",
      profileId: DEFAULT_PROFILE_ID,
      path: PATH,
      status: "idle",
      unread: false,
      bell: false,
    });
  });
});

describe("invariants of a preview pane", () => {
  it("accepts a workspace with preview panes", () => {
    expect(checkInvariants(withPreviewPane().ws)).toEqual([]);
  });

  it.each([["C:\\Users\\me\\a.md"], ["c:/a/b.png"], ["/a b/c d.txt"], ["/"]])(
    "accepts a preview pane whose path is %s",
    (path) => {
      const { ws, previewId } = withPreviewPane();
      expect(checkInvariants(replacePane(ws, previewId, (pane) => ({ ...pane, path })))).toEqual(
        [],
      );
    },
  );

  it.each([
    ["notes.md"],
    ["./notes.md"],
    ["C:notes.md"],
    ["https://example.com/a.md"],
    ["\\\\server\\share\\a.md"],
    ["//server/share/a.md"],
    [""],
    ["/a\u0000b"],
  ])("refuses a preview pane whose path is %j", (path) => {
    const { ws, previewId } = withPreviewPane();
    const bad = replacePane(ws, previewId, (pane) => ({ ...pane, path }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["preview-path-invalid"]);
  });

  it("refuses a preview pane with no path", () => {
    const { ws, previewId } = withPreviewPane();
    const bad = replacePane(ws, previewId, withoutPath);
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["preview-path-invalid"]);
  });

  it("refuses a preview pane that holds a session", () => {
    const { ws, previewId } = withPreviewPane();
    const bad = replacePane(ws, previewId, (pane) => ({ ...pane, sessionId: "x9" }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["preview-has-session"]);
  });

  it("refuses a preview pane that has an address", () => {
    const { ws, previewId } = withPreviewPane();
    const bad = replacePane(ws, previewId, (pane) => ({ ...pane, url: "https://example.com/" }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["preview-has-url"]);
  });

  it("refuses a terminal pane and a browser pane that have a path", () => {
    const { ws, terminalId } = withPreviewPane();
    const terminal = replacePane(ws, terminalId, (pane) => ({ ...pane, path: PATH }));
    expect(checkInvariants(terminal).map((v) => v.code)).toEqual(["pane-has-path"]);
    const browser = replacePane(ws, "pv", () => ({
      ...createBrowserPane("pv", "https://example.com/"),
      path: PATH,
    }));
    expect(checkInvariants(browser).map((v) => v.code)).toEqual(["pane-has-path"]);
  });

  it("still refuses a terminal pane that has an address, with its own code", () => {
    const { ws, terminalId } = withPreviewPane();
    const bad = replacePane(ws, terminalId, (pane) => ({ ...pane, url: "https://example.com/" }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["terminal-has-url"]);
  });
});

describe("persistence of a preview pane", () => {
  it("saves and reads it back as it was", () => {
    const { ws, previewId } = withPreviewPane();
    const parsed = parseState(serializeWorkspace(ws));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(paneOf(parsed.workspace, previewId)).toEqual(createPreviewPane(previewId, PATH));
    expect(checkInvariants(parsed.workspace)).toEqual([]);
  });

  it("refuses a file whose preview pane has a path it may not read", () => {
    const { ws, previewId } = withPreviewPane();
    for (const path of ["notes.md", "\\\\server\\share\\a.md"]) {
      const text = serializeWorkspace(replacePane(ws, previewId, (pane) => ({ ...pane, path })));
      const parsed = parseState(text);
      expect(parsed.ok, path).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain("preview-path-invalid");
    }
  });

  it("refuses a file whose path is not text", () => {
    const { ws, previewId } = withPreviewPane();
    const text = serializeWorkspace(
      replacePane(ws, previewId, (pane) => ({ ...pane, path: 42 as unknown as string })),
    );
    expect(parseState(text).ok).toBe(false);
  });

  it("keeps the path of a preview pane in a closed tab", () => {
    const { ws } = withPreviewPane();
    const closed = applyChecked(ws, { type: "item/close", itemId: firstItem(ws).id });
    const parsed = parseState(serializeWorkspace(closed));
    if (!parsed.ok) throw new Error(parsed.reason);
    const saved = parsed.workspace.closed.at(-1);
    const panes = saved ? layoutPanes(saved.item.layout) : [];
    expect(panes.find((p) => p.type === "preview")?.path).toBe(PATH);
  });
});

describe("restoring a preview pane", () => {
  const profiles = [{ id: "default", name: "Default", default: true }];

  it("starts no shell for it and keeps it as saved", async () => {
    const { ws, previewId, terminalId } = withPreviewPane();
    const backend = new FakeBackend({ profiles, state: serializeWorkspace(ws) });
    const result = await restoreWorkspace(backend);

    expect(result.source).toBe("saved");
    // One shell, for the terminal pane; nothing was asked for the preview pane.
    expect(backend.callsTo("createSession")).toHaveLength(1);
    expect(backend.callsTo("reattachSession").map((call) => call.args)).toEqual([[terminalId]]);
    expect(result.failedPaneIds).toEqual([]);
    expect(result.reattachedPaneIds).toEqual([]);
    expect(result.savedCommands).toEqual([]);
    expect(paneOf(result.workspace, previewId)).toEqual(createPreviewPane(previewId, PATH));
    expect(paneOf(result.workspace, terminalId).sessionId).toBeDefined();
    expect(liveSessionIds(result.workspace).size).toBe(1);
    expect(checkInvariants(result.workspace)).toEqual([]);
    // Restoring reads no file: the pane reads its own when it is shown.
    expect(backend.callsTo("readFilePreview")).toEqual([]);
  });

  it("starts the default workspace when the path of a preview pane is refused", async () => {
    const { ws, previewId } = withPreviewPane();
    const bad = replacePane(ws, previewId, (pane) => ({ ...pane, path: "notes.md" }));
    const backend = new FakeBackend({ profiles, state: serializeWorkspace(bad) });
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("recovered");
    expect(result.reason).toContain("preview-path-invalid");
    expect(backend.quarantineCount).toBe(1);
  });

  it("starts a tab made only of a preview pane with no shell at all", async () => {
    const base = createDefaultWorkspace({ newId: createSequentialIds("d") });
    const space = base.spaces[0];
    const item = firstItem(base);
    if (!space) throw new Error("no space");
    const only: Item = {
      ...item,
      layout: { kind: "pane", pane: createPreviewPane("pv", PATH) },
      focusedPaneId: "pv",
    };
    const ws: Workspace = {
      ...base,
      spaces: [{ ...space, items: { ...space.items, [item.id]: only } }, ...base.spaces.slice(1)],
    };
    const backend = new FakeBackend({ profiles, state: serializeWorkspace(ws) });
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("saved");
    expect(backend.callsTo("createSession")).toEqual([]);
    expect(liveSessionIds(result.workspace).size).toBe(0);
  });
});

describe("the reducer with a preview pane in the workspace", () => {
  it("splits a terminal from a preview pane with the default profile and no folder", () => {
    const { ws, previewId, terminalId } = withPreviewPane();
    const next = applyChecked(ws, {
      type: "pane/split",
      itemId: firstItem(ws).id,
      paneId: previewId,
      dir: "column",
      side: "after",
    });
    const added = layoutPanes(firstItem(next).layout).filter(
      (p) => p.id !== terminalId && p.id !== previewId,
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "terminal", profileId: DEFAULT_PROFILE_ID });
    expect(added[0]?.path).toBeUndefined();
    expect(added[0]?.cwd).toBeUndefined();
  });

  it("splits a terminal pane into a preview pane beside it when given a path", () => {
    const base = createDefaultWorkspace({ newId: createSequentialIds("d") });
    const item = firstItem(base);
    const only = layoutPanes(item.layout)[0];
    if (!only) throw new Error("no pane");
    const next = applyChecked(base, {
      type: "pane/split",
      itemId: item.id,
      paneId: only.id,
      dir: "row",
      side: "after",
      path: PATH,
    });
    const panes = layoutPanes(firstItem(next).layout);
    expect(panes).toHaveLength(2);
    expect(panes[0]?.id).toBe(only.id);
    expect(panes[1]).toMatchObject({ type: "preview", path: PATH, profileId: DEFAULT_PROFILE_ID });
    expect(panes[1]?.sessionId).toBeUndefined();
    expect(panes[1]?.cwd).toBeUndefined();
    // The new pane takes focus in the model, as any split does; the shell gives it back.
    expect(firstItem(next).focusedPaneId).toBe(panes[1]?.id);
  });

  it.each([
    ["a relative path", "notes.md"],
    ["an empty path", ""],
    ["a path on the network", "\\\\server\\share\\a.md"],
    ["a path with a control character", "/home/me/a\u0000.md"],
    ["a path of another kind than text", 7 as unknown as string],
  ])("does not split into a preview pane for %s", (_what, path) => {
    const { ws, terminalId } = withPreviewPane();
    const { ctx } = testContext();
    const next = reduce(
      ws,
      {
        type: "pane/split",
        itemId: firstItem(ws).id,
        paneId: terminalId,
        dir: "row",
        side: "after",
        path,
      },
      ctx,
    );
    expect(next).toBe(ws);
  });

  it("does not split into a pane that is a browser and a preview at once", () => {
    const { ws, terminalId } = withPreviewPane();
    const { ctx } = testContext();
    const next = reduce(
      ws,
      {
        type: "pane/split",
        itemId: firstItem(ws).id,
        paneId: terminalId,
        dir: "row",
        side: "after",
        path: PATH,
        url: "https://example.org/",
      },
      ctx,
    );
    expect(next).toBe(ws);
  });

  it("does not turn a preview pane into a browser pane by pointing it at a page", () => {
    const { ws, previewId } = withPreviewPane();
    const { ctx } = testContext();
    const next = reduce(
      ws,
      {
        type: "pane/set-url",
        itemId: firstItem(ws).id,
        paneId: previewId,
        url: "https://example.org/",
      },
      ctx,
    );
    expect(next).toBe(ws);
  });

  it("closes, zooms, swaps and detaches a preview pane like any other pane", () => {
    const { ws, previewId, terminalId } = withPreviewPane();
    const itemId = firstItem(ws).id;
    const zoomed = applyChecked(ws, { type: "pane/zoom", itemId, paneId: previewId });
    expect(firstItem(zoomed).zoomedPaneId).toBe(previewId);
    const swapped = applyChecked(ws, {
      type: "pane/swap",
      itemId,
      paneId: previewId,
      otherPaneId: terminalId,
    });
    expect(layoutPanes(firstItem(swapped).layout).map((p) => p.id)).toEqual([
      previewId,
      terminalId,
    ]);
    const detached = applyChecked(ws, { type: "pane/detach", itemId, paneId: previewId });
    const tabs = Object.values(detached.spaces[0]?.items ?? {});
    expect(tabs).toHaveLength(2);
    const lone = tabs.find((item) => item.focusedPaneId === previewId);
    expect(lone && layoutPanes(lone.layout)).toEqual([createPreviewPane(previewId, PATH)]);
    const closed = applyChecked(ws, { type: "pane/close", itemId, paneId: previewId });
    expect(layoutPanes(firstItem(closed).layout).map((p) => p.id)).toEqual([terminalId]);
  });
});
