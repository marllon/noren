import { FakeBackend } from "@noren/model";
import { describe, expect, it } from "vitest";
import { memoryQuickEvents, windowKindOf } from "./quick";
import type { QuickEvents } from "./quick";
import {
  WINDOW_READY_EVENT,
  WINDOW_TAKEN_EVENT,
  WINDOW_TAKE_EVENT,
  followTakes,
  requestOfPayload,
  sessionsOfPayload,
  windowIdOfPayload,
} from "./window-events";

/** The bus of one page plus a list of everything that went through it, for the checks. */
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

/** Lets the take that is queued run to its end. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("windowKindOf", () => {
  it("tells the other windows from the main one and the quick one", () => {
    expect(windowKindOf("window-3f2b")).toBe("window");
    expect(windowKindOf("window-w1")).toBe("window");
    expect(windowKindOf("main")).toBe("main");
    expect(windowKindOf("quick")).toBe("quick");
  });

  it("sends a label that names no window to the main page, which is the page a browser gets too", () => {
    for (const label of [
      "window-",
      "window-a b",
      "windows-w1",
      "Window-w1",
      "browser-p1",
      "",
      undefined,
    ]) {
      expect(windowKindOf(label), String(label)).toBe("main");
    }
  });
});

describe("what an event can carry", () => {
  it("names a window only with a window id", () => {
    expect(windowIdOfPayload({ windowId: "w1" })).toBe("w1");
    for (const payload of [
      null,
      undefined,
      "w1",
      3,
      {},
      { windowId: 1 },
      { windowId: "a b" },
      { windowId: "" },
    ]) {
      expect(windowIdOfPayload(payload), JSON.stringify(payload)).toBeUndefined();
    }
  });

  it("lists sessions only as whole positive numbers, once each, or not at all", () => {
    expect(sessionsOfPayload({ ids: [3, 4, 3] })).toEqual([3, 4]);
    expect(sessionsOfPayload({ ids: [] })).toEqual([]);
    for (const payload of [
      null,
      {},
      { ids: "3" },
      { ids: [0] },
      { ids: [-1] },
      { ids: [1.5] },
      { ids: ["3"] },
      { ids: [3, null] },
      { ids: [Number.MAX_SAFE_INTEGER + 2] },
    ]) {
      expect(sessionsOfPayload(payload), JSON.stringify(payload)).toBeUndefined();
    }
  });
});

describe("the number of a request", () => {
  it("is a whole number the payload carries, and nothing else", () => {
    expect(requestOfPayload({ request: 4 })).toBe(4);
    for (const payload of [
      null,
      {},
      { request: "4" },
      { request: 1.5 },
      { request: Infinity },
      "4",
    ]) {
      expect(requestOfPayload(payload), JSON.stringify(payload)).toBeUndefined();
    }
  });
});

describe("followTakes", () => {
  it("says it is ready once it listens, and the take that follows is answered after the sessions are here", async () => {
    const { events, heard } = recordingEvents();
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    const taken: number[][] = [];
    await followTakes(events, backend, "w1", (ids) => taken.push(ids));
    expect(heard).toEqual([{ event: WINDOW_READY_EVENT, payload: { windowId: "w1" } }]);

    await events.emit(WINDOW_TAKE_EVENT, { windowId: "w1", request: 7, ids: [id] });
    await settle();
    expect(backend.callsTo("attachSession").map((call) => call.args)).toEqual([[id]]);
    expect(taken).toEqual([[id]]);
    // The answer carries the number of the request it answers.
    expect(heard.at(-1)).toEqual({
      event: WINDOW_TAKEN_EVENT,
      payload: { windowId: "w1", request: 7, ok: true, ids: [id] },
    });
  });

  it("leaves the takes of another window to that window", async () => {
    const { events, heard } = recordingEvents();
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await followTakes(events, backend, "w1", () => undefined);
    await events.emit(WINDOW_TAKE_EVENT, { windowId: "w2", ids: [id] });
    await events.emit(WINDOW_TAKE_EVENT, { ids: [id] });
    await settle();
    expect(backend.callsTo("attachSession")).toEqual([]);
    expect(heard.filter((h) => h.event === WINDOW_TAKEN_EVENT)).toEqual([]);
  });

  it("answers a session that is gone with the reason and the ones it took before it", async () => {
    const { events, heard } = recordingEvents();
    const backend = new FakeBackend();
    const live = await backend.createSession({ cols: 80, rows: 24 });
    const taken: number[][] = [];
    await followTakes(events, backend, "w1", (ids) => taken.push(ids));
    await events.emit(WINDOW_TAKE_EVENT, {
      windowId: "w1",
      request: 2,
      ids: [live, 999, live + 100],
    });
    await settle();
    expect(taken).toEqual([[live]]);
    expect(heard.at(-1)).toEqual({
      event: WINDOW_TAKEN_EVENT,
      payload: {
        windowId: "w1",
        request: 2,
        ok: false,
        ids: [live],
        reason: "unknown session 999",
      },
    });
    // It stopped at the first refusal: the session after it was not tried.
    expect(backend.callsTo("attachSession").map((call) => call.args)).toEqual([[live], [999]]);
  });

  it("refuses an event whose list of sessions is not one, and answers it", async () => {
    const { events, heard } = recordingEvents();
    const backend = new FakeBackend();
    await followTakes(events, backend, "w1", () => undefined);
    await events.emit(WINDOW_TAKE_EVENT, { windowId: "w1", request: 5, ids: ["3"] });
    await settle();
    expect(backend.callsTo("attachSession")).toEqual([]);
    expect(heard.at(-1)).toEqual({
      event: WINDOW_TAKEN_EVENT,
      payload: {
        windowId: "w1",
        request: 5,
        ok: false,
        ids: [],
        reason: "the event does not carry a list of sessions",
      },
    });
  });

  it("takes two requests one after the other, in the order they came", async () => {
    const { events } = recordingEvents();
    const backend = new FakeBackend();
    const a = await backend.createSession({ cols: 80, rows: 24 });
    const b = await backend.createSession({ cols: 80, rows: 24 });
    const order: string[] = [];
    const attach = backend.attachSession.bind(backend);
    backend.attachSession = async (id) => {
      order.push(`start ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await attach(id);
      order.push(`end ${id}`);
    };
    await followTakes(events, backend, "w1", () => undefined);
    await events.emit(WINDOW_TAKE_EVENT, { windowId: "w1", ids: [a] });
    await events.emit(WINDOW_TAKE_EVENT, { windowId: "w1", ids: [b] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual([`start ${a}`, `end ${a}`, `start ${b}`, `end ${b}`]);
  });

  it("stops listening when told to", async () => {
    const { events } = recordingEvents();
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    const stop = await followTakes(events, backend, "w1", () => undefined);
    stop();
    await events.emit(WINDOW_TAKE_EVENT, { windowId: "w1", ids: [id] });
    await settle();
    expect(backend.callsTo("attachSession")).toEqual([]);
  });
});
