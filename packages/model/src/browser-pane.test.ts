import { describe, expect, it } from "vitest";
import { createDefaultWorkspace } from "./default-workspace";
import { createBrowserPane, DEFAULT_PROFILE_ID } from "./factories";
import { FakeBackend } from "./fake-backend";
import { createSequentialIds } from "./ids";
import { checkInvariants } from "./invariants";
import { reduce } from "./reducer";
import { restoreWorkspace } from "./restore";
import { layoutPanes, liveSessionIds } from "./sessions";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked, testContext } from "./test-helpers";
import type { Item, LayoutNode, Pane, Workspace } from "./types";

const URL = "https://example.com/docs?page=2#top";

/** The first item of the first space. */
function firstItem(ws: Workspace): Item {
  const item = Object.values(ws.spaces[0]?.items ?? {})[0];
  if (!item) throw new Error("the workspace has no item");
  return item;
}

/** The default workspace with its only tab made a split of one terminal pane and a browser pane. */
function withBrowserPane(): { ws: Workspace; browserId: string; terminalId: string } {
  const base = createDefaultWorkspace({ newId: createSequentialIds("d") });
  const space = base.spaces[0];
  const item = firstItem(base);
  const first = layoutPanes(item.layout)[0];
  if (!space || !first) throw new Error("the default workspace has no pane");
  const browser = createBrowserPane("pb", URL);
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
        { kind: "pane", pane: browser },
      ],
    },
    focusedPaneId: "pt",
  };
  const ws: Workspace = {
    ...base,
    spaces: [{ ...space, items: { ...space.items, [item.id]: next } }, ...base.spaces.slice(1)],
  };
  return { ws, browserId: browser.id, terminalId: terminal.id };
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

/** The pane without its address. */
function withoutUrl(pane: Pane): Pane {
  const next: Pane = { ...pane };
  delete next.url;
  return next;
}

describe("createBrowserPane", () => {
  it("makes a pane with an address, no session and the default profile", () => {
    expect(createBrowserPane("p1", URL)).toEqual({
      id: "p1",
      type: "browser",
      profileId: DEFAULT_PROFILE_ID,
      url: URL,
      status: "idle",
      unread: false,
      bell: false,
    });
  });
});

describe("invariants of a browser pane", () => {
  it("accepts a workspace with browser panes", () => {
    expect(checkInvariants(withBrowserPane().ws)).toEqual([]);
  });

  it.each([
    ["file:///C:/Windows/win.ini"],
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["noren://open"],
    ["http://tauri.localhost/"],
    [""],
  ])("refuses a browser pane whose address is %s", (url) => {
    const { ws, browserId } = withBrowserPane();
    const bad = replacePane(ws, browserId, (pane) => ({ ...pane, url }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["browser-url-invalid"]);
  });

  it("refuses a browser pane with no address", () => {
    const { ws, browserId } = withBrowserPane();
    const bad = replacePane(ws, browserId, withoutUrl);
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["browser-url-invalid"]);
  });

  it("refuses a browser pane that holds a session", () => {
    const { ws, browserId } = withBrowserPane();
    const bad = replacePane(ws, browserId, (pane) => ({ ...pane, sessionId: "x9" }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["browser-has-session"]);
  });

  it("refuses a terminal pane that has an address", () => {
    const { ws, terminalId } = withBrowserPane();
    const bad = replacePane(ws, terminalId, (pane) => ({ ...pane, url: URL }));
    expect(checkInvariants(bad).map((v) => v.code)).toEqual(["terminal-has-url"]);
  });
});

describe("persistence of a browser pane", () => {
  it("saves and reads it back as it was", () => {
    const { ws, browserId } = withBrowserPane();
    const parsed = parseState(serializeWorkspace(ws));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(paneOf(parsed.workspace, browserId)).toEqual(createBrowserPane(browserId, URL));
    expect(checkInvariants(parsed.workspace)).toEqual([]);
  });

  it("refuses a file whose browser pane has an address the pane may not show", () => {
    const { ws, browserId } = withBrowserPane();
    const text = serializeWorkspace(
      replacePane(ws, browserId, (pane) => ({ ...pane, url: "file:///C:/Windows/win.ini" })),
    );
    const parsed = parseState(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("browser-url-invalid");
  });

  it("refuses a file whose pane is of a type the app does not know", () => {
    const { ws, browserId } = withBrowserPane();
    const text = serializeWorkspace(
      replacePane(ws, browserId, (pane) => ({ ...pane, type: "agent" as Pane["type"] })),
    );
    const parsed = parseState(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('"terminal", "browser" or "preview"');
  });

  it("refuses a file whose address is not text", () => {
    const { ws, browserId } = withBrowserPane();
    const text = serializeWorkspace(
      replacePane(ws, browserId, (pane) => ({ ...pane, url: 42 as unknown as string })),
    );
    expect(parseState(text).ok).toBe(false);
  });

  it("reads a file saved before panes had a type other than terminal", () => {
    const { ws } = withBrowserPane();
    const terminalsOnly = replacePane(ws, "pb", (pane) => ({ ...pane, type: "terminal" }));
    const text = serializeWorkspace(replacePane(terminalsOnly, "pb", withoutUrl));
    const parsed = parseState(text);
    expect(parsed.ok).toBe(true);
  });

  it("keeps the address of a browser pane in a closed tab", () => {
    const { ws } = withBrowserPane();
    const closed = applyChecked(ws, { type: "item/close", itemId: firstItem(ws).id });
    const entry = closed.closed.at(-1);
    if (!entry) throw new Error("the tab did not go to the closed stack");
    const parsed = parseState(serializeWorkspace(closed));
    if (!parsed.ok) throw new Error(parsed.reason);
    const saved = parsed.workspace.closed.at(-1);
    const panes = saved ? layoutPanes(saved.item.layout) : [];
    expect(panes.find((p) => p.type === "browser")?.url).toBe(URL);
  });
});

describe("restoring a browser pane", () => {
  const profiles = [{ id: "default", name: "Default", default: true }];

  it("starts no shell for it and keeps it as saved", async () => {
    const { ws, browserId, terminalId } = withBrowserPane();
    const backend = new FakeBackend({ profiles, state: serializeWorkspace(ws) });
    const result = await restoreWorkspace(backend);

    expect(result.source).toBe("saved");
    // One shell, for the terminal pane; nothing was asked for the browser pane.
    expect(backend.callsTo("createSession")).toHaveLength(1);
    expect(backend.callsTo("reattachSession").map((call) => call.args)).toEqual([[terminalId]]);
    expect(result.failedPaneIds).toEqual([]);
    expect(result.reattachedPaneIds).toEqual([]);
    expect(result.savedCommands).toEqual([]);
    expect(paneOf(result.workspace, browserId)).toEqual(createBrowserPane(browserId, URL));
    expect(paneOf(result.workspace, terminalId).sessionId).toBeDefined();
    expect(liveSessionIds(result.workspace).size).toBe(1);
    expect(checkInvariants(result.workspace)).toEqual([]);
  });

  it("starts the default workspace when the address of a browser pane is refused", async () => {
    const { ws, browserId } = withBrowserPane();
    const bad = replacePane(ws, browserId, (pane) => ({ ...pane, url: "javascript:alert(1)" }));
    const backend = new FakeBackend({ profiles, state: serializeWorkspace(bad) });
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("recovered");
    expect(result.reason).toContain("browser-url-invalid");
    expect(backend.quarantineCount).toBe(1);
  });
});

describe("the reducer with a browser pane in the workspace", () => {
  it("splits a terminal from a browser pane with the default profile", () => {
    const { ws, browserId, terminalId } = withBrowserPane();
    const next = applyChecked(ws, {
      type: "pane/split",
      itemId: firstItem(ws).id,
      paneId: browserId,
      dir: "column",
      side: "after",
    });
    const added = layoutPanes(firstItem(next).layout).filter(
      (p) => p.id !== terminalId && p.id !== browserId,
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "terminal", profileId: DEFAULT_PROFILE_ID });
    expect(added[0]?.url).toBeUndefined();
  });

  it("splits a terminal pane into a browser pane beside it when given an address", () => {
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
      url: URL,
    });
    const panes = layoutPanes(firstItem(next).layout);
    expect(panes).toHaveLength(2);
    expect(panes[0]?.id).toBe(only.id);
    expect(panes[1]).toMatchObject({ type: "browser", url: URL, profileId: DEFAULT_PROFILE_ID });
    expect(panes[1]?.sessionId).toBeUndefined();
    expect(panes[1]?.cwd).toBeUndefined();
    // The new pane has the keyboard, as any split does.
    expect(firstItem(next).focusedPaneId).toBe(panes[1]?.id);
  });

  it.each([
    ["file:///C:/Windows/win.ini"],
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["http://tauri.localhost/"],
    [""],
  ])("does not split into a browser pane whose address is %s", (url) => {
    const { ws, terminalId } = withBrowserPane();
    const { ctx } = testContext();
    const next = reduce(
      ws,
      {
        type: "pane/split",
        itemId: firstItem(ws).id,
        paneId: terminalId,
        dir: "row",
        side: "after",
        url,
      },
      ctx,
    );
    expect(next).toBe(ws);
  });

  it("points a browser pane at another page and keeps everything else", () => {
    const { ws, browserId, terminalId } = withBrowserPane();
    const next = applyChecked(ws, {
      type: "pane/set-url",
      itemId: firstItem(ws).id,
      paneId: browserId,
      url: "https://example.org/next",
    });
    expect(paneOf(next, browserId)).toEqual({
      ...paneOf(ws, browserId),
      url: "https://example.org/next",
    });
    expect(paneOf(next, terminalId)).toBe(paneOf(ws, terminalId));
    // The page survives the state file.
    const parsed = parseState(serializeWorkspace(next));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(paneOf(parsed.workspace, browserId).url).toBe("https://example.org/next");
  });

  it.each([
    ["file:///C:/Windows/win.ini"],
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["noren://open"],
    ["http://tauri.localhost/"],
    ["https://good.example@evil.example/"],
    [""],
  ])("keeps the page of a browser pane when told to go to %s", (url) => {
    const { ws, browserId } = withBrowserPane();
    const { ctx } = testContext();
    const next = reduce(
      ws,
      { type: "pane/set-url", itemId: firstItem(ws).id, paneId: browserId, url },
      ctx,
    );
    expect(next).toBe(ws);
  });

  it("changes nothing for the same page, a terminal pane or an unknown pane", () => {
    const { ws, browserId, terminalId } = withBrowserPane();
    const { ctx } = testContext();
    const itemId = firstItem(ws).id;
    const go = (paneId: string, url: string) =>
      reduce(ws, { type: "pane/set-url", itemId, paneId, url }, ctx);
    expect(go(browserId, URL)).toBe(ws);
    expect(go(terminalId, "https://example.org/")).toBe(ws);
    expect(go("nope", "https://example.org/")).toBe(ws);
    expect(
      reduce(ws, { type: "pane/set-url", itemId: "nope", paneId: browserId, url: URL }, ctx),
    ).toBe(ws);
  });

  it("closes a browser pane like any other pane and keeps the terminal", () => {
    const { ws, browserId, terminalId } = withBrowserPane();
    const { ctx } = testContext();
    const next = reduce(
      ws,
      { type: "pane/close", itemId: firstItem(ws).id, paneId: browserId },
      ctx,
    );
    expect(checkInvariants(next)).toEqual([]);
    expect(layoutPanes(firstItem(next).layout).map((p) => p.id)).toEqual([terminalId]);
  });
});
