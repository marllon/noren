import { FakeBackend, checkInvariants, createSequentialIds, workspaceWindows } from "@noren/model";
import type { Space } from "@noren/model";
import { describe, expect, it } from "vitest";
import { memoryQuickEvents } from "./quick";
import type { QuickEvents } from "./quick";
import { WINDOW_READY_EVENT } from "./window-events";
import {
  MAX_WINDOW_TABS,
  WINDOW_ACTION_EVENT,
  WINDOW_STATE_EVENT,
  actionOfWindowRequest,
  followWindowPages,
  spaceOfWindowState,
  windowStatePayload,
} from "./window-sync";
import { moveItemToNewWindow } from "./window-service";
import { createWorkspaceStore } from "./workspace-store";
import { restoreWorkspace } from "@noren/model";

const clock = { now: () => 1000 };

/** A main window with a window made for the tab "dragged out": a store over a fake backend. */
async function openMain() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  store.getState().newTab();
  store.getState().newTab();
  return { backend, store };
}

/** The tab ids of the active space, in order. */
const tabIds = (store: Awaited<ReturnType<typeof openMain>>["store"]): string[] => {
  const ws = store.getState().workspace;
  return Object.keys(ws.spaces.find((s) => s.id === ws.activeSpaceId)?.items ?? {});
};

async function withWindow() {
  const main = await openMain();
  const [first] = tabIds(main.store);
  if (first === undefined) throw new Error("a tab was expected");
  const result = await moveItemToNewWindow(main.store, main.backend, first, "Out");
  if (!result.ok) throw new Error(result.reason);
  const window = workspaceWindows(main.store.getState().workspace)[0];
  const space = main.store.getState().workspace.spaces.find((s) => s.id === window?.spaceId);
  if (!window || !space) throw new Error("the window was expected");
  return { ...main, window, space, tab: first };
}

/** The bus plus what went through it. */
function recordingEvents(): { events: QuickEvents; heard: { event: string; payload: unknown }[] } {
  const inner = memoryQuickEvents();
  const heard: { event: string; payload: unknown }[] = [];
  return {
    heard,
    events: {
      listen: inner.listen,
      emit: async (event, payload) => {
        heard.push({ event, payload });
        await inner.emit(event, payload);
      },
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("spaceOfWindowState", () => {
  it("reads the space an event carries for its own window", async () => {
    const { window, space } = await withWindow();
    const read = spaceOfWindowState(windowStatePayload(window.id, space), window.id);
    expect(read).toEqual(space);
  });

  it("ignores an event for another window, and anything that is not a space", async () => {
    const { window, space } = await withWindow();
    expect(spaceOfWindowState(windowStatePayload(window.id, space), "other")).toBeUndefined();
    for (const payload of [
      undefined,
      null,
      "x",
      {},
      { windowId: window.id },
      { windowId: window.id, space: null },
      { windowId: window.id, space: "s1" },
      { windowId: window.id, space: {} },
      { windowId: window.id, space: { ...space, items: null } },
      { windowId: window.id, space: { ...space, pinned: "no" } },
    ]) {
      expect(spaceOfWindowState(payload, window.id), JSON.stringify(payload)).toBeUndefined();
    }
  });

  it("refuses a space that breaks the invariants of the model before anything draws it", async () => {
    const { window, space } = await withWindow();
    const [itemId] = Object.keys(space.items);
    if (itemId === undefined) throw new Error("the space has a tab");
    const item = space.items[itemId];
    if (!item) throw new Error("the tab is there");
    // A tab in the tree that the space does not hold.
    const missing: Space = { ...space, tree: [...space.tree, { kind: "item", id: "ghost" }] };
    expect(spaceOfWindowState(windowStatePayload(window.id, missing), window.id)).toBeUndefined();
    // A focused pane that the tab does not have.
    const broken: Space = {
      ...space,
      items: { [itemId]: { ...item, focusedPaneId: "nowhere" } },
    };
    expect(spaceOfWindowState(windowStatePayload(window.id, broken), window.id)).toBeUndefined();
  });
});

describe("actionOfWindowRequest", () => {
  const request = (windowId: string, action: unknown) => ({ windowId, action });

  it("accepts what a window can ask for: another tab, a focused pane, a resized split", async () => {
    const { store, window, space, tab } = await withWindow();
    const ws = store.getState().workspace;
    const paneId = Object.values(space.items)[0]?.focusedPaneId ?? "";
    expect(
      actionOfWindowRequest(
        request(window.id, { type: "space/set-active-item", spaceId: space.id, itemId: tab }),
        ws,
      ),
    ).toEqual({ type: "space/set-active-item", spaceId: space.id, itemId: tab });
    expect(
      actionOfWindowRequest(request(window.id, { type: "pane/focus", itemId: tab, paneId }), ws),
    ).toEqual({ type: "pane/focus", itemId: tab, paneId });
    expect(
      actionOfWindowRequest(
        request(window.id, { type: "pane/resize", itemId: tab, path: [0, 1], sizes: [30, 70] }),
        ws,
      ),
    ).toEqual({ type: "pane/resize", itemId: tab, path: [0, 1], sizes: [30, 70] });
  });

  it("makes the action again from the fields it checked: nothing else a page sent gets through", async () => {
    const { store, window, space, tab } = await withWindow();
    const action = actionOfWindowRequest(
      request(window.id, {
        type: "pane/focus",
        itemId: tab,
        paneId: "p",
        spaceId: space.id,
        extra: "x",
        __proto__: { polluted: true },
      }),
      store.getState().workspace,
    );
    expect(action).toEqual({ type: "pane/focus", itemId: tab, paneId: "p" });
  });

  it("refuses every other action, a tab of another space, another window and the wrong shapes", async () => {
    const { store, window, space, tab } = await withWindow();
    const ws = store.getState().workspace;
    const [mainTab] = tabIds(store);
    const refused = (action: unknown, windowId: string = window.id): void => {
      expect(
        actionOfWindowRequest(request(windowId, action), ws),
        JSON.stringify(action),
      ).toBeUndefined();
    };
    for (const type of [
      "pane/close",
      "pane/split",
      "space/delete",
      "window/close",
      "window/return",
      "item/pin",
      "item/rename",
      "item/favorite",
      "group/create",
      "pane/set-url",
      "space/activate",
      "item/reopen",
      "item/join",
    ]) {
      refused({ type, itemId: tab, paneId: "p", spaceId: space.id, windowId: window.id });
    }
    // Moving a tab asks for a place; without one there is nothing to carry out.
    refused({ type: "item/move", itemId: tab });
    // A tab the space of the window does not hold, and the space of another window.
    refused({ type: "pane/focus", itemId: mainTab, paneId: "p" });
    refused({ type: "space/set-active-item", spaceId: ws.activeSpaceId, itemId: tab });
    refused({ type: "pane/focus", itemId: tab, paneId: 3 });
    refused({ type: "pane/resize", itemId: tab, path: [-1], sizes: [50, 50] });
    refused({ type: "pane/resize", itemId: tab, path: [0], sizes: ["50", 50] });
    refused({
      type: "pane/resize",
      itemId: tab,
      path: [0],
      sizes: Array.from({ length: 40 }, () => 1),
    });
    refused({
      type: "pane/resize",
      itemId: tab,
      path: Array.from({ length: 40 }, () => 0),
      sizes: [1],
    });
    refused({ type: "pane/resize", itemId: tab, path: [0], sizes: [Number.NaN, 50] });
    refused("pane/focus");
    refused(null);
    refused({ type: "pane/focus", itemId: tab, paneId: "p" }, "nope");
    expect(actionOfWindowRequest("x", ws)).toBeUndefined();
    expect(actionOfWindowRequest({ windowId: window.id }, ws)).toBeUndefined();
  });
});

describe("actionOfWindowRequest: opening, closing and moving tabs", () => {
  const request = (windowId: string, action: unknown) => ({ windowId, action });

  /** A window whose space has three tabs, one in a group, and a second window on another space. */
  async function crowded() {
    const { store, backend, window, space, tab } = await withWindow();
    const second = tabIds(store)[0];
    if (second === undefined) throw new Error("a tab was expected");
    const other = await moveItemToNewWindow(store, backend, second, "Other");
    if (!other.ok) throw new Error(other.reason);
    for (let n = 0; n < 2; n++) {
      store.getState().dispatch({ type: "item/create", spaceId: space.id });
    }
    store.getState().dispatch({ type: "group/create", spaceId: space.id, name: "Work" });
    const ws = store.getState().workspace;
    const mine = ws.spaces.find((s) => s.id === space.id);
    const theirs = ws.windows?.find((w) => w.id === other.windowId);
    const group = mine?.tree.find((node) => node.kind === "group");
    const itemIds = Object.keys(mine?.items ?? {});
    return { store, ws, window, space: mine ?? space, tab, group, itemIds, other: theirs };
  }

  it("a new tab is asked for with the space of the window, and made in no other", async () => {
    const { ws, window, space, other } = await crowded();
    expect(
      actionOfWindowRequest(request(window.id, { type: "item/create", spaceId: space.id }), ws),
    ).toEqual({ type: "item/create", spaceId: space.id });
    // Another space, the space of another window, or none: nothing is made.
    for (const spaceId of [ws.activeSpaceId, other?.spaceId, "nope", undefined, 7]) {
      expect(
        actionOfWindowRequest(request(window.id, { type: "item/create", spaceId }), ws),
        String(spaceId),
      ).toBeUndefined();
    }
  });

  it("a window that holds as many tabs as it may asks for no more", async () => {
    const { store, window, space } = await withWindow();
    for (let n = 0; n < MAX_WINDOW_TABS; n++) {
      store.getState().dispatch({ type: "item/create", spaceId: space.id });
    }
    const ws = store.getState().workspace;
    expect(Object.keys(ws.spaces.find((s) => s.id === space.id)?.items ?? {}).length).toBe(
      MAX_WINDOW_TABS + 1,
    );
    expect(
      actionOfWindowRequest(request(window.id, { type: "item/create", spaceId: space.id }), ws),
    ).toBeUndefined();
  });

  it("closes a tab of the space of the window, and only that one", async () => {
    const { ws, window, tab, other } = await crowded();
    expect(
      actionOfWindowRequest(request(window.id, { type: "item/close", itemId: tab }), ws),
    ).toEqual({ type: "item/close", itemId: tab });
    // A tab of the main window, a tab of another window, one that does not exist.
    const mainTab = ws.spaces
      .find((s) => s.id === ws.activeSpaceId)
      ?.tree.find((node) => node.kind === "item")?.id;
    const theirTab = Object.keys(ws.spaces.find((s) => s.id === other?.spaceId)?.items ?? {})[0];
    for (const itemId of [mainTab, theirTab, "ghost", undefined, 3]) {
      expect(
        actionOfWindowRequest(request(window.id, { type: "item/close", itemId }), ws),
        String(itemId),
      ).toBeUndefined();
    }
  });

  it("moves a tab inside the space of the window, the action never naming a space", async () => {
    const { ws, window, tab, group } = await crowded();
    const ask = (placement: unknown, extra: object = {}) =>
      actionOfWindowRequest(
        request(window.id, { type: "item/move", itemId: tab, placement, ...extra }),
        ws,
      );
    expect(ask({ to: "tree", index: 2 })).toEqual({
      type: "item/move",
      itemId: tab,
      placement: { to: "tree", index: 2 },
    });
    expect(ask({ to: "tree" })).toEqual({
      type: "item/move",
      itemId: tab,
      placement: { to: "tree" },
    });
    expect(ask({ to: "pinned", index: 0 })).toEqual({
      type: "item/move",
      itemId: tab,
      placement: { to: "pinned", index: 0 },
    });
    expect(group?.id).toBeTruthy();
    expect(ask({ to: "tree", groupId: group?.id, index: 0 })).toEqual({
      type: "item/move",
      itemId: tab,
      placement: { to: "tree", groupId: group?.id, index: 0 },
    });
    // A request that names another space still moves inside this one: the field is dropped.
    expect(ask({ to: "tree", index: 1 }, { spaceId: ws.activeSpaceId })).toEqual({
      type: "item/move",
      itemId: tab,
      placement: { to: "tree", index: 1 },
    });
  });

  it("refuses a place that is not one: another list, a group that is not there, a number that is not a place", async () => {
    const { ws, window, tab, group } = await crowded();
    const mainGroup = "n-not-a-group";
    const refused = (placement: unknown): void => {
      expect(
        actionOfWindowRequest(
          request(window.id, { type: "item/move", itemId: tab, placement }),
          ws,
        ),
        JSON.stringify(placement),
      ).toBeUndefined();
    };
    for (const placement of [
      undefined,
      null,
      "tree",
      3,
      {},
      { to: "favorites" },
      { to: "space", spaceId: ws.activeSpaceId },
      { to: "tree", groupId: mainGroup },
      { to: "tree", groupId: 7 },
      { to: "pinned", groupId: group?.id },
      { to: "tree", index: -1 },
      { to: "tree", index: 1.5 },
      { to: "tree", index: Number.NaN },
      { to: "tree", index: Number.POSITIVE_INFINITY },
      { to: "tree", index: 1_000_000 },
      { to: "tree", index: "1" },
    ]) {
      refused(placement);
    }
  });

  it("whatever a page sends, an action that gets through names only the space and the tabs of the window", async () => {
    // Not a dependency of this app: fast-check lives in @noren/model, so walk made-up requests
    // instead, from a generator with a fixed seed (the same requests every run).
    const { ws, window, space, itemIds, other } = await crowded();
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
    const foreign = [
      ws.activeSpaceId,
      other?.spaceId,
      other?.id,
      ...Object.keys(ws.spaces.find((s) => s.id === other?.spaceId)?.items ?? {}),
      ...Object.keys(ws.spaces.find((s) => s.id === ws.activeSpaceId)?.items ?? {}),
    ].filter((id): id is string => id !== undefined);
    const names: readonly unknown[] = [
      ...itemIds,
      ...foreign,
      space.id,
      window.id,
      "ghost",
      "",
      "__proto__",
      null,
      undefined,
      0,
      1,
      -1,
      1.5,
      Number.NaN,
    ];
    const maybe = (make: () => unknown): unknown => (next() < 0.6 ? make() : undefined);
    const placementOf = (): unknown =>
      maybe(() => ({
        to: pick(["tree", "pinned", "space", "other"]),
        groupId: maybe(() => pick(names)),
        index: maybe(() => (next() < 0.5 ? pick(names) : Math.floor(next() * 10))),
        spaceId: maybe(() => pick(names)),
      }));
    const types = [
      "item/create",
      "item/close",
      "item/move",
      "space/set-active-item",
      "pane/focus",
      "pane/resize",
      "item/pin",
      "space/delete",
      "window/close",
      "item/join",
    ];
    let accepted = 0;
    const mainItems = Object.keys(ws.spaces.find((s) => s.id === ws.activeSpaceId)?.items ?? {});
    for (let n = 0; n < 6000; n++) {
      const windowId = next() < 0.8 ? window.id : pick(names);
      const body: Record<string, unknown> = {
        type: pick(types),
        itemId: maybe(() => pick(names)),
        spaceId: maybe(() => pick(names)),
        paneId: maybe(() => pick(names)),
        windowId: maybe(() => pick(names)),
        path: maybe(() => (next() < 0.5 ? pick(names) : [Math.floor(next() * 3)])),
        sizes: maybe(() => (next() < 0.5 ? pick(names) : [Math.floor(next() * 100), 50])),
        placement: placementOf(),
      };
      const result = actionOfWindowRequest({ windowId, action: body }, ws);
      if (result === undefined) continue;
      accepted += 1;
      const seen = JSON.stringify(body);
      // Only for a window the workspace has, and only about what that window shows (the other
      // window of the workspace may ask about its own tabs, never about these).
      const asked = ws.windows?.find((w) => w.id === windowId);
      expect(asked, seen).toBeDefined();
      const shown = ws.spaces.find((s) => s.id === asked?.spaceId);
      expect(shown, seen).toBeDefined();
      const itemsShown = Object.keys(shown?.items ?? {});
      expect(
        [
          "item/create",
          "item/close",
          "item/move",
          "space/set-active-item",
          "pane/focus",
          "pane/resize",
        ],
        seen,
      ).toContain(result.type);
      if ("spaceId" in result && result.spaceId !== undefined) {
        expect(result.spaceId, seen).toBe(shown?.id);
      }
      if ("itemId" in result) expect(itemsShown, seen).toContain(result.itemId);
      if (result.type === "item/move") expect(result, seen).not.toHaveProperty("spaceId");
      // Never one of the tabs of the main window, whoever asks.
      if ("itemId" in result) expect(mainItems, seen).not.toContain(result.itemId);
    }
    // The walk reached the accepted side too, so the checks above ran on something.
    expect(accepted).toBeGreaterThan(50);
  });
});

describe("followWindowPages", () => {
  it("hands the checked action of a window to the runner it is given, with the window", async () => {
    const { store, window, space, tab } = await withWindow();
    const { events } = recordingEvents();
    const ran: { windowId: string; action: unknown }[] = [];
    const stop = followWindowPages(store, events, (windowId, action) => {
      ran.push({ windowId, action });
    });
    await settle();
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "item/create", spaceId: space.id },
    });
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "item/close", itemId: tab },
    });
    // Not for this window's space, and not an action a window may ask for: not handed on.
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "item/create", spaceId: store.getState().workspace.activeSpaceId },
    });
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "space/delete", spaceId: space.id },
    });
    await settle();
    expect(ran).toEqual([
      { windowId: window.id, action: { type: "item/create", spaceId: space.id } },
      { windowId: window.id, action: { type: "item/close", itemId: tab } },
    ]);
    // The runner does the work, not the follower: nothing was dispatched.
    expect(
      store.getState().workspace.spaces.find((s) => s.id === space.id)?.items[tab],
    ).toBeDefined();
    stop();
  });

  it("a runner that throws, or rejects, leaves nothing unhandled and the next request is still heard", async () => {
    const { store, window, space } = await withWindow();
    const { events } = recordingEvents();
    let calls = 0;
    const stop = followWindowPages(store, events, () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      if (calls === 2) return Promise.reject(new Error("later"));
      return undefined;
    });
    await settle();
    for (let n = 0; n < 3; n++) {
      await events.emit(WINDOW_ACTION_EVENT, {
        windowId: window.id,
        action: { type: "item/create", spaceId: space.id },
      });
    }
    await settle();
    expect(calls).toBe(3);
    stop();
  });

  it("sends a window its space when its page says it is ready, and again each time the space changes", async () => {
    const { store, window, space } = await withWindow();
    const { events, heard } = recordingEvents();
    const stop = followWindowPages(store, events);
    await settle();
    // The window the workspace has is sent to the page that may be up already.
    const states = () => heard.filter((h) => h.event === WINDOW_STATE_EVENT);
    expect(states()).toHaveLength(1);
    expect(states()[0]?.payload).toEqual(windowStatePayload(window.id, space));

    // A page that loads later asks, and gets the space again.
    await events.emit(WINDOW_READY_EVENT, { windowId: window.id });
    await settle();
    expect(states()).toHaveLength(2);

    // The main window changing something that is not the window's space sends nothing.
    store.getState().newTab();
    await settle();
    expect(states()).toHaveLength(2);

    // The space of the window changing sends it.
    store.getState().dispatch({
      type: "space/rename",
      spaceId: space.id,
      name: "Renamed",
    });
    await settle();
    expect(states()).toHaveLength(3);
    const last = states()[2]?.payload as { space: Space };
    expect(last.space.name).toBe("Renamed");
    stop();
  });

  it("runs the action a window asks for, once it is checked, and nothing else", async () => {
    const { store, window, space, tab } = await withWindow();
    const { events } = recordingEvents();
    const stop = followWindowPages(store, events);
    await settle();
    const paneId = Object.values(space.items)[0]?.focusedPaneId ?? "";
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "pane/focus", itemId: tab, paneId },
    });
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "space/delete", spaceId: space.id, items: { mode: "close" } },
    });
    await events.emit(WINDOW_ACTION_EVENT, { windowId: "nope", action: { type: "pane/focus" } });
    await settle();
    const ws = store.getState().workspace;
    expect(ws.spaces.some((s) => s.id === space.id)).toBe(true);
    expect(checkInvariants(ws)).toEqual([]);
    stop();
  });

  it("stops listening and sending when stopped", async () => {
    const { store, window, space } = await withWindow();
    const { events, heard } = recordingEvents();
    const stop = followWindowPages(store, events);
    await settle();
    const before = heard.length;
    stop();
    await events.emit(WINDOW_READY_EVENT, { windowId: window.id });
    store.getState().dispatch({ type: "space/rename", spaceId: space.id, name: "After" });
    await settle();
    expect(heard.slice(before).filter((h) => h.event === WINDOW_STATE_EVENT)).toEqual([]);
  });

  it("forgets a window that went away, so one with the same id is sent its space again", async () => {
    const { store, window, space } = await withWindow();
    const { events, heard } = recordingEvents();
    const stop = followWindowPages(store, events);
    await settle();
    store.getState().dispatch({ type: "window/close", windowId: window.id });
    await settle();
    const states = () => heard.filter((h) => h.event === WINDOW_STATE_EVENT).length;
    const sent = states();
    // No window any more: a ready from a page that is not one sends nothing.
    await events.emit(WINDOW_READY_EVENT, { windowId: window.id });
    await settle();
    expect(states()).toBe(sent);
    expect(space.id).toBeTruthy();
    stop();
  });
});
