import { FakeBackend, createSequentialIds, layoutPanes, restoreWorkspace } from "@noren/model";
import { describe, expect, it } from "vitest";
import { memoryQuickEvents, QUICK_PROMOTED_EVENT, QUICK_PROMOTE_EVENT } from "./quick";
import type { QuickEvents } from "./quick";
import { followQuickPromotions } from "./quick-promote";
import { PROMOTE_TIMEOUT_MS, createQuickWindowActions } from "./quick-window";
import { activeSpaceOf, createWorkspaceStore } from "./workspace-store";

const clock = { now: () => 1000 };

/** The main window: a store over a fake backend, listening for promotions on `events`. */
async function openMain(events: QuickEvents) {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  await followQuickPromotions(events, store, backend);
  return { backend, store };
}

/** The sessions the tabs of the active space show. */
function shownSessions(store: Awaited<ReturnType<typeof openMain>>["store"]): string[] {
  return Object.values(activeSpaceOf(store.getState().workspace).items).flatMap((item) =>
    layoutPanes(item.layout).flatMap((pane) => (pane.sessionId ? [pane.sessionId] : [])),
  );
}

/** A timer the test moves: `fire()` runs what is due. */
function manualTimer() {
  const pending: { run: () => void; live: boolean }[] = [];
  return {
    after: (_ms: number, run: () => void) => {
      const entry = { run, live: true };
      pending.push(entry);
      return () => {
        entry.live = false;
      };
    },
    fire: () => {
      for (const entry of pending) if (entry.live) entry.run();
    },
    pending: () => pending.filter((entry) => entry.live).length,
  };
}

/** Lets the promise chains of the code under test advance. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("memoryQuickEvents", () => {
  it("delivers an event to whoever listens, stops after the unsubscribe, and keeps events apart", async () => {
    const events = memoryQuickEvents();
    const heard: unknown[] = [];
    const stop = await events.listen("a", (payload) => heard.push(payload));
    await events.emit("a", 1);
    await events.emit("b", 2);
    stop();
    await events.emit("a", 3);
    expect(heard).toEqual([1]);
  });
});

describe("Esc in the quick window", () => {
  it("asks the window to hide, and says so", async () => {
    const hides: string[] = [];
    const actions = createQuickWindowActions({
      events: memoryQuickEvents(),
      hide: async () => {
        hides.push("hide");
      },
    });
    expect(await actions.escape()).toBe(true);
    expect(hides).toEqual(["hide"]);
  });

  it("does not throw when the window refuses to hide", async () => {
    const actions = createQuickWindowActions({
      events: memoryQuickEvents(),
      hide: () => Promise.reject(new Error("no permission")),
    });
    expect(await actions.escape()).toBe(false);
  });
});

describe("promoting the shell of the quick window", () => {
  it("puts the same session in a tab of the active space of the main window, then hides the quick one", async () => {
    // One bus, two windows: the quick window's actions and the main window's listener.
    const events = memoryQuickEvents();
    const { backend, store } = await openMain(events);
    // The shell the quick window opened: a session no tab started.
    const id = await backend.createSession({ cols: 80, rows: 24 });
    const before = shownSessions(store);
    const startedBefore = backend.callsTo("createSession").length;
    const tabsBefore = Object.keys(activeSpaceOf(store.getState().workspace).items).length;
    const hides: string[] = [];
    const actions = createQuickWindowActions({
      events,
      hide: async () => {
        hides.push("hide");
      },
    });

    const result = await actions.promote(id);

    expect(result).toEqual({ ok: true });
    expect(hides).toEqual(["hide"]);
    // A new tab in the space on screen, around that session: the same id, nothing restarted.
    expect(Object.keys(activeSpaceOf(store.getState().workspace).items)).toHaveLength(
      tabsBefore + 1,
    );
    expect(shownSessions(store)).toEqual([...before, String(id)]);
    expect(backend.callsTo("createSession")).toHaveLength(startedBefore);
    expect(backend.callsTo("kill")).toEqual([]);
    expect(backend.callsTo("attachSession").map((call) => call.args[0])).toEqual([id]);
  });

  it("leaves the quick window showing, with the reason, when the main window refuses", async () => {
    const events = memoryQuickEvents();
    const { backend, store } = await openMain(events);
    const id = await backend.createSession({ cols: 80, rows: 24 });
    // A tab already shows it: the second promotion is refused.
    store.getState().adoptSession(String(id));
    const hides: string[] = [];
    const actions = createQuickWindowActions({
      events,
      hide: async () => {
        hides.push("hide");
      },
    });

    const result = await actions.promote(id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already shows/);
    expect(hides).toEqual([]);
  });

  it("refuses a session that does not exist, changing nothing", async () => {
    const events = memoryQuickEvents();
    const { store } = await openMain(events);
    const before = shownSessions(store);
    const hides: string[] = [];
    const actions = createQuickWindowActions({
      events,
      hide: async () => {
        hides.push("hide");
      },
    });
    const result = await actions.promote(404);
    expect(result.ok).toBe(false);
    expect(shownSessions(store)).toEqual(before);
    expect(hides).toEqual([]);
  });

  it("gives up with a reason when the main window never answers, and stops listening", async () => {
    const timer = manualTimer();
    const emitted: string[] = [];
    let listeners = 0;
    const silent: QuickEvents = {
      listen: async () => {
        listeners += 1;
        return () => {
          listeners -= 1;
        };
      },
      emit: async (event) => {
        emitted.push(event);
      },
    };
    const hides: string[] = [];
    const actions = createQuickWindowActions({
      events: silent,
      hide: async () => {
        hides.push("hide");
      },
      after: timer.after,
    });

    const waiting = actions.promote(3);
    await settle();
    // The request went out once the answer was being listened for.
    expect(emitted).toEqual([QUICK_PROMOTE_EVENT]);
    expect(timer.pending()).toBe(1);
    timer.fire();

    expect(await waiting).toEqual({ ok: false, reason: "the main window did not answer" });
    expect(PROMOTE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(hides).toEqual([]);
    expect(listeners).toBe(0);
    expect(timer.pending()).toBe(0);
  });

  it("listens before it asks, so an answer that comes back at once is not missed", async () => {
    const order: string[] = [];
    const events = memoryQuickEvents();
    const echoing: QuickEvents = {
      listen: async (event, handler) => {
        order.push(`listen ${event}`);
        return events.listen(event, handler);
      },
      emit: async (event, payload) => {
        order.push(`emit ${event}`);
        // The main window answers in the same breath.
        await events.emit(QUICK_PROMOTED_EVENT, { id: 9, ok: true, itemId: "x" });
        await events.emit(event, payload);
      },
    };
    const actions = createQuickWindowActions({ events: echoing, hide: async () => undefined });
    expect(await actions.promote(9)).toEqual({ ok: true });
    expect(order).toEqual([`listen ${QUICK_PROMOTED_EVENT}`, `emit ${QUICK_PROMOTE_EVENT}`]);
  });

  it("ignores the answer about another session", async () => {
    const timer = manualTimer();
    const events = memoryQuickEvents();
    const actions = createQuickWindowActions({
      events,
      hide: async () => undefined,
      after: timer.after,
    });
    const waiting = actions.promote(5);
    await settle();
    await events.emit(QUICK_PROMOTED_EVENT, { id: 6, ok: true });
    timer.fire();
    expect(await waiting).toEqual({ ok: false, reason: "the main window did not answer" });
  });

  it("sends one request when the button is pressed twice", async () => {
    const events = memoryQuickEvents();
    const requests: unknown[] = [];
    await events.listen(QUICK_PROMOTE_EVENT, (payload) => requests.push(payload));
    const timer = manualTimer();
    const actions = createQuickWindowActions({
      events,
      hide: async () => undefined,
      after: timer.after,
    });
    const first = actions.promote(2);
    await settle();
    const second = await actions.promote(2);
    expect(second).toEqual({ ok: false, reason: "the shell is already being promoted" });
    timer.fire();
    await first;
    expect(requests).toEqual([{ id: 2 }]);
  });
});
