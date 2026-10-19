import {
  FakeBackend,
  PaneLocationTracker,
  createSequentialIds,
  layoutPanes,
  restoreWorkspace,
} from "@noren/model";
import type { Id, Item, Pane, Space } from "@noren/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS } from "./keybindings";
import { createWorkspaceStore, activeItemIdOf, activeSpaceOf } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

const BEL = "\x07";
const osc = (body: string): string => `\x1b]${body}${BEL}`;
let now = 1000;
const clock = { now: () => now };

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

/**
 * A store with two spaces of two tabs each, every pane wired to a session of the fake shell the way
 * the app wires it: the output goes through a tracker whose attention events reach the store.
 * `send` makes the program of a pane write `text`.
 */
async function setup() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  store.getState().newTab();
  store.getState().createSpace({ name: "Work" });
  store.getState().newTab();
  const sessions = new Map<Id, number>();
  for (const space of store.getState().workspace.spaces) {
    for (const item of Object.values(space.items)) {
      for (const pane of layoutPanes(item.layout)) {
        const id = await backend.createSession({ cols: 80, rows: 24 });
        store.getState().attachSession(pane.id, String(id));
        const tracker = new PaneLocationTracker({
          gitInfo: () => Promise.resolve(null),
          onLocation: () => undefined,
          onAttention: (event) => store.getState().notifyPane(pane.id, event),
        });
        backend.onOutput(id, (bytes) => tracker.feed(bytes));
        sessions.set(pane.id, id);
      }
    }
  }
  const send = (paneId: Id, text: string): void =>
    backend.sendOutput(must(sessions.get(paneId), `session of ${paneId}`), text);
  return { store, send };
}

const paneOf = (store: WorkspaceStore, id: Id): Pane => {
  for (const space of store.getState().workspace.spaces) {
    for (const item of Object.values(space.items)) {
      const found = layoutPanes(item.layout).find((pane) => pane.id === id);
      if (found) return found;
    }
  }
  throw new Error(`no pane ${id}`);
};
const spaceAt = (store: WorkspaceStore, index: number): Space =>
  must(store.getState().workspace.spaces[index], `space ${index}`);
const tabs = (store: WorkspaceStore, spaceIndex: number): Item[] =>
  Object.values(spaceAt(store, spaceIndex).items);
/** The first pane of a tab. */
const firstPane = (item: Item): Id => must(layoutPanes(item.layout)[0], "pane").id;

describe("unread marks in the store", () => {
  beforeEach(() => {
    now = 1000;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a notification from a tab in the background marks it; the tab on screen is never marked", async () => {
    const { store, send } = await setup();
    // Space "Work" is the active one and its second tab is shown.
    const shownId = must(activeItemIdOf(store.getState()), "active tab");
    const shownPane = firstPane(must(spaceAt(store, 1).items[shownId], "shown tab"));
    const background = must(
      tabs(store, 1).find((item) => item.id !== shownId),
      "background tab",
    );
    send(shownPane, osc("9;hello"));
    send(firstPane(background), osc("9;hello"));
    expect(paneOf(store, shownPane)).toMatchObject({ unread: false, bell: false });
    expect(paneOf(store, firstPane(background))).toMatchObject({ unread: true, bell: false });
  });

  it("a bell marks the pane unread and rings; OSC 777 and OSC 9 only mark it unread", async () => {
    const { store, send } = await setup();
    const [first, second] = tabs(store, 0).map(firstPane);
    send(must(first, "pane"), BEL);
    send(must(second, "pane"), osc("777;notify;Agent;Waiting"));
    expect(paneOf(store, must(first, "pane"))).toMatchObject({ unread: true, bell: true });
    expect(paneOf(store, must(second, "pane"))).toMatchObject({ unread: true, bell: false });
  });

  it("progress and the folder sequences are not attention", async () => {
    const { store, send } = await setup();
    const pane = firstPane(must(tabs(store, 0)[0], "tab"));
    send(pane, osc("9;4;1;50") + osc("9;9;/tmp") + osc("0;title"));
    expect(paneOf(store, pane)).toMatchObject({ unread: false, bell: false });
  });

  it("a pane that is gone changes nothing", async () => {
    const { store } = await setup();
    const before = store.getState().workspace;
    store.getState().notifyPane("no-such-pane", { kind: "bell" });
    expect(store.getState().workspace).toBe(before);
  });

  it("showLastUnread goes to the most recent unread pane, in another space if needed, and reads it", async () => {
    const { store, send } = await setup();
    const [a, b] = tabs(store, 0).map((item) => item.id);
    const tabA = must(a, "tab");
    const tabB = must(b, "tab");
    const paneA = firstPane(must(spaceAt(store, 0).items[tabA], "tab"));
    const paneB = firstPane(must(spaceAt(store, 0).items[tabB], "tab"));
    expect(store.getState().showLastUnread()).toBe(false);
    send(paneA, osc("9;first"));
    now += 10;
    send(paneB, BEL);
    expect(store.getState().workspace.activeSpaceId).toBe(spaceAt(store, 1).id);
    expect(store.getState().showLastUnread()).toBe(true);
    const state = store.getState();
    expect(state.workspace.activeSpaceId).toBe(spaceAt(store, 0).id);
    expect(activeItemIdOf(state)).toBe(tabB);
    expect(must(activeSpaceOf(state.workspace).items[tabB], "tab").focusedPaneId).toBe(paneB);
    expect(paneOf(store, paneB)).toMatchObject({ unread: false, bell: false });
    expect(paneOf(store, paneA)).toMatchObject({ unread: true, bell: false });
    // The next one, then nothing.
    expect(store.getState().showLastUnread()).toBe(true);
    expect(activeItemIdOf(store.getState())).toBe(tabA);
    expect(paneOf(store, paneA)).toMatchObject({ unread: false, bell: false });
    expect(store.getState().showLastUnread()).toBe(false);
  });

  it("showing a tab with a click clears its marks", async () => {
    const { store, send } = await setup();
    const [a, b] = tabs(store, 0);
    store.getState().activateSpaceAt(0);
    store.getState().activateItem(must(a, "tab").id);
    const paneB = firstPane(must(b, "tab"));
    send(paneB, BEL);
    expect(paneOf(store, paneB).bell).toBe(true);
    store.getState().activateItem(must(b, "tab").id);
    expect(paneOf(store, paneB)).toMatchObject({ unread: false, bell: false });
  });
});

describe("the shortcut", () => {
  it("is Ctrl+Shift+U in both presets, in the Tabs category", () => {
    const action = ACTIONS.find((a) => a.id === "tab.last-unread");
    expect(action).toMatchObject({
      title: "Go to last unread tab",
      category: "Tabs",
      command: { kind: "last-unread" },
      repeat: false,
    });
    expect(action?.chords).toEqual({ safe: "Ctrl+Shift+KeyU", browser: "Ctrl+Shift+KeyU" });
  });
});
