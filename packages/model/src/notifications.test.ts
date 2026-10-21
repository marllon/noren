import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock";
import { FakeBackend } from "./fake-backend";
import { DEFAULT_NOTIFICATION_SETTINGS, SystemNotifier, decideNotification } from "./notifications";
import type { NotificationContext, SystemNotificationEvent } from "./notifications";

const bell: SystemNotificationEvent = { kind: "attention", attention: { kind: "bell" } };
const message = (body: string, title?: string): SystemNotificationEvent => ({
  kind: "attention",
  attention: { kind: "notification", body, ...(title !== undefined ? { title } : {}) },
});
const ended = (durationMs: number | undefined, exitCode?: number, text?: string) =>
  ({
    kind: "command-end",
    command: {
      kind: "end",
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(text !== undefined ? { text } : {}),
    },
  }) satisfies SystemNotificationEvent;

const context = (over: Partial<NotificationContext> = {}): NotificationContext => ({
  windowFocused: true,
  paneVisible: true,
  settings: DEFAULT_NOTIFICATION_SETTINGS,
  ...over,
});

describe("decideNotification: attention", () => {
  it("a window in focus does not notify", () => {
    expect(decideNotification(bell, context({ paneVisible: false }))).toBeUndefined();
    expect(decideNotification(message("hi"), context({ paneVisible: false }))).toBeUndefined();
  });

  it("a window out of focus notifies, whether or not the pane is on screen", () => {
    for (const paneVisible of [true, false]) {
      const unfocused = context({ windowFocused: false, paneVisible });
      expect(decideNotification(bell, unfocused)).toEqual({ title: "Noren", body: "Bell" });
    }
  });

  it("names the tab, and the program's own title wins over it", () => {
    const unfocused = context({ windowFocused: false, tabTitle: "api" });
    expect(decideNotification(bell, unfocused)).toEqual({ title: "api", body: "Bell" });
    expect(decideNotification(message("Done"), unfocused)).toEqual({ title: "api", body: "Done" });
    expect(decideNotification(message("Done", "Agent"), unfocused)).toEqual({
      title: "Agent",
      body: "Done",
    });
  });

  it("an empty title or tab name falls back to the app name", () => {
    const unfocused = context({ windowFocused: false, tabTitle: "" });
    expect(decideNotification(message("Done", ""), unfocused)).toEqual({
      title: "Noren",
      body: "Done",
    });
  });

  it("turned off, nothing notifies", () => {
    const off = context({
      windowFocused: false,
      settings: { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false },
    });
    expect(decideNotification(bell, off)).toBeUndefined();
    expect(decideNotification(ended(120_000), off)).toBeUndefined();
  });

  it("keeps the text plain and short", () => {
    const unfocused = context({ windowFocused: false });
    const long = decideNotification(
      message(`a\n\t b ${"x".repeat(500)}`, "t".repeat(200)),
      unfocused,
    );
    expect(long?.title).toHaveLength(80);
    expect(long?.body).toHaveLength(200);
    expect(long?.body.startsWith("a b xxx")).toBe(true);
    expect(long?.body.endsWith("…")).toBe(true);
  });
});

describe("decideNotification: long commands", () => {
  const away = context({ paneVisible: false });

  it("31 s in a tab out of sight notifies; 29 s and exactly 30 s do not", () => {
    expect(decideNotification(ended(31_000, 0, "make"), away)).toEqual({
      title: "Command finished",
      body: "make finished after 31s",
    });
    expect(decideNotification(ended(29_000, 0, "make"), away)).toBeUndefined();
    expect(decideNotification(ended(30_000, 0, "make"), away)).toBeUndefined();
  });

  it("a command on screen with the window in focus does not notify, however long", () => {
    expect(decideNotification(ended(3_600_000), context())).toBeUndefined();
  });

  it("a command on screen of a window out of focus does notify", () => {
    expect(decideNotification(ended(40_000), context({ windowFocused: false }))).toBeDefined();
  });

  it("says that the command failed, with its code, and where", () => {
    expect(decideNotification(ended(65_000, 127, "nope"), { ...away, tabTitle: "api" })).toEqual({
      title: "Command failed in api",
      body: "nope failed (exit 127) after 1m 05s",
    });
  });

  it("works without the line and with the limit of the settings", () => {
    expect(decideNotification(ended(5000), away)).toBeUndefined();
    const short = { ...away, settings: { enabled: true, longCommandMs: 4000 } };
    expect(decideNotification(ended(5000), short)).toEqual({
      title: "Command finished",
      body: "A command finished after 5s",
    });
  });

  it("a command with no known duration never notifies", () => {
    expect(decideNotification(ended(undefined, 0, "make"), away)).toBeUndefined();
  });

  it("long durations read in minutes and hours", () => {
    const body = (ms: number) => decideNotification(ended(ms, 0, "x"), away)?.body;
    expect(body(3_725_000)).toBe("x finished after 1h 02m");
    expect(body(600_000)).toBe("x finished after 10m 00s");
  });
});

describe("SystemNotifier", () => {
  function setup(settings = DEFAULT_NOTIFICATION_SETTINGS) {
    const backend = new FakeBackend();
    const clock = new ManualClock();
    const errors: unknown[] = [];
    let visible = false;
    const notifier = new SystemNotifier({
      backend,
      clock,
      settings: () => settings,
      onError: (error) => errors.push(error),
    });
    const source = (paneId = "p1") => ({
      paneId,
      paneVisible: () => visible,
      tabTitle: () => undefined,
    });
    return {
      backend,
      clock,
      errors,
      notifier,
      source,
      show: (value: boolean) => {
        visible = value;
      },
    };
  }

  it("asks the backend for the focus and sends nothing while the window has it", async () => {
    const { backend, notifier, source } = setup();
    expect(await notifier.report(bell, source())).toBe(false);
    expect(backend.callsTo("isWindowFocused")).toHaveLength(1);
    expect(backend.notifications).toEqual([]);
  });

  it("sends once the window loses the focus", async () => {
    const { backend, notifier, source } = setup();
    backend.setWindowFocused(false);
    expect(await notifier.report(bell, source())).toBe(true);
    expect(backend.callsTo("notify")).toEqual([{ method: "notify", args: ["Noren", "Bell"] }]);
  });

  it("does not ask the backend anything when the notifications are off", async () => {
    const { backend, notifier, source } = setup({ enabled: false, longCommandMs: 30_000 });
    backend.setWindowFocused(false);
    expect(await notifier.report(bell, source())).toBe(false);
    expect(backend.calls).toEqual([]);
  });

  it("holds back the same words of the same pane until the guard time has passed", async () => {
    const { backend, clock, notifier, source } = setup();
    backend.setWindowFocused(false);
    expect(await notifier.report(bell, source())).toBe(true);
    expect(await notifier.report(bell, source())).toBe(false);
    // Another pane, and other words, are other events.
    expect(await notifier.report(bell, source("p2"))).toBe(true);
    expect(await notifier.report(message("hi"), source())).toBe(true);
    clock.advance(2999);
    expect(await notifier.report(bell, source())).toBe(false);
    clock.advance(1);
    expect(await notifier.report(bell, source())).toBe(true);
    expect(backend.notifications).toHaveLength(4);
  });

  it("reads where the pane is after the focus is known", async () => {
    const { backend, notifier, source, show } = setup();
    // Focus answers false, and by then the pane is on screen: the long command is still reported,
    // because the window is out of focus.
    backend.setWindowFocused(false);
    show(true);
    expect(await notifier.report(ended(40_000), source())).toBe(true);
    backend.setWindowFocused(true);
    expect(await notifier.report(ended(41_000), source())).toBe(false);
    show(false);
    expect(await notifier.report(ended(42_000), source())).toBe(true);
  });

  it("never rejects: a refusal goes to the error hook and is not held against the next try", async () => {
    const { backend, errors, notifier, source } = setup();
    backend.setWindowFocused(false);
    backend.setNotifyFailure(new Error("refused"));
    expect(await notifier.report(bell, source())).toBe(false);
    expect(errors).toHaveLength(1);
    backend.setNotifyFailure(undefined);
    expect(await notifier.report(bell, source())).toBe(true);
  });

  it("survives a backend that cannot tell the focus", async () => {
    const { backend, errors, notifier, source } = setup();
    backend.isWindowFocused = () => Promise.reject(new Error("no window"));
    expect(await notifier.report(bell, source())).toBe(false);
    expect(errors).toHaveLength(1);
  });

  describe("send (a notification asked for on purpose, as by the local API)", () => {
    it("sends it with the window in focus, since it was asked for", async () => {
      const { backend, notifier } = setup();
      expect(backend.callsTo("isWindowFocused")).toHaveLength(0);
      expect(await notifier.send({ title: "Build done", body: "all green" }, "p1")).toBe(true);
      expect(backend.callsTo("notify")).toEqual([
        { method: "notify", args: ["Build done", "all green"] },
      ]);
      // It did not even ask for the focus.
      expect(backend.callsTo("isWindowFocused")).toHaveLength(0);
    });

    it("sends nothing and does not touch the backend when the user turned notifications off", async () => {
      const { backend, notifier } = setup({ enabled: false, longCommandMs: 30_000 });
      expect(await notifier.send({ title: "Build done", body: "" }, "p1")).toBe(false);
      expect(backend.calls).toEqual([]);
    });

    it("reads the settings at every call, so turning them off takes effect at once", async () => {
      const backend = new FakeBackend();
      let enabled = true;
      const notifier = new SystemNotifier({
        backend,
        settings: () => ({ enabled, longCommandMs: 30_000 }),
      });
      expect(await notifier.send({ title: "One", body: "" }, "p1")).toBe(true);
      enabled = false;
      expect(await notifier.send({ title: "Two", body: "" }, "p1")).toBe(false);
      expect(backend.notifications).toHaveLength(1);
    });

    it("cuts the words like the other notifications", async () => {
      const { backend, notifier } = setup();
      await notifier.send({ title: "t".repeat(300), body: `${"b ".repeat(400)}` }, "p1");
      const [title, body] = backend.callsTo("notify")[0]?.args as [string, string];
      expect(title.length).toBeLessThanOrEqual(80);
      expect(body.length).toBeLessThanOrEqual(200);
      expect(title.endsWith("…")).toBe(true);
    });

    it("holds the same words of the same pane back, like a report", async () => {
      const { backend, clock, notifier } = setup();
      expect(await notifier.send({ title: "Same", body: "" }, "p1")).toBe(true);
      expect(await notifier.send({ title: "Same", body: "" }, "p1")).toBe(false);
      expect(await notifier.send({ title: "Same", body: "" }, "p2")).toBe(true);
      clock.advance(3000);
      expect(await notifier.send({ title: "Same", body: "" }, "p1")).toBe(true);
      expect(backend.notifications).toHaveLength(3);
    });

    it("never rejects: a refusal goes to the error hook and is not held against the next try", async () => {
      const { backend, errors, notifier } = setup();
      backend.setNotifyFailure(new Error("refused"));
      expect(await notifier.send({ title: "Refused", body: "" }, "p1")).toBe(false);
      expect(errors).toHaveLength(1);
      backend.setNotifyFailure(undefined);
      expect(await notifier.send({ title: "Refused", body: "" }, "p1")).toBe(true);
    });
  });
});
