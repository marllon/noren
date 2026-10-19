import {
  FakeBackend,
  ManualClock,
  PaneLocationTracker,
  SystemNotifier,
  DEFAULT_NOTIFICATION_SETTINGS,
  createSequentialIds,
  layoutPanes,
  restoreWorkspace,
} from "@noren/model";

import type { Id, Item, NotificationSettings } from "@noren/model";
import { beforeEach, describe, expect, it } from "vitest";

import { createWorkspaceStore, activeItemIdOf, activeSpaceOf } from "./workspace-store";

const BEL = "\x07";
const osc = (body: string): string => `\x1b]${body}${BEL}`;
let now = 1000;
const clock = { now: () => now };

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

/** Lets the notifier (it awaits the backend) finish what it started. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * The wiring of the app, with the fake backend in the place of the system: the output of a session
 * goes through a tracker, whose events reach the store, which hands them to the notifier, which
 * asks the backend. Two tabs in one space; the first one is shown. `send` makes the program of a
 * pane print `text`.
 */
async function setup(settings: () => NotificationSettings = () => DEFAULT_NOTIFICATION_SETTINGS) {
  const shellClock = new ManualClock();
  const backend = new FakeBackend({ clock: shellClock });
  const errors: unknown[] = [];
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({
    backend,
    workspace: restored.workspace,
    newId,
    clock,
    notifier: new SystemNotifier({
      backend,
      clock,
      settings,
      onError: (error) => errors.push(error),
    }),
  });
  store.getState().newTab();
  const sessions = new Map<Id, number>();
  for (const item of Object.values(activeSpaceOf(store.getState().workspace).items)) {
    for (const pane of layoutPanes(item.layout)) {
      const id = await backend.createSession({ cols: 80, rows: 24 });
      store.getState().attachSession(pane.id, String(id));
      const tracker = new PaneLocationTracker({
        gitInfo: () => Promise.resolve(null),
        onLocation: () => undefined,
        onCommand: (event) => store.getState().setPaneCommand(pane.id, event),
        onAttention: (event) => store.getState().notifyPane(pane.id, event),
        clock: shellClock,
      });
      backend.onOutput(id, (bytes) => tracker.feed(bytes));
      sessions.set(pane.id, id);
    }
  }
  const items = Object.values(activeSpaceOf(store.getState().workspace).items);
  const shownId = must(activeItemIdOf(store.getState()), "active tab");
  const shown = must(
    items.find((item) => item.id === shownId),
    "shown tab",
  );
  const background = must(
    items.find((item) => item.id !== shownId),
    "background tab",
  );
  const firstPane = (item: Item): Id => must(layoutPanes(item.layout)[0], "pane").id;
  const send = (paneId: Id, text: string): void =>
    backend.sendOutput(must(sessions.get(paneId), `session of ${paneId}`), text);
  /** Runs a command in a pane that lasts `seconds` on the shell clock. */
  const runCommand = (paneId: Id, line: string, seconds: number, exit = 0): void => {
    send(paneId, osc(`633;E;${line}`) + osc("133;C"));
    shellClock.advance(seconds * 1000);
    send(paneId, osc(`133;D;${exit}`));
  };
  return {
    backend,
    store,
    errors,
    shownPane: firstPane(shown),
    backgroundPane: firstPane(background),
    backgroundItem: background.id,
    send,
    runCommand,
  };
}

describe("system notifications in the store", () => {
  beforeEach(() => {
    now = 1000;
  });

  it("a bell in the background with the window in focus marks the tab and notifies nobody", async () => {
    const { backend, store, send, backgroundPane } = await setup();
    send(backgroundPane, BEL);
    await settle();
    expect(backend.notifications).toEqual([]);
    expect(backend.callsTo("notify")).toHaveLength(0);
    const marked = Object.values(activeSpaceOf(store.getState().workspace).items).flatMap((item) =>
      layoutPanes(item.layout),
    );
    expect(marked.filter((pane) => pane.bell)).toHaveLength(1);
  });

  it("a bell with the window out of focus notifies, with the title of the tab", async () => {
    const { backend, store, send, backgroundPane, backgroundItem } = await setup();
    store.getState().dispatch({ type: "item/rename", itemId: backgroundItem, title: "Build" });
    backend.setWindowFocused(false);
    send(backgroundPane, BEL);
    await settle();
    expect(backend.notifications).toEqual([{ title: "Build", body: "Bell" }]);
  });

  it("a bell in the tab on screen notifies too when the window is out of focus", async () => {
    const { backend, send, shownPane } = await setup();
    backend.setWindowFocused(false);
    send(shownPane, BEL);
    await settle();
    expect(backend.notifications).toHaveLength(1);
  });

  it("OSC 9 and OSC 777 bring their own words", async () => {
    const { backend, send, backgroundPane } = await setup();
    backend.setWindowFocused(false);
    send(backgroundPane, osc("9;Build done"));
    now += 10_000;
    send(backgroundPane, osc("777;notify;Agent;Waiting for you"));
    await settle();
    expect(backend.notifications).toEqual([
      { title: "Noren", body: "Build done" },
      { title: "Agent", body: "Waiting for you" },
    ]);
  });

  it("progress and the folder sequences are not notifications", async () => {
    const { backend, send, backgroundPane } = await setup();
    backend.setWindowFocused(false);
    send(backgroundPane, osc("9;4;1;50") + osc("9;9;/tmp") + osc("0;title"));
    await settle();
    expect(backend.notifications).toEqual([]);
  });

  it("a program that rings in a loop gives one notification until the guard time passes", async () => {
    const { backend, send, backgroundPane } = await setup();
    backend.setWindowFocused(false);
    for (let i = 0; i < 5; i++) {
      send(backgroundPane, BEL);
      await settle();
    }
    expect(backend.notifications).toHaveLength(1);
    now += 4000;
    send(backgroundPane, BEL);
    await settle();
    expect(backend.notifications).toHaveLength(2);
  });

  it("a command of 31 s that ends in a tab out of sight notifies, with the line and the time", async () => {
    const { backend, runCommand, backgroundPane } = await setup();
    // The window has the focus, but this tab is not the one on screen.
    runCommand(backgroundPane, "make all", 31);
    await settle();
    expect(backend.notifications).toEqual([
      { title: "Command finished", body: "make all finished after 31s" },
    ]);
  });

  it("a failed command says so", async () => {
    const { backend, runCommand, backgroundPane } = await setup();
    runCommand(backgroundPane, "make all", 95, 2);
    await settle();
    expect(backend.notifications).toEqual([
      { title: "Command failed", body: "make all failed (exit 2) after 1m 35s" },
    ]);
  });

  it("a command of 29 s does not notify, nor one of exactly 30 s", async () => {
    const { backend, runCommand, backgroundPane } = await setup();
    runCommand(backgroundPane, "short", 29);
    runCommand(backgroundPane, "edge", 30);
    await settle();
    expect(backend.notifications).toEqual([]);
  });

  it("a long command that ends in the tab on screen, window in focus, does not notify", async () => {
    const { backend, runCommand, shownPane } = await setup();
    runCommand(shownPane, "make all", 120);
    await settle();
    expect(backend.notifications).toEqual([]);
  });

  it("a long command in the tab on screen notifies when the window is out of focus", async () => {
    const { backend, runCommand, shownPane } = await setup();
    backend.setWindowFocused(false);
    runCommand(shownPane, "make all", 120);
    await settle();
    expect(backend.notifications).toEqual([
      { title: "Command finished", body: "make all finished after 2m 00s" },
    ]);
  });

  it("the settings are read at every event: off sends nothing, a shorter limit notifies sooner", async () => {
    let settings: NotificationSettings = { enabled: false, longCommandMs: 30_000 };
    const { backend, send, runCommand, backgroundPane } = await setup(() => settings);
    backend.setWindowFocused(false);
    send(backgroundPane, BEL);
    runCommand(backgroundPane, "slow", 60);
    await settle();
    expect(backend.notifications).toEqual([]);
    expect(backend.callsTo("isWindowFocused")).toHaveLength(0);

    settings = { enabled: true, longCommandMs: 10_000 };
    runCommand(backgroundPane, "slow", 11);
    await settle();
    expect(backend.notifications).toEqual([
      { title: "Command finished", body: "slow finished after 11s" },
    ]);
  });

  it("a refusal of the system is reported to the notifier's error hook and breaks nothing", async () => {
    const { backend, errors, send, backgroundPane } = await setup();
    backend.setWindowFocused(false);
    backend.setNotifyFailure(new Error("refused"));
    send(backgroundPane, BEL);
    await settle();
    expect(errors).toHaveLength(1);
    expect(backend.notifications).toEqual([]);
  });
});
