import { describe, expect, it } from "vitest";
import { RESUME_QUIET_MS, ResumeService } from "./resume-service";
import type { ResumeTimers } from "./resume-service";

const bytes = (text: string) => new TextEncoder().encode(text);

/** Timers the test moves by hand. */
class ManualTimers implements ResumeTimers {
  now = 0;
  #next = 1;
  readonly #pending = new Map<number, { at: number; run: () => void }>();
  set(run: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#pending.set(id, { at: this.now + ms, run });
    return id;
  }
  clear(handle: unknown): void {
    this.#pending.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.#pending]) {
      if (timer.at <= this.now) {
        this.#pending.delete(id);
        timer.run();
      }
    }
  }
  get count(): number {
    return this.#pending.size;
  }
}

function setup() {
  const timers = new ManualTimers();
  const service = new ResumeService({ timers });
  const sent: string[] = [];
  const arm = (paneId: string) => service.arm(paneId, () => sent.push(paneId));
  return { timers, service, sent, arm };
}

describe("ResumeService", () => {
  it("sends once, at the first prompt of the shell", () => {
    const { service, sent, arm } = setup();
    arm("p1");
    service.feed("p1", bytes("Welcome\r\n"));
    expect(sent).toEqual([]);
    service.feed("p1", bytes("\x1b]133;A\x07fake$ "));
    expect(sent).toEqual(["p1"]);
    service.feed("p1", bytes("\x1b]133;A\x07fake$ "));
    service.feed("p1", bytes("more"));
    expect(sent).toEqual(["p1"]);
    expect(service.waiting()).toEqual([]);
  });

  it("sends when the mark of the prompt comes in the very first chunk", () => {
    const { service, sent, arm, timers } = setup();
    arm("p1");
    service.feed("p1", bytes("\x1b]7;file:///x\x07\x1b]133;A\x07$ "));
    expect(sent).toEqual(["p1"]);
    expect(timers.count).toBe(0);
  });

  it("does not wait for the quiet time once the prompt has shown", () => {
    const { service, sent, arm, timers } = setup();
    arm("p1");
    service.feed("p1", bytes("banner"));
    expect(timers.count).toBe(1);
    service.feed("p1", bytes("\x1b]133;A\x07$ "));
    expect(sent).toEqual(["p1"]);
    expect(timers.count).toBe(0);
    timers.advance(RESUME_QUIET_MS * 5);
    expect(sent).toEqual(["p1"]);
  });

  it("for a shell with no integration, sends once its first output has gone quiet", () => {
    const { service, sent, arm, timers } = setup();
    arm("p1");
    timers.advance(RESUME_QUIET_MS * 5);
    expect(sent).toEqual([]);
    service.feed("p1", bytes("Microsoft Windows\r\n"));
    timers.advance(RESUME_QUIET_MS - 1);
    expect(sent).toEqual([]);
    // More output restarts the wait.
    service.feed("p1", bytes("C:\\work>"));
    timers.advance(RESUME_QUIET_MS - 1);
    expect(sent).toEqual([]);
    timers.advance(1);
    expect(sent).toEqual(["p1"]);
    timers.advance(RESUME_QUIET_MS * 5);
    service.feed("p1", bytes("more"));
    expect(sent).toEqual(["p1"]);
  });

  it("sends nothing before the shell has printed anything", () => {
    const { sent, arm, timers } = setup();
    arm("p1");
    timers.advance(60_000);
    expect(sent).toEqual([]);
  });

  it("keeps the panes apart", () => {
    const { service, sent, arm } = setup();
    arm("p1");
    arm("p2");
    service.feed("p2", bytes("\x1b]133;A\x07"));
    expect(sent).toEqual(["p2"]);
    service.feed("p3", bytes("\x1b]133;A\x07"));
    expect(sent).toEqual(["p2"]);
    expect(service.waiting()).toEqual(["p1"]);
  });

  it("sends nothing for a pane the person typed in first, or that went away", () => {
    const { service, sent, arm, timers } = setup();
    arm("p1");
    arm("p2");
    service.feed("p2", bytes("banner"));
    service.cancel("p1");
    service.cancel("p2");
    service.cancel("p9");
    service.feed("p1", bytes("\x1b]133;A\x07"));
    service.feed("p2", bytes("\x1b]133;A\x07"));
    timers.advance(RESUME_QUIET_MS * 5);
    expect(sent).toEqual([]);
    expect(timers.count).toBe(0);
  });

  it("arming a pane again replaces the first wait", () => {
    const { service, sent, timers } = setup();
    service.arm("p1", () => sent.push("first"));
    service.feed("p1", bytes("banner"));
    service.arm("p1", () => sent.push("second"));
    expect(timers.count).toBe(0);
    service.feed("p1", bytes("\x1b]133;A\x07"));
    expect(sent).toEqual(["second"]);
  });

  it("a pane that was not armed costs nothing", () => {
    const { service, timers } = setup();
    service.feed("p1", bytes("hello"));
    expect(timers.count).toBe(0);
    expect(service.waiting()).toEqual([]);
  });
});
