import { describe, expect, it } from "vitest";
import { createDefaultWorkspace } from "./default-workspace";
import {
  createBrowserPane,
  createDiffPane,
  createPreviewPane,
  DEFAULT_PROFILE_ID,
} from "./factories";
import { FakeBackend } from "./fake-backend";
import { createSequentialIds } from "./ids";
import { checkInvariants } from "./invariants";
import { reduce } from "./reducer";
import { restoreWorkspace } from "./restore";
import { layoutPanes, liveSessionIds } from "./sessions";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked, testContext } from "./test-helpers";
import { DEFAULT_MAX_PANES } from "./types";
import type { Item, LayoutNode, Pane, Workspace } from "./types";

const FOLDER = "/home/me/project";

/** The first item of the first space. */
function firstItem(ws: Workspace): Item {
  const item = Object.values(ws.spaces[0]?.items ?? {})[0];
  if (!item) throw new Error("the workspace has no item");
  return item;
}

/** The default workspace with its only tab made a split of one terminal pane and a diff pane. */
function withDiffPane(): { ws: Workspace; diffId: string; terminalId: string } {
  const base = createDefaultWorkspace({ newId: createSequentialIds("d") });
  const space = base.spaces[0];
  const item = firstItem(base);
  const first = layoutPanes(item.layout)[0];
  if (!space || !first) throw new Error("the default workspace has no pane");
  const diff = createDiffPane("df", FOLDER);
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
        { kind: "pane", pane: diff },
      ],
    },
    focusedPaneId: "pt",
  };
  const ws: Workspace = {
    ...base,
    spaces: [{ ...space, items: { ...space.items, [item.id]: next } }, ...base.spaces.slice(1)],
  };
  return { ws, diffId: diff.id, terminalId: terminal.id };
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

/** The pane without its folder. */
function withoutCwd(pane: Pane): Pane {
  const next: Pane = { ...pane };
  delete next.cwd;
  return next;
}

describe("createDiffPane", () => {
  it("makes a pane with a folder, no session and the default profile", () => {
    expect(createDiffPane("p1", FOLDER)).toEqual({
      id: "p1",
      type: "diff",
      profileId: DEFAULT_PROFILE_ID,
      cwd: FOLDER,
      status: "idle",
      unread: false,
      bell: false,
    });
  });
});

describe("invariants of a diff pane", () => {
  it("accepts a workspace with a diff pane", () => {
    expect(checkInvariants(withDiffPane().ws)).toEqual([]);
  });

  it.each([["C:\\Users\\me\\repo"], ["c:/work/repo"], ["/a b/c d"], ["/"]])(
    "accepts a diff pane whose folder is %s",
    (cwd) => {
      const { ws, diffId } = withDiffPane();
      expect(checkInvariants(replacePane(ws, diffId, (pane) => ({ ...pane, cwd })))).toEqual([]);
    },
  );

  it.each([
    ["repo"],
    ["./repo"],
    ["~/repo"],
    ["C:repo"],
    ["\\\\server\\share\\repo"],
    ["//server/share/repo"],
    [""],
    ["/a\u0000b"],
  ])("refuses a diff pane whose folder is %j", (cwd) => {
    const { ws, diffId } = withDiffPane();
    const bad = replacePane(ws, diffId, (pane) => ({ ...pane, cwd }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["diff-cwd-invalid"]);
  });

  it("refuses a diff pane with no folder", () => {
    const { ws, diffId } = withDiffPane();
    const bad = replacePane(ws, diffId, withoutCwd);
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["diff-cwd-invalid"]);
  });

  it("refuses a diff pane that holds a session", () => {
    const { ws, diffId } = withDiffPane();
    const bad = replacePane(ws, diffId, (pane) => ({ ...pane, sessionId: "x9" }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["diff-has-session"]);
  });

  it("refuses a diff pane that has an address", () => {
    const { ws, diffId } = withDiffPane();
    const bad = replacePane(ws, diffId, (pane) => ({ ...pane, url: "https://example.com/" }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["diff-has-url"]);
  });

  it("refuses a diff pane that has a file path", () => {
    const { ws, diffId } = withDiffPane();
    const bad = replacePane(ws, diffId, (pane) => ({ ...pane, path: "/home/me/a.md" }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["pane-has-path"]);
  });

  it("does not change what the other kinds of pane are held to", () => {
    const { ws, diffId } = withDiffPane();
    // A preview and a browser pane are still the panes they were: a path or an address, no folder needed.
    const preview = replacePane(ws, diffId, () => createPreviewPane(diffId, "/home/me/a.md"));
    expect(checkInvariants(preview)).toEqual([]);
    const browser = replacePane(ws, diffId, () =>
      createBrowserPane(diffId, "https://example.com/"),
    );
    expect(checkInvariants(browser)).toEqual([]);
  });
});

describe("persistence of a diff pane", () => {
  it("saves and reads it back as it was", () => {
    const { ws, diffId } = withDiffPane();
    const parsed = parseState(serializeWorkspace(ws));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(paneOf(parsed.workspace, diffId)).toEqual(createDiffPane(diffId, FOLDER));
    expect(checkInvariants(parsed.workspace)).toEqual([]);
  });

  it("writes the type and the folder in state.json", () => {
    const { ws } = withDiffPane();
    const text = serializeWorkspace(ws);
    expect(text).toContain('"type":"diff"');
    expect(text).toContain(`"cwd":"${FOLDER}"`);
  });

  it("refuses a file whose diff pane has a folder it may not run git in", () => {
    const { ws, diffId } = withDiffPane();
    for (const cwd of ["repo", "\\\\server\\share\\repo"]) {
      const text = serializeWorkspace(replacePane(ws, diffId, (pane) => ({ ...pane, cwd })));
      const parsed = parseState(text);
      expect(parsed.ok, cwd).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain("diff-cwd-invalid");
    }
  });

  it("refuses a pane of a type it does not know, and says which are known", () => {
    const { ws, diffId } = withDiffPane();
    const text = serializeWorkspace(
      replacePane(ws, diffId, (pane) => ({ ...pane, type: "agent" as unknown as Pane["type"] })),
    );
    const parsed = parseState(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('"terminal", "browser", "preview" or "diff"');
  });

  it("keeps the folder of a diff pane in a closed tab", () => {
    const { ws } = withDiffPane();
    const closed = applyChecked(ws, { type: "item/close", itemId: firstItem(ws).id });
    const parsed = parseState(serializeWorkspace(closed));
    if (!parsed.ok) throw new Error(parsed.reason);
    const saved = parsed.workspace.closed.at(-1);
    const panes = saved ? layoutPanes(saved.item.layout) : [];
    expect(panes.find((p) => p.type === "diff")?.cwd).toBe(FOLDER);
  });
});

describe("restoring a diff pane", () => {
  const profiles = [{ id: "default", name: "Default", default: true }];

  it("starts no shell for it, reads no diff and keeps it as saved", async () => {
    const { ws, diffId, terminalId } = withDiffPane();
    const backend = new FakeBackend({ profiles, state: serializeWorkspace(ws) });
    const result = await restoreWorkspace(backend);

    expect(result.source).toBe("saved");
    // One shell, for the terminal pane; nothing was asked for the diff pane.
    expect(backend.callsTo("createSession")).toHaveLength(1);
    expect(backend.callsTo("reattachSession").map((call) => call.args)).toEqual([[terminalId]]);
    expect(result.failedPaneIds).toEqual([]);
    expect(result.savedCommands).toEqual([]);
    expect(paneOf(result.workspace, diffId)).toEqual(createDiffPane(diffId, FOLDER));
    expect(paneOf(result.workspace, terminalId).sessionId).toBeDefined();
    expect(liveSessionIds(result.workspace).size).toBe(1);
    expect(checkInvariants(result.workspace)).toEqual([]);
    // Restoring runs no git: the pane asks for its own diff when it is shown.
    expect(backend.callsTo("readGitDiff")).toEqual([]);
  });

  it("starts the default workspace when the folder of a diff pane is refused", async () => {
    const { ws, diffId } = withDiffPane();
    const bad = replacePane(ws, diffId, (pane) => ({ ...pane, cwd: "repo" }));
    const backend = new FakeBackend({ profiles, state: serializeWorkspace(bad) });
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("recovered");
    expect(result.reason).toContain("diff-cwd-invalid");
    expect(backend.quarantineCount).toBe(1);
  });

  it("starts a tab made only of a diff pane with no shell at all", async () => {
    const base = createDefaultWorkspace({ newId: createSequentialIds("d") });
    const space = base.spaces[0];
    const item = firstItem(base);
    if (!space) throw new Error("no space");
    const only: Item = {
      ...item,
      layout: { kind: "pane", pane: createDiffPane("df", FOLDER) },
      focusedPaneId: "df",
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

describe("the reducer with a diff pane", () => {
  const split = (ws: Workspace, paneId: string, extra: Record<string, unknown>) => {
    const { ctx } = testContext();
    return reduce(
      ws,
      {
        type: "pane/split",
        itemId: firstItem(ws).id,
        paneId,
        dir: "row",
        side: "after",
        ...extra,
      } as Parameters<typeof reduce>[1],
      ctx,
    );
  };

  /** The default workspace and its only terminal pane, in the folder `cwd` when given. */
  function onlyTerminal(cwd?: string): { ws: Workspace; paneId: string } {
    const base = createDefaultWorkspace({ newId: createSequentialIds("d") });
    const only = layoutPanes(firstItem(base).layout)[0];
    if (!only) throw new Error("no pane");
    const ws = cwd === undefined ? base : replacePane(base, only.id, (pane) => ({ ...pane, cwd }));
    return { ws, paneId: only.id };
  }

  it("splits a diff pane beside a terminal in the folder it is given", () => {
    const { ws, paneId } = onlyTerminal();
    const next = split(ws, paneId, { diff: true, cwd: FOLDER });
    const panes = layoutPanes(firstItem(next).layout);
    expect(panes).toHaveLength(2);
    expect(panes[0]?.id).toBe(paneId);
    expect(panes[1]).toMatchObject({
      type: "diff",
      cwd: FOLDER,
      profileId: DEFAULT_PROFILE_ID,
      status: "idle",
    });
    expect(panes[1]?.sessionId).toBeUndefined();
    expect(panes[1]?.path).toBeUndefined();
    // The new pane takes focus in the model, as any split does; the shell gives it back.
    expect(firstItem(next).focusedPaneId).toBe(panes[1]?.id);
    expect(checkInvariants(next)).toEqual([]);
  });

  it("takes the folder of the pane it is split from when it is given none", () => {
    const { ws, paneId } = onlyTerminal(FOLDER);
    const next = split(ws, paneId, { diff: true });
    expect(layoutPanes(firstItem(next).layout)[1]).toMatchObject({ type: "diff", cwd: FOLDER });
  });

  it("does not open a diff with no folder to run git in", () => {
    const { ws, paneId } = onlyTerminal();
    expect(split(ws, paneId, { diff: true })).toBe(ws);
    expect(split(ws, paneId, { diff: true, cwd: "   " })).toBe(ws);
  });

  it.each([
    ["a relative folder", "repo"],
    ["a folder with ~", "~/repo"],
    ["a folder on the network", "\\\\server\\share\\repo"],
    ["a folder with a control character", "/home/me/a\u0000b"],
  ])("does not open a diff for %s", (_what, cwd) => {
    const { ws, paneId } = onlyTerminal();
    expect(split(ws, paneId, { diff: true, cwd })).toBe(ws);
  });

  it("does not open a pane that is a diff and a page or a file at once", () => {
    const { ws, paneId } = onlyTerminal(FOLDER);
    expect(split(ws, paneId, { diff: true, url: "https://example.org/" })).toBe(ws);
    expect(split(ws, paneId, { diff: true, path: "/home/me/a.md" })).toBe(ws);
  });

  it("leaves the folder of a terminal split alone when diff is not set", () => {
    const { ws, paneId } = onlyTerminal();
    const plain = split(ws, paneId, { cwd: FOLDER });
    expect(layoutPanes(firstItem(plain).layout)[1]).toMatchObject({
      type: "terminal",
      cwd: FOLDER,
    });
    const off = split(ws, paneId, { cwd: FOLDER, diff: false });
    expect(layoutPanes(firstItem(off).layout)[1]).toMatchObject({ type: "terminal", cwd: FOLDER });
  });

  it("does not open past the limit of panes of a tab", () => {
    const { ctx } = testContext();
    const start = onlyTerminal(FOLDER);
    const { paneId } = start;
    let ws = start.ws;
    for (let i = 0; i < DEFAULT_MAX_PANES - 1; i++) ws = split(ws, paneId, { diff: true });
    expect(layoutPanes(firstItem(ws).layout)).toHaveLength(DEFAULT_MAX_PANES);
    expect(
      reduce(
        ws,
        {
          type: "pane/split",
          itemId: firstItem(ws).id,
          paneId,
          dir: "row",
          side: "after",
          diff: true,
        },
        ctx,
      ),
    ).toBe(ws);
  });

  it("splits a terminal from a diff pane in the folder of the diff, with the default profile", () => {
    const { ws, diffId } = withDiffPane();
    const next = applyChecked(ws, {
      type: "pane/split",
      itemId: firstItem(ws).id,
      paneId: diffId,
      dir: "column",
      side: "after",
    });
    const added = layoutPanes(firstItem(next).layout).filter(
      (p) => p.type === "terminal" && p.id !== "pt",
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ profileId: DEFAULT_PROFILE_ID, cwd: FOLDER });
    expect(added[0]?.sessionId).toBeUndefined();
  });

  it("does not point a diff pane at a page", () => {
    const { ws, diffId } = withDiffPane();
    const { ctx } = testContext();
    const next = reduce(
      ws,
      {
        type: "pane/set-url",
        itemId: firstItem(ws).id,
        paneId: diffId,
        url: "https://example.org/",
      },
      ctx,
    );
    expect(next).toBe(ws);
  });

  it("closes, zooms, swaps and detaches a diff pane like any other pane", () => {
    const { ws, diffId, terminalId } = withDiffPane();
    const itemId = firstItem(ws).id;
    const zoomed = applyChecked(ws, { type: "pane/zoom", itemId, paneId: diffId });
    expect(firstItem(zoomed).zoomedPaneId).toBe(diffId);
    const swapped = applyChecked(ws, {
      type: "pane/swap",
      itemId,
      paneId: diffId,
      otherPaneId: terminalId,
    });
    expect(layoutPanes(firstItem(swapped).layout).map((p) => p.id)).toEqual([diffId, terminalId]);
    const detached = applyChecked(ws, { type: "pane/detach", itemId, paneId: diffId });
    const tabs = Object.values(detached.spaces[0]?.items ?? {});
    expect(tabs).toHaveLength(2);
    const lone = tabs.find((item) => item.focusedPaneId === diffId);
    expect(lone && layoutPanes(lone.layout)).toEqual([createDiffPane(diffId, FOLDER)]);
    const closed = applyChecked(ws, { type: "pane/close", itemId, paneId: diffId });
    expect(layoutPanes(firstItem(closed).layout).map((p) => p.id)).toEqual([terminalId]);
  });
});
