import { describe, expect, it } from "vitest";
import { PEEK_DELAY_MS, PeekController } from "./peek-controller";
import type { PeekTimers } from "./peek-controller";

/** Timers the test moves by hand. */
class ManualTimers implements PeekTimers {
  now = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; run: () => void }>();

  set(run: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, run });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get count(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    const to = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= to)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].run();
    }
    this.now = to;
  }
}

function setup() {
  const timers = new ManualTimers();
  const events: string[] = [];
  const controller = new PeekController({
    timers,
    onShow: (id) => events.push(`show ${id}`),
    onHide: () => events.push("hide"),
  });
  return { timers, events, controller };
}

describe("when the peek of a tab opens", () => {
  it("opens after the pointer stays 400 ms, and not before", () => {
    const { timers, events, controller } = setup();
    expect(PEEK_DELAY_MS).toBe(400);
    controller.enter("a");
    timers.advance(399);
    expect(events).toEqual([]);
    expect(controller.shown).toBeUndefined();
    timers.advance(1);
    expect(events).toEqual(["show a"]);
    expect(controller.shown).toBe("a");
  });

  it("does not open when the pointer leaves first", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(300);
    controller.leave("a");
    timers.advance(1000);
    expect(events).toEqual([]);
    expect(timers.count).toBe(0);
  });

  it("starts the wait again when the pointer moves on the tab, so it opens 400 ms after the last move", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(300);
    controller.move("a");
    timers.advance(300);
    expect(events).toEqual([]);
    timers.advance(100);
    expect(events).toEqual(["show a"]);
  });

  it("keeps an open peek open while the pointer moves on its tab", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(400);
    controller.move("a");
    timers.advance(1000);
    expect(events).toEqual(["show a"]);
  });

  it("closes when the pointer leaves the tab", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(400);
    controller.leave("a");
    expect(events).toEqual(["show a", "hide"]);
    expect(controller.shown).toBeUndefined();
  });

  it("ignores the pointer leaving a tab it was not on", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(400);
    controller.leave("b");
    expect(controller.shown).toBe("a");
    expect(events).toEqual(["show a"]);
  });

  it("moves from one tab to the next: the first closes and the second waits its own 400 ms", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(400);
    controller.leave("a");
    controller.enter("b");
    timers.advance(399);
    expect(events).toEqual(["show a", "hide"]);
    timers.advance(1);
    expect(events).toEqual(["show a", "hide", "show b"]);
  });

  it("enters another tab without leaving the first: the first closes", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(400);
    controller.enter("b");
    expect(events).toEqual(["show a", "hide"]);
    timers.advance(400);
    expect(events).toEqual(["show a", "hide", "show b"]);
  });

  it("closes on a click or a key, and cancels a peek that was due", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(100);
    controller.close();
    timers.advance(1000);
    expect(events).toEqual([]);
    controller.enter("a");
    timers.advance(400);
    controller.close();
    expect(events).toEqual(["show a", "hide"]);
    controller.close();
    expect(events).toEqual(["show a", "hide"]);
  });

  it("does not open during a drag, closes the one that is up, and waits for the pointer to move after", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(400);
    controller.dragStart();
    expect(events).toEqual(["show a", "hide"]);
    controller.enter("b");
    controller.move("b");
    timers.advance(2000);
    expect(events).toEqual(["show a", "hide"]);
    controller.dragEnd();
    timers.advance(2000);
    expect(events).toEqual(["show a", "hide"]);
    controller.move("b");
    timers.advance(400);
    expect(events).toEqual(["show a", "hide", "show b"]);
  });

  it("drops a wait that was due when a drag starts", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    timers.advance(200);
    controller.dragStart();
    controller.dragEnd();
    timers.advance(2000);
    expect(events).toEqual([]);
  });

  it("leaves nothing pending after dispose", () => {
    const { timers, events, controller } = setup();
    controller.enter("a");
    controller.dispose();
    timers.advance(1000);
    expect(events).toEqual([]);
    expect(timers.count).toBe(0);
  });
});
