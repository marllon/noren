import { FakeBackend, checkInvariants, createSequentialIds, workspaceWindows } from "@noren/model";
import type { Space } from "@noren/model";
import { describe, expect, it } from "vitest";
import { memoryQuickEvents } from "./quick";
import type { QuickEvents } from "./quick";
import { WINDOW_READY_EVENT } from "./window-events";
import {
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
      "item/close",
      "pane/close",
      "pane/split",
      "space/delete",
      "window/close",
      "window/return",
      "item/move",
      "pane/set-url",
      "space/activate",
    ]) {
      refused({ type, itemId: tab, paneId: "p", spaceId: space.id, windowId: window.id });
    }
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

describe("followWindowPages", () => {
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
