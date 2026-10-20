import {
  FakeBackend,
  MAX_EXTRA_WINDOWS,
  checkInvariants,
  createSequentialIds,
  layoutPanes,
  liveSessionIds,
  restoreWorkspace,
  serializeWorkspace,
  workspaceWindows,
} from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  bringUpWindows,
  followWindowClosed,
  moveItemToNewWindow,
  releaseWindows,
  returnWindowTabs,
  windowMoveProblem,
} from "./window-service";
import { activeSpaceOf, createWorkspaceStore } from "./workspace-store";

// A tab dragged out of the window: the space and the window it gets, the sessions that go with it
// and come back, and the windows the saved state brings up again.

const clock = { now: () => 1000 };

/** The main window: a store over a fake backend, with the space "Main" and one tab. */
async function openMain() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  const main = store.getState().workspace.spaces[0];
  if (!main) throw new Error("a space was expected");
  return { backend, store, main };
}

const itemsOf = (store: Awaited<ReturnType<typeof openMain>>["store"], spaceId: string) =>
  Object.values(store.getState().workspace.spaces.find((s) => s.id === spaceId)?.items ?? {});

async function dragged() {
  const main = await openMain();
  const tab = itemsOf(main.store, main.main.id)[0];
  if (!tab) throw new Error("the main space has a tab");
  const result = await moveItemToNewWindow(main.store, main.backend, tab.id);
  if (!result.ok) throw new Error(result.reason);
  return { ...main, tab, windowId: result.windowId };
}

/** The app opened again on the saved state: a new backend, the workspace restored, nothing open. */
async function reopened(saved: string) {
  const backend = new FakeBackend({ state: saved });
  const newId = createSequentialIds("m");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  return { backend, store };
}

describe("moveItemToNewWindow", () => {
  it("makes the window and its space, takes the tab out of its space and hands the window its sessions", async () => {
    const { backend, store, main } = await openMain();
    const tab = itemsOf(store, main.id)[0];
    if (!tab) throw new Error("the main space has a tab");
    const sessions = layoutPanes(tab.layout).map((pane) => Number(pane.sessionId));
    const before = liveSessionIds(store.getState().workspace);
    const created = backend.callsTo("createSession").length;

    const result = await moveItemToNewWindow(store, backend, tab.id, "Logs");
    expect(result.ok).toBe(true);
    const ws = store.getState().workspace;
    const window = workspaceWindows(ws)[0];
    expect(window?.returnSpaceId).toBe(main.id);
    const made = ws.spaces.find((s) => s.id === window?.spaceId);
    expect(made?.name).toBe("Logs");
    expect(Object.keys(made?.items ?? {})).toEqual([tab.id]);
    expect(itemsOf(store, main.id).map((item) => item.id)).not.toContain(tab.id);
    // The native window was made for that space and got the output of the same sessions.
    expect(backend.windows().map((w) => [w.id, w.spaceId, w.sessions])).toEqual([
      [window?.id, made?.id, sessions],
    ]);
    // Nothing was restarted, and the main window still shows the space it showed.
    expect(liveSessionIds(ws)).toEqual(before);
    expect(backend.callsTo("kill")).toEqual([]);
    expect(backend.callsTo("createSession")).toHaveLength(created);
    expect(ws.activeSpaceId).toBe(main.id);
    expect(checkInvariants(ws)).toEqual([]);
  });

  it("gives the tab back, and leaves no window, when the backend refuses to open one", async () => {
    const { backend, store, main } = await openMain();
    const tab = itemsOf(store, main.id)[0];
    if (!tab) throw new Error("the main space has a tab");
    const before = store.getState().workspace;
    backend.openWindow = () => Promise.reject(new Error("no window for you"));
    expect(await moveItemToNewWindow(store, backend, tab.id)).toEqual({
      ok: false,
      reason: "no window for you",
    });
    const ws = store.getState().workspace;
    expect(ws.windows).toBeUndefined();
    expect(ws.spaces.map((s) => s.id)).toEqual(before.spaces.map((s) => s.id));
    expect(itemsOf(store, main.id).map((item) => item.id)).toContain(tab.id);
    expect(checkInvariants(ws)).toEqual([]);
  });

  it("attaches the sessions to the main window again when the window did not take them", async () => {
    const { backend, store, main } = await openMain();
    const tab = itemsOf(store, main.id)[0];
    if (!tab) throw new Error("the main space has a tab");
    const sessions = layoutPanes(tab.layout).map((pane) => Number(pane.sessionId));
    backend.moveTabToWindow = () => Promise.reject(new Error("the page did not answer"));
    const result = await moveItemToNewWindow(store, backend, tab.id);
    expect(result).toEqual({ ok: false, reason: "the page did not answer" });
    expect(backend.callsTo("attachSession").map((call) => call.args[0])).toEqual(sessions);
    expect(store.getState().workspace.windows).toBeUndefined();
    expect(backend.windows()).toEqual([]);
  });

  it("refuses a tab that is not there and one with a pane a window cannot draw, calling nothing", async () => {
    const { backend, store, main } = await openMain();
    const tab = itemsOf(store, main.id)[0];
    if (!tab) throw new Error("the main space has a tab");
    expect(await moveItemToNewWindow(store, backend, "nope")).toEqual({
      ok: false,
      reason: "no such tab",
    });
    store.getState().dispatch({
      type: "pane/split",
      itemId: tab.id,
      paneId: tab.focusedPaneId,
      dir: "row",
      side: "after",
      url: "https://example.com",
    });
    expect(windowMoveProblem(store.getState().workspace, tab.id)).toBe("panes");
    const refused = await moveItemToNewWindow(store, backend, tab.id);
    expect(refused.ok).toBe(false);
    expect(backend.callsTo("openWindow")).toEqual([]);
    expect(store.getState().workspace.windows).toBeUndefined();
  });

  it("tells what stops a tab from going to a window of its own", async () => {
    const { store, main } = await openMain();
    const tab = itemsOf(store, main.id)[0];
    if (!tab) throw new Error("the main space has a tab");
    const ws = store.getState().workspace;
    expect(windowMoveProblem(ws, tab.id)).toBeUndefined();
    expect(windowMoveProblem(ws, "nope")).toBe("no-tab");
    const full = {
      ...ws,
      windows: Array.from({ length: MAX_EXTRA_WINDOWS }, (_, n) => ({
        id: `w${n}`,
        spaceId: "ghost",
      })),
    };
    expect(windowMoveProblem(full, tab.id)).toBe("limit");
  });
});

describe("returnWindowTabs", () => {
  it("attaches the sessions to the main window again, gives the tab back and closes the window", async () => {
    const { backend, store, main, tab, windowId } = await dragged();
    const sessions = layoutPanes(tab.layout).map((pane) => Number(pane.sessionId));
    const spaces = store.getState().workspace.spaces.length;
    const before = liveSessionIds(store.getState().workspace);
    expect(await returnWindowTabs(store, backend, windowId)).toEqual({ ok: true, windowId });
    expect(backend.callsTo("attachSession").map((call) => call.args[0])).toEqual(sessions);
    // The terminals of the main window are drawn new for the tab: they ask for what it printed.
    expect(backend.callsTo("attachSession").map((call) => call.args[1])).toEqual(
      sessions.map(() => ({ replay: true })),
    );
    expect(backend.windows()).toEqual([]);
    const ws = store.getState().workspace;
    expect(ws.windows).toBeUndefined();
    // The space made for the window went away; the tab is where it came from, the same sessions.
    expect(ws.spaces).toHaveLength(spaces - 1);
    expect(itemsOf(store, main.id).map((item) => item.id)).toContain(tab.id);
    expect(liveSessionIds(ws)).toEqual(before);
    expect(backend.callsTo("kill")).toEqual([]);
    expect(checkInvariants(ws)).toEqual([]);
  });

  it("says so for a window that does not exist, and a session that ended meanwhile does not stop it", async () => {
    const { backend, store, main, windowId, tab } = await dragged();
    expect(await returnWindowTabs(store, backend, "nope")).toEqual({
      ok: false,
      reason: "no such window",
    });
    backend.attachSession = () => Promise.reject(new Error("gone"));
    expect(await returnWindowTabs(store, backend, windowId)).toEqual({ ok: true, windowId });
    expect(store.getState().workspace.windows).toBeUndefined();
    expect(itemsOf(store, main.id).map((item) => item.id)).toContain(tab.id);
  });
});

describe("a window the person closes, when it was made for a tab", () => {
  it("gives the tabs back and attaches their sessions to the main window again", async () => {
    const { backend, store, main } = await openMain();
    const tab = itemsOf(store, main.id)[0];
    if (!tab) throw new Error("the main space has a tab");
    const stop = followWindowClosed(store, backend);
    const result = await moveItemToNewWindow(store, backend, tab.id);
    if (!result.ok) throw new Error(result.reason);
    const sessions = layoutPanes(tab.layout).map((pane) => Number(pane.sessionId));
    backend.closeWindowByPerson(result.windowId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.getState().workspace.windows).toBeUndefined();
    expect(itemsOf(store, main.id).map((item) => item.id)).toContain(tab.id);
    expect(backend.callsTo("attachSession").map((call) => call.args[0])).toEqual(sessions);
    expect(checkInvariants(store.getState().workspace)).toEqual([]);
    stop();
  });
});

describe("bringUpWindows", () => {
  it("opens the window of every window of the saved state and hands it the sessions of its tabs", async () => {
    const first = await dragged();
    const { backend, store } = await reopened(serializeWorkspace(first.store.getState().workspace));
    expect(backend.windows()).toEqual([]);
    await bringUpWindows(store, backend);
    const window = workspaceWindows(store.getState().workspace)[0];
    const space = store.getState().workspace.spaces.find((s) => s.id === window?.spaceId);
    const sessions = Object.values(space?.items ?? {}).flatMap((item) =>
      layoutPanes(item.layout).map((pane) => Number(pane.sessionId)),
    );
    expect(sessions).toHaveLength(1);
    expect(backend.windows().map((w) => [w.id, w.spaceId, w.sessions])).toEqual([
      [window?.id, space?.id, sessions],
    ]);
    // The window that was brought up is the one that was saved.
    expect(window?.id).toBe(first.windowId);
  });

  it("gives the tabs back when a window cannot be brought up", async () => {
    const first = await dragged();
    const { backend, store } = await reopened(serializeWorkspace(first.store.getState().workspace));
    backend.openWindow = () => Promise.reject(new Error("cannot"));
    await bringUpWindows(store, backend);
    const ws = store.getState().workspace;
    expect(ws.windows).toBeUndefined();
    expect(itemsOf(store, first.main.id)).toHaveLength(1);
    expect(checkInvariants(ws)).toEqual([]);
  });

  it("does nothing for a workspace without windows", async () => {
    const { backend, store } = await openMain();
    await bringUpWindows(store, backend);
    expect(backend.callsTo("openWindow")).toEqual([]);
  });
});

describe("releaseWindows", () => {
  it("gives the tabs of every window back to the main window, and the spaces made for them go", async () => {
    const first = await dragged();
    const { store } = await reopened(serializeWorkspace(first.store.getState().workspace));
    expect(workspaceWindows(store.getState().workspace)).toHaveLength(1);
    releaseWindows(store);
    const ws = store.getState().workspace;
    expect(ws.windows).toBeUndefined();
    expect(ws.spaces).toHaveLength(1);
    expect(itemsOf(store, first.main.id)).toHaveLength(1);
    expect(checkInvariants(ws)).toEqual([]);
  });
});

describe("the spaces the main window can show, with a window open", () => {
  it("counts them without the space a window shows, so Ctrl+Alt+2 is the second one it lists", async () => {
    const { store, main } = await dragged();
    store.getState().createSpace({ name: "Work" });
    store.getState().activateSpaceAt(0);
    expect(store.getState().workspace.activeSpaceId).toBe(main.id);
    // The workspace holds Main, the space of the window, Work; the switcher lists Main and Work.
    expect(store.getState().workspace.spaces).toHaveLength(3);
    store.getState().activateSpaceAt(1);
    expect(activeSpaceOf(store.getState().workspace).name).toBe("Work");
    store.getState().activateSpaceAt(2);
    expect(activeSpaceOf(store.getState().workspace).name).toBe("Work");
  });
});
