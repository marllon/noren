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
import { memoryQuickEvents } from "./quick";
import {
  moveItemToNewWindow,
  openTabInWindow,
  returnWindowTabs,
  runWindowAction,
} from "./window-service";
import { WINDOW_ACTION_EVENT, followWindowPages } from "./window-sync";
import { createWorkspaceStore } from "./workspace-store";

// The tabs a window opens, closes and moves for itself (NOR-F15-04c): the page of the window asks,
// the main window checks (window-sync.test.ts) and carries out, here.

const clock = { now: () => 1000 };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A main window with a window made for one of its tabs, over a fake backend. */
async function withWindow() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  // Two tabs in the main space: one goes out, one stays.
  store.getState().newTab({ cwd: "/work/app" });
  const main = store.getState().workspace.spaces[0];
  const out = Object.keys(main?.items ?? {})[0];
  if (main === undefined || out === undefined) throw new Error("a tab was expected");
  const moved = await moveItemToNewWindow(store, backend, out, "Out");
  if (!moved.ok) throw new Error(moved.reason);
  const window = workspaceWindows(store.getState().workspace)[0];
  if (window === undefined) throw new Error("the window was expected");
  const spaceOf = () => store.getState().workspace.spaces.find((s) => s.id === window.spaceId);
  return { backend, store, main, out, window, spaceOf };
}

describe("openTabInWindow", () => {
  it("makes a tab in the space of the window, starts its shell and hands the window the output", async () => {
    const { backend, store, window, spaceOf } = await withWindow();
    const started = backend.callsTo("createSession").length;
    const known = Object.keys(spaceOf()?.items ?? {});

    const result = await openTabInWindow(store, backend, window.id);
    expect(result).toEqual({ ok: true, windowId: window.id });

    // The tab is in the space of the window, the one the window shows, with one shell.
    const space = spaceOf();
    const made = Object.keys(space?.items ?? {}).filter((id) => !known.includes(id));
    expect(made).toHaveLength(1);
    const item = space?.items[made[0] ?? ""];
    expect(space?.activeItemId).toBe(made[0]);
    const panes = layoutPanes(item?.layout ?? { kind: "pane", pane: undefined as never });
    expect(panes).toHaveLength(1);
    const session = Number(panes[0]?.sessionId);
    expect(Number.isInteger(session)).toBe(true);
    expect(backend.callsTo("createSession")).toHaveLength(started + 1);
    // The shell was started for that pane, with the folder and profile the space gives.
    const options = backend.callsTo("createSession").at(-1)?.args[0] as Record<string, unknown>;
    expect(options["paneId"]).toBe(panes[0]?.id);
    expect(options["cols"]).toBe(80);
    expect(options["rows"]).toBe(24);
    // The window got the output of that shell (the same process, under the same id).
    expect(backend.windowOfSession(session)).toBe(window.id);
    expect(backend.callsTo("kill")).toEqual([]);
    expect(checkInvariants(store.getState().workspace)).toEqual([]);
  });

  it("starts the shell with what the space says: its folder and its environment", async () => {
    const { backend, store, window, spaceOf } = await withWindow();
    store.getState().dispatch({
      type: "space/set-defaults",
      spaceId: window.spaceId,
      cwd: "/work/other",
      env: { NOREN_TEST: "1" },
    });
    expect(spaceOf()?.defaults.cwd).toBe("/work/other");
    await openTabInWindow(store, backend, window.id);
    const options = backend.callsTo("createSession").at(-1)?.args[0] as Record<string, unknown>;
    expect(options["cwd"]).toBe("/work/other");
    expect(options["env"]).toEqual({ NOREN_TEST: "1" });
  });

  it("closes the tab again, ends nothing else, when the shell cannot start", async () => {
    const { backend, store, window, spaceOf } = await withWindow();
    const before = Object.keys(spaceOf()?.items ?? {});
    backend.createSession = () => Promise.reject(new Error("no shell today"));
    const result = await openTabInWindow(store, backend, window.id);
    expect(result).toEqual({ ok: false, reason: "no shell today" });
    expect(Object.keys(spaceOf()?.items ?? {})).toEqual(before);
    expect(checkInvariants(store.getState().workspace)).toEqual([]);
  });

  it("closes the tab, and ends the shell it started, when the window does not take it", async () => {
    const { backend, store, window, spaceOf } = await withWindow();
    const before = Object.keys(spaceOf()?.items ?? {});
    backend.moveTabToWindow = () => Promise.reject(new Error("the window did not answer"));
    const result = await openTabInWindow(store, backend, window.id);
    expect(result).toEqual({ ok: false, reason: "the window did not answer" });
    expect(Object.keys(spaceOf()?.items ?? {})).toEqual(before);
    // Its shell is not left running with nobody to show it.
    expect(backend.callsTo("kill")).toHaveLength(1);
    expect(liveSessionIds(store.getState().workspace).size).toBe(
      layoutPanes(
        spaceOf()?.items[before[0] ?? ""]?.layout ?? { kind: "pane", pane: undefined as never },
      ).length + liveSessionsOutside(store, window.spaceId),
    );
  });

  it("says so for a window that does not exist", async () => {
    const { backend, store } = await withWindow();
    expect(await openTabInWindow(store, backend, "nope")).toEqual({
      ok: false,
      reason: "no such window",
    });
  });
});

/** How many live sessions the panes outside the space `spaceId` hold. */
function liveSessionsOutside(
  store: Awaited<ReturnType<typeof withWindow>>["store"],
  spaceId: string,
): number {
  return store
    .getState()
    .workspace.spaces.filter((s) => s.id !== spaceId)
    .flatMap((s) => Object.values(s.items))
    .flatMap((item) => layoutPanes(item.layout))
    .filter((pane) => pane.sessionId !== undefined).length;
}

describe("runWindowAction", () => {
  it("closing a tab ends its shell, and the window stays while it has another tab", async () => {
    const { backend, store, window, out, spaceOf } = await withWindow();
    await openTabInWindow(store, backend, window.id);
    const outSession = Number(
      layoutPanes(spaceOf()?.items[out]?.layout ?? never()).at(0)?.sessionId,
    );
    await runWindowAction(store, backend, window.id, { type: "item/close", itemId: out });
    expect(Object.keys(spaceOf()?.items ?? {})).not.toContain(out);
    expect(backend.callsTo("kill").map((call) => call.args[0])).toEqual([outSession]);
    expect(workspaceWindows(store.getState().workspace)).toHaveLength(1);
    expect(backend.windows()).toHaveLength(1);
  });

  it("closing the last tab closes the window, and the space made for it goes away", async () => {
    const { backend, store, window, out, main, spaceOf } = await withWindow();
    const spaces = store.getState().workspace.spaces.length;
    await runWindowAction(store, backend, window.id, { type: "item/close", itemId: out });
    expect(spaceOf()).toBeUndefined();
    expect(store.getState().workspace.spaces).toHaveLength(spaces - 1);
    expect(workspaceWindows(store.getState().workspace)).toEqual([]);
    expect(backend.windows()).toEqual([]);
    expect(backend.callsTo("kill")).toHaveLength(1);
    expect(store.getState().workspace.spaces.some((s) => s.id === main.id)).toBe(true);
    expect(checkInvariants(store.getState().workspace)).toEqual([]);
  });

  it("closing the last tab of a window on a space of the user closes the window and keeps the space", async () => {
    const backend = new FakeBackend();
    const newId = createSequentialIds("n");
    const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
    const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
    store.getState().createSpace({ name: "Mine" });
    const mine = store.getState().workspace.spaces.find((s) => s.name === "Mine");
    if (mine === undefined) throw new Error("the space was expected");
    store.getState().activateSpace(restored.workspace.spaces[0]?.id ?? "");
    store.getState().dispatch({ type: "window/open", spaceId: mine.id });
    const window = workspaceWindows(store.getState().workspace)[0];
    if (window === undefined) throw new Error("the window was expected");
    await backend.openWindow(window.id, mine.id);
    const tab = Object.keys(mine.items)[0] ?? "";

    await runWindowAction(store, backend, window.id, { type: "item/close", itemId: tab });
    expect(workspaceWindows(store.getState().workspace)).toEqual([]);
    expect(backend.windows()).toEqual([]);
    const kept = store.getState().workspace.spaces.find((s) => s.id === mine.id);
    expect(kept).toBeDefined();
    expect(Object.keys(kept?.items ?? {})).toEqual([]);
  });

  it("moving a tab changes the order of the sidebar, and nothing else", async () => {
    const { backend, store, window, spaceOf } = await withWindow();
    await openTabInWindow(store, backend, window.id);
    await openTabInWindow(store, backend, window.id);
    const order = () => (spaceOf()?.tree ?? []).map((node) => node.id);
    const [a, b, c] = order();
    if (a === undefined || b === undefined || c === undefined) throw new Error("three tabs");
    const sessions = [...liveSessionIds(store.getState().workspace)].sort();
    await runWindowAction(store, backend, window.id, {
      type: "item/move",
      itemId: c,
      placement: { to: "tree", index: 0 },
    });
    expect(order()).toEqual([c, a, b]);
    expect([...liveSessionIds(store.getState().workspace)].sort()).toEqual(sessions);
    expect(backend.callsTo("kill")).toEqual([]);
    expect(backend.windows()).toHaveLength(1);
  });

  it("showing a tab asks nothing of the backend", async () => {
    const { backend, store, window, out, spaceOf } = await withWindow();
    await openTabInWindow(store, backend, window.id);
    const calls = backend.calls.length;
    await runWindowAction(store, backend, window.id, {
      type: "space/set-active-item",
      spaceId: window.spaceId,
      itemId: out,
    });
    expect(spaceOf()?.activeItemId).toBe(out);
    expect(backend.calls.length).toBe(calls);
  });
});

describe("a request from a window, end to end through the events", () => {
  it("a new tab is made, its shell started and handed to the window; a close ends the shell", async () => {
    const { backend, store, window, spaceOf } = await withWindow();
    const events = memoryQuickEvents();
    const stop = followWindowPages(store, events, (windowId, action) =>
      runWindowAction(store, backend, windowId, action),
    );
    await settle();
    const known = Object.keys(spaceOf()?.items ?? {});

    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "item/create", spaceId: window.spaceId },
    });
    await settle();
    await settle();
    const made = Object.keys(spaceOf()?.items ?? {}).filter((id) => !known.includes(id));
    expect(made).toHaveLength(1);
    const session = Number(
      layoutPanes(spaceOf()?.items[made[0] ?? ""]?.layout ?? never())[0]?.sessionId,
    );
    expect(backend.windowOfSession(session)).toBe(window.id);

    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "item/close", itemId: made[0] },
    });
    await settle();
    expect(backend.callsTo("kill").map((call) => call.args[0])).toEqual([session]);

    // A request for the space of another window, or for a window that is not there, does nothing.
    const starts = backend.callsTo("createSession").length;
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "item/create", spaceId: store.getState().workspace.activeSpaceId },
    });
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: "nope",
      action: { type: "item/create", spaceId: window.spaceId },
    });
    await settle();
    expect(backend.callsTo("createSession")).toHaveLength(starts);
    stop();
  });

  it("a window cannot reach the tabs of another window", async () => {
    const { backend, store, window, main } = await withWindow();
    const second = Object.keys(
      store.getState().workspace.spaces.find((s) => s.id === main.id)?.items ?? {},
    )[0];
    if (second === undefined) throw new Error("a tab was expected");
    const other = await moveItemToNewWindow(store, backend, second, "Other");
    if (!other.ok) throw new Error(other.reason);
    const events = memoryQuickEvents();
    const stop = followWindowPages(store, events, (windowId, action) =>
      runWindowAction(store, backend, windowId, action),
    );
    await settle();
    const before = store.getState().workspace;
    // The first window asks to close and to move a tab of the second.
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "item/close", itemId: second },
    });
    await events.emit(WINDOW_ACTION_EVENT, {
      windowId: window.id,
      action: { type: "item/move", itemId: second, placement: { to: "tree", index: 0 } },
    });
    await settle();
    expect(store.getState().workspace).toBe(before);
    expect(backend.callsTo("kill")).toEqual([]);
    stop();
  });

  it("returning the tabs of a window after tabs were opened in it gives them all back", async () => {
    const { backend, store, window, main } = await withWindow();
    await openTabInWindow(store, backend, window.id);
    await openTabInWindow(store, backend, window.id);
    const sessions = [...liveSessionIds(store.getState().workspace)].sort();
    await returnWindowTabs(store, backend, window.id);
    expect(workspaceWindows(store.getState().workspace)).toEqual([]);
    expect(
      Object.keys(store.getState().workspace.spaces.find((s) => s.id === main.id)?.items ?? {}),
    ).toHaveLength(4);
    expect([...liveSessionIds(store.getState().workspace)].sort()).toEqual(sessions);
    expect(backend.callsTo("kill")).toEqual([]);
  });
});

/** A layout for the places a test reads a pane that is there (a missing one fails the test). */
function never(): never {
  throw new Error("the tab was expected to be there");
}
