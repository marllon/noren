import {
  FakeBackend,
  checkInvariants,
  createSequentialIds,
  layoutPanes,
  liveSessionIds,
  restoreWorkspace,
  workspaceWindows,
} from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  closeAppWindow,
  followWindowClosed,
  moveItemToWindow,
  openWindowOnSpace,
} from "./window-service";
import { activeSpaceOf, createWorkspaceStore } from "./workspace-store";

const clock = { now: () => 1000 };

/** The main window: a store over a fake backend, with a space "Main" (one tab) and a space "Work" (one tab). */
async function openMain() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  store.getState().createSpace({ name: "Work" });
  store.getState().activateSpaceAt(0);
  const [main, work] = store.getState().workspace.spaces;
  if (!main || !work) throw new Error("two spaces were expected");
  return { backend, store, main, work };
}

const itemOf = (store: Awaited<ReturnType<typeof openMain>>["store"], spaceId: string) =>
  Object.values(store.getState().workspace.spaces.find((s) => s.id === spaceId)?.items ?? {});

describe("openWindowOnSpace", () => {
  it("adds the window to the workspace and makes the native one on that space", async () => {
    const { backend, store, work } = await openMain();
    const result = await openWindowOnSpace(store, backend, work.id);
    expect(result.ok).toBe(true);
    const windows = workspaceWindows(store.getState().workspace);
    expect(windows).toEqual([{ id: result.ok ? result.windowId : "", spaceId: work.id }]);
    expect(backend.windows().map((w) => [w.id, w.spaceId])).toEqual([[windows[0]?.id, work.id]]);
    expect(checkInvariants(store.getState().workspace)).toEqual([]);
  });

  it("refuses the space the main window shows, and a space that is not one, without calling the backend", async () => {
    const { backend, store, main } = await openMain();
    for (const space of [main.id, "nowhere"]) {
      const result = await openWindowOnSpace(store, backend, space);
      expect(result).toEqual({
        ok: false,
        reason: "that space cannot be shown in a window of its own",
      });
    }
    expect(backend.callsTo("openWindow")).toEqual([]);
    expect(store.getState().workspace.windows).toBeUndefined();
  });

  it("takes the window out of the workspace again when the backend refuses it", async () => {
    const { backend, store, work } = await openMain();
    backend.openWindow = () => Promise.reject(new Error("no window for you"));
    const result = await openWindowOnSpace(store, backend, work.id);
    expect(result).toEqual({ ok: false, reason: "no window for you" });
    expect(store.getState().workspace.windows).toBeUndefined();
  });

  it("does not open a second window on a space that has one", async () => {
    const { backend, store, work } = await openMain();
    expect((await openWindowOnSpace(store, backend, work.id)).ok).toBe(true);
    expect((await openWindowOnSpace(store, backend, work.id)).ok).toBe(false);
    expect(backend.windows()).toHaveLength(1);
  });
});

describe("moveItemToWindow", () => {
  it("hands the sessions of the tab to the window, then moves the tab into its space", async () => {
    const { backend, store, main, work } = await openMain();
    const opened = await openWindowOnSpace(store, backend, work.id);
    if (!opened.ok) throw new Error(opened.reason);
    const tab = itemOf(store, main.id)[0];
    if (!tab) throw new Error("the main space has a tab");
    const sessions = layoutPanes(tab.layout).map((pane) => Number(pane.sessionId));
    const before = liveSessionIds(store.getState().workspace);
    const created = backend.callsTo("createSession").length;

    const result = await moveItemToWindow(store, backend, tab.id, opened.windowId);
    expect(result).toEqual({ ok: true, windowId: opened.windowId });
    // The window got the output of the same sessions...
    expect(backend.callsTo("moveTabToWindow").map((call) => call.args)).toEqual([
      [opened.windowId, sessions],
    ]);
    expect(sessions.every((id) => backend.windowOfSession(id) === opened.windowId)).toBe(true);
    // ...the tab is now in the space of the window and is the one it shows...
    const ws = store.getState().workspace;
    const target = ws.spaces.find((s) => s.id === work.id);
    expect(Object.hasOwn(target?.items ?? {}, tab.id)).toBe(true);
    expect(target?.activeItemId).toBe(tab.id);
    expect(Object.hasOwn(ws.spaces.find((s) => s.id === main.id)?.items ?? {}, tab.id)).toBe(false);
    // ...and nothing was restarted: no session was made or killed.
    expect(liveSessionIds(ws)).toEqual(before);
    expect(backend.callsTo("kill")).toEqual([]);
    expect(backend.callsTo("createSession")).toHaveLength(created);
  });

  it("leaves the tab where it was when the window refuses the sessions", async () => {
    const { backend, store, main, work } = await openMain();
    const opened = await openWindowOnSpace(store, backend, work.id);
    if (!opened.ok) throw new Error(opened.reason);
    const tab = itemOf(store, main.id)[0];
    if (!tab) throw new Error("the main space has a tab");
    backend.moveTabToWindow = () => Promise.reject(new Error("the page did not answer"));
    const before = store.getState().workspace;
    expect(await moveItemToWindow(store, backend, tab.id, opened.windowId)).toEqual({
      ok: false,
      reason: "the page did not answer",
    });
    expect(store.getState().workspace).toBe(before);
  });

  it("refuses a window or a tab that does not exist, and a tab already in the window", async () => {
    const { backend, store, main, work } = await openMain();
    const opened = await openWindowOnSpace(store, backend, work.id);
    if (!opened.ok) throw new Error(opened.reason);
    const mainTab = itemOf(store, main.id)[0];
    const workTab = itemOf(store, work.id)[0];
    if (!mainTab || !workTab) throw new Error("both spaces have a tab");
    expect(await moveItemToWindow(store, backend, mainTab.id, "w-gone")).toEqual({
      ok: false,
      reason: "no such window",
    });
    expect(await moveItemToWindow(store, backend, "no-tab", opened.windowId)).toEqual({
      ok: false,
      reason: "no such tab",
    });
    expect(await moveItemToWindow(store, backend, workTab.id, opened.windowId)).toEqual({
      ok: false,
      reason: "that tab is in the window already",
    });
    expect(backend.callsTo("moveTabToWindow")).toEqual([]);
  });

  it("says so when the tab went away while the window was taking it", async () => {
    const { backend, store, main, work } = await openMain();
    const opened = await openWindowOnSpace(store, backend, work.id);
    if (!opened.ok) throw new Error(opened.reason);
    const tab = itemOf(store, main.id)[0];
    if (!tab) throw new Error("the main space has a tab");
    const move = backend.moveTabToWindow.bind(backend);
    backend.moveTabToWindow = async (windowId, ids) => {
      await move(windowId, ids);
      store.getState().closeItems([tab.id]);
    };
    const result = await moveItemToWindow(store, backend, tab.id, opened.windowId);
    expect(result).toEqual({
      ok: false,
      reason: "the tab or the window changed while the tab moved",
    });
  });
});

describe("closeAppWindow and followWindowClosed", () => {
  it("closes the window in the workspace and in the backend, and the space keeps its tabs", async () => {
    const { backend, store, work } = await openMain();
    const opened = await openWindowOnSpace(store, backend, work.id);
    if (!opened.ok) throw new Error(opened.reason);
    const tabs = itemOf(store, work.id).map((item) => item.id);
    expect(await closeAppWindow(store, backend, opened.windowId)).toEqual({
      ok: true,
      windowId: opened.windowId,
    });
    expect(store.getState().workspace.windows).toBeUndefined();
    expect(backend.windows()).toEqual([]);
    expect(itemOf(store, work.id).map((item) => item.id)).toEqual(tabs);
    expect(await closeAppWindow(store, backend, opened.windowId)).toEqual({
      ok: false,
      reason: "no such window",
    });
  });

  it("drops the window from the workspace when the person closes the native one", async () => {
    const { backend, store, work } = await openMain();
    const opened = await openWindowOnSpace(store, backend, work.id);
    if (!opened.ok) throw new Error(opened.reason);
    const stop = followWindowClosed(store, backend);
    backend.closeWindowByPerson(opened.windowId);
    expect(store.getState().workspace.windows).toBeUndefined();
    // The main window can show the space again now.
    store.getState().activateSpace(work.id);
    expect(activeSpaceOf(store.getState().workspace).id).toBe(work.id);
    stop();
  });

  it("leaves the main window off the space of a window while the window is there", async () => {
    const { backend, store, main, work } = await openMain();
    await openWindowOnSpace(store, backend, work.id);
    store.getState().activateSpace(work.id);
    expect(activeSpaceOf(store.getState().workspace).id).toBe(main.id);
  });
});
