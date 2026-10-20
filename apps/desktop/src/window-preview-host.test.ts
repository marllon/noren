import { FakeBackend } from "@noren/model";
import { describe, expect, it } from "vitest";
import { memoryQuickEvents } from "./quick";
import { WINDOW_READY_EVENT, WINDOW_TAKEN_EVENT, WINDOW_TAKE_EVENT } from "./window-events";
import { WindowPreviewHost } from "./window-preview-host";
import { WINDOW_EDGE_MARGIN, leavesWindow } from "./sidebar-drop";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("WindowPreviewHost", () => {
  it("lists the windows the backend opens and closes, as a new list each time", async () => {
    const events = memoryQuickEvents();
    const host = new WindowPreviewHost(events);
    const backend = new FakeBackend();
    backend.setWindowHost(host);
    const heard: number[] = [];
    const stop = host.subscribe(() => heard.push(host.snapshot().length));
    const empty = host.snapshot();
    await backend.openWindow("w1", "s1");
    await backend.openWindow("w2", "s2");
    expect(host.snapshot()).toEqual([
      { id: "w1", spaceId: "s1" },
      { id: "w2", spaceId: "s2" },
    ]);
    expect(host.snapshot()).not.toBe(empty);
    await backend.closeWindow("w1");
    backend.closeWindowByPerson("w2");
    expect(host.snapshot()).toEqual([]);
    expect(heard).toEqual([1, 2, 1, 0]);
    stop();
  });

  it("waits for the page of the window, asks it to take the sessions and waits for its answer", async () => {
    const events = memoryQuickEvents();
    const host = new WindowPreviewHost(events);
    const backend = new FakeBackend();
    backend.setWindowHost(host);
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.openWindow("w1", "s1");
    const asked: unknown[] = [];
    await events.listen(WINDOW_TAKE_EVENT, (payload) => {
      asked.push(payload);
      const request = (payload as { request: number }).request;
      void events.emit(WINDOW_TAKEN_EVENT, { windowId: "w1", request, ok: true, ids: [id] });
    });
    let done = false;
    const moving = backend.moveTabToWindow("w1", [id]).then(() => {
      done = true;
    });
    await settle();
    // The page has not said it is ready: nothing was asked yet.
    expect(asked).toEqual([]);
    expect(done).toBe(false);
    await events.emit(WINDOW_READY_EVENT, { windowId: "w1" });
    await moving;
    expect(asked).toEqual([{ windowId: "w1", request: 1, ids: [id] }]);
    expect(backend.windowOfSession(id)).toBe("w1");
  });

  it("fails the move with the reason of a page that refuses, and ignores answers meant for other requests", async () => {
    const events = memoryQuickEvents();
    const host = new WindowPreviewHost(events);
    const backend = new FakeBackend();
    backend.setWindowHost(host);
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.openWindow("w1", "s1");
    await events.emit(WINDOW_READY_EVENT, { windowId: "w1" });
    await events.listen(WINDOW_TAKE_EVENT, (payload) => {
      const request = (payload as { request: number }).request;
      // An answer for another window and for another request first, then the real one.
      void events.emit(WINDOW_TAKEN_EVENT, { windowId: "w2", request, ok: true, ids: [] });
      void events.emit(WINDOW_TAKEN_EVENT, { windowId: "w1", request: request + 1, ok: true });
      void events.emit(WINDOW_TAKEN_EVENT, {
        windowId: "w1",
        request,
        ok: false,
        ids: [],
        reason: "the session is gone",
      });
    });
    await expect(backend.moveTabToWindow("w1", [id])).rejects.toThrow("the session is gone");
    expect(backend.windowOfSession(id)).toBeUndefined();
  });
});

describe("leavesWindow", () => {
  const area = { width: 1000, height: 600 };

  it("is true only past the edge of the page by more than the margin", () => {
    expect(leavesWindow({ x: 500, y: 300 }, area)).toBe(false);
    expect(leavesWindow({ x: 0, y: 0 }, area)).toBe(false);
    expect(leavesWindow({ x: 999, y: 599 }, area)).toBe(false);
    // On the edge and a little past it is still the window: a tab let go at the top is not torn off.
    expect(leavesWindow({ x: -WINDOW_EDGE_MARGIN, y: 300 }, area)).toBe(false);
    expect(leavesWindow({ x: 1000 + WINDOW_EDGE_MARGIN - 1, y: 300 }, area)).toBe(false);
    expect(leavesWindow({ x: 500, y: 600 + WINDOW_EDGE_MARGIN - 1 }, area)).toBe(false);
    expect(leavesWindow({ x: -WINDOW_EDGE_MARGIN - 1, y: 300 }, area)).toBe(true);
    expect(leavesWindow({ x: 500, y: -WINDOW_EDGE_MARGIN - 1 }, area)).toBe(true);
    expect(leavesWindow({ x: 1000 + WINDOW_EDGE_MARGIN, y: 300 }, area)).toBe(true);
    expect(leavesWindow({ x: 500, y: 600 + WINDOW_EDGE_MARGIN }, area)).toBe(true);
  });
});
