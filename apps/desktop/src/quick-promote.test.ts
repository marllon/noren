import {
  FakeBackend,
  createSequentialIds,
  layoutPanes,
  liveSessionIds,
  restoreWorkspace,
} from "@noren/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followQuickPromotions, promoteQuickSession } from "./quick-promote";
import {
  QUICK_PROMOTED_EVENT,
  QUICK_PROMOTE_EVENT,
  QUICK_WINDOW_LABEL,
  sessionOfPayload,
  windowKindOf,
} from "./quick";
import type { QuickEvents } from "./quick";
import { activeItemIdOf, activeSpaceOf, createWorkspaceStore } from "./workspace-store";

const clock = { now: () => 1000 };

/** The main window: a store over a fake backend, with the one tab a fresh workspace has. */
async function openMain(backend = new FakeBackend()) {
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  return { backend, store };
}

/** The part of the event system the quick terminal uses, in memory. */
function fakeEvents() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: { event: string; payload: unknown }[] = [];
  const events: QuickEvents = {
    listen: (event, handler) => {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set);
      set.add(handler);
      return Promise.resolve(() => {
        set.delete(handler);
      });
    },
    emit: (event, payload) => {
      emitted.push({ event, payload });
      return Promise.resolve();
    },
  };
  const send = (event: string, payload: unknown) => {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
  };
  return { events, emitted, send };
}

/** The tab a session is shown in, in the space on screen. */
function tabHolding(store: Awaited<ReturnType<typeof openMain>>["store"], sessionId: number) {
  const space = activeSpaceOf(store.getState().workspace);
  return Object.values(space.items).find((item) =>
    layoutPanes(item.layout).some((pane) => pane.sessionId === String(sessionId)),
  );
}

describe("windowKindOf", () => {
  it("tells the quick window by its label, and takes everything else for the main one", () => {
    expect(QUICK_WINDOW_LABEL).toBe("quick");
    expect(windowKindOf("quick")).toBe("quick");
    expect(windowKindOf("main")).toBe("main");
    // A plain browser has no window label.
    expect(windowKindOf(undefined)).toBe("main");
    expect(windowKindOf("")).toBe("main");
    expect(windowKindOf("Quick")).toBe("main");
  });
});

describe("sessionOfPayload", () => {
  it("reads the id of a session and nothing else", () => {
    expect(sessionOfPayload({ id: 3 })).toBe(3);
    expect(sessionOfPayload({ id: 3, ok: true, itemId: "n1" })).toBe(3);
    for (const bad of [
      undefined,
      null,
      3,
      "3",
      [],
      {},
      { id: "3" },
      { id: 0 },
      { id: -1 },
      { id: 1.5 },
      { id: Number.NaN },
      { id: Number.MAX_SAFE_INTEGER + 2 },
      { id: [3] },
    ]) {
      expect(sessionOfPayload(bad)).toBeUndefined();
    }
  });
});

describe("promoting a session of the quick window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes a tab in the active space around the same session, with no new shell", async () => {
    const { backend, store } = await openMain();
    const startsBefore = backend.callsTo("createSession").length;
    // The shell the quick window opened.
    const quick = await backend.createSession({ cols: 100, rows: 30 });
    const tabsBefore = Object.keys(activeSpaceOf(store.getState().workspace).items);

    const result = await promoteQuickSession(store, backend, quick);

    expect(result.ok).toBe(true);
    const tab = tabHolding(store, quick);
    expect(tab).toBeDefined();
    expect(result).toEqual({ ok: true, itemId: tab?.id });
    expect(tabsBefore).not.toContain(tab?.id);
    expect(layoutPanes(tab?.layout ?? { kind: "pane", pane: undefined as never })).toHaveLength(1);
    // It is the tab on screen, and the pane stands for the default profile.
    expect(activeItemIdOf(store.getState())).toBe(tab?.id);
    expect(tab && layoutPanes(tab.layout)[0]).toMatchObject({
      sessionId: String(quick),
      profileId: "default",
    });
    // The backend was asked to take the session over, once; no other shell was started for it.
    expect(backend.callsTo("attachSession").map((call) => call.args)).toEqual([[quick]]);
    expect(backend.callsTo("createSession")).toHaveLength(startsBefore + 1);
    expect(backend.session(quick)?.alive).toBe(true);
  });

  it("moves the output before the tab exists, so the terminal of the tab finds it", async () => {
    const { backend, store } = await openMain();
    const quick = await backend.createSession({ cols: 80, rows: 24 });
    let tabAtAttach: unknown = "not called";
    const attach = backend.attachSession.bind(backend);
    vi.spyOn(backend, "attachSession").mockImplementation(async (id) => {
      tabAtAttach = tabHolding(store, id);
      await attach(id);
    });

    await promoteQuickSession(store, backend, quick);

    expect(tabAtAttach).toBeUndefined();
    expect(tabHolding(store, quick)).toBeDefined();
  });

  it("keeps the shell answering: the tab writes to it and hears it", async () => {
    const { backend, store } = await openMain();
    const quick = await backend.createSession({ cols: 80, rows: 24 });
    await backend.write(quick, "pwd\r");
    await promoteQuickSession(store, backend, quick);

    const heard: string[] = [];
    backend.onOutput(quick, (bytes) => heard.push(new TextDecoder().decode(bytes)));
    await backend.write(quick, "echo still-here\r");

    expect(heard.join("")).toContain("still-here");
    expect(backend.session(quick)).toMatchObject({ id: quick, alive: true });
  });

  it("changes nothing for a session no tab can show: it is not running", async () => {
    const { backend, store } = await openMain();
    const before = store.getState().workspace;

    const result = await promoteQuickSession(store, backend, 999);

    expect(result).toEqual({ ok: false, reason: "unknown session 999" });
    expect(store.getState().workspace).toBe(before);
  });

  it("changes nothing for a session that ended", async () => {
    const { backend, store } = await openMain();
    const quick = await backend.createSession({ cols: 80, rows: 24 });
    await backend.kill(quick);
    const before = store.getState().workspace;

    const result = await promoteQuickSession(store, backend, quick);

    expect(result.ok).toBe(false);
    expect(store.getState().workspace).toBe(before);
  });

  it("does not take a session twice: a tab already shows it", async () => {
    const { backend, store } = await openMain();
    const quick = await backend.createSession({ cols: 80, rows: 24 });
    await promoteQuickSession(store, backend, quick);
    const before = store.getState().workspace;

    const again = await promoteQuickSession(store, backend, quick);

    expect(again).toEqual({ ok: false, reason: "a tab already shows that session" });
    expect(store.getState().workspace).toBe(before);
    expect(backend.callsTo("attachSession")).toHaveLength(1);
    // Nor a session a tab of the window started itself.
    const own = [...liveSessionIds(before)].map(Number).find((id) => id !== quick);
    expect(own).toBeDefined();
    const ownResult = await promoteQuickSession(store, backend, own ?? 0);
    expect(ownResult.ok).toBe(false);
    expect(backend.callsTo("attachSession")).toHaveLength(1);
  });

  it("ends the shell when its tab is closed, like any other tab", async () => {
    const { backend, store } = await openMain();
    const quick = await backend.createSession({ cols: 80, rows: 24 });
    const result = await promoteQuickSession(store, backend, quick);
    expect(result.ok).toBe(true);

    store.getState().closeItems([result.ok ? result.itemId : ""]);

    expect(backend.callsTo("kill").map((call) => call.args[0])).toContain(quick);
    expect(backend.session(quick)?.alive).toBe(false);
    expect(liveSessionIds(store.getState().workspace).has(String(quick))).toBe(false);
  });

  it("saves the workspace with the new tab, without the session", async () => {
    const { backend, store } = await openMain();
    const quick = await backend.createSession({ cols: 80, rows: 24 });
    await promoteQuickSession(store, backend, quick);
    await vi.advanceTimersByTimeAsync(1000);

    const saved = backend.stateContent ?? "";
    expect(saved).not.toBe("");
    // Sessions die with the process, so the file never names one; the tab comes back with a new shell.
    expect(saved).not.toContain("sessionId");
    expect(Object.keys(activeSpaceOf(store.getState().workspace).items)).toHaveLength(2);
    expect((saved.match(/"profileId":"default"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("following the promotions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a request with the tab that was made", async () => {
    const { backend, store } = await openMain();
    const { events, emitted, send } = fakeEvents();
    await followQuickPromotions(events, store, backend);
    const quick = await backend.createSession({ cols: 80, rows: 24 });

    send(QUICK_PROMOTE_EVENT, { id: quick });
    await vi.advanceTimersByTimeAsync(0);

    const tab = tabHolding(store, quick);
    expect(tab).toBeDefined();
    expect(emitted).toEqual([
      { event: QUICK_PROMOTED_EVENT, payload: { id: quick, ok: true, itemId: tab?.id } },
    ]);
  });

  it("answers a request it cannot meet with the reason", async () => {
    const { backend, store } = await openMain();
    const { events, emitted, send } = fakeEvents();
    await followQuickPromotions(events, store, backend);

    send(QUICK_PROMOTE_EVENT, { id: 777 });
    await vi.advanceTimersByTimeAsync(0);

    expect(emitted).toEqual([
      {
        event: QUICK_PROMOTED_EVENT,
        payload: { id: 777, ok: false, reason: "unknown session 777" },
      },
    ]);
  });

  it("ignores a request that does not name a session", async () => {
    const { backend, store } = await openMain();
    const { events, emitted, send } = fakeEvents();
    await followQuickPromotions(events, store, backend);

    for (const bad of [undefined, null, {}, { id: "3" }, { id: 0 }, 3])
      send(QUICK_PROMOTE_EVENT, bad);
    await vi.advanceTimersByTimeAsync(0);

    expect(emitted).toEqual([]);
    expect(backend.callsTo("attachSession")).toEqual([]);
  });

  it("refuses a second request for a session while the first is being promoted", async () => {
    const { backend, store } = await openMain();
    const { events, emitted, send } = fakeEvents();
    await followQuickPromotions(events, store, backend);
    const quick = await backend.createSession({ cols: 80, rows: 24 });
    // The backend takes its time over the first request.
    let finish: () => void = () => undefined;
    const attach = backend.attachSession.bind(backend);
    vi.spyOn(backend, "attachSession").mockImplementationOnce(async (id) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await attach(id);
    });

    send(QUICK_PROMOTE_EVENT, { id: quick });
    send(QUICK_PROMOTE_EVENT, { id: quick });
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted).toEqual([
      {
        event: QUICK_PROMOTED_EVENT,
        payload: { id: quick, ok: false, reason: "that session is already being promoted" },
      },
    ]);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.payload).toMatchObject({ id: quick, ok: true });
    // One tab, one take-over.
    expect(Object.values(activeSpaceOf(store.getState().workspace).items)).toHaveLength(2);
    expect(backend.callsTo("attachSession")).toHaveLength(1);
  });

  it("stops answering once it is stopped", async () => {
    const { backend, store } = await openMain();
    const { events, emitted, send } = fakeEvents();
    const stop = await followQuickPromotions(events, store, backend);
    const quick = await backend.createSession({ cols: 80, rows: 24 });

    stop();
    send(QUICK_PROMOTE_EVENT, { id: quick });
    await vi.advanceTimersByTimeAsync(0);

    expect(emitted).toEqual([]);
    expect(tabHolding(store, quick)).toBeUndefined();
  });
});
