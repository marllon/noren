import { describe, expect, it } from "vitest";
import { FakeBackend, ManualClock, archiveSettingsOf, layoutPanes } from "@noren/model";
import type { ArchiveSettings, Id, Item, Pane, Workspace } from "@noren/model";
import { AutoArchiver } from "./auto-archiver";
import { fixturePane, fixtureSpace, fixtureTab } from "./closed-fixtures";
import { createWorkspaceStore } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

// The scheduler of the auto-archive on a clock that moves only when the test says so, over the real
// store: a quiet tab goes to the archive, and a tab with a command running, pinned, a favorite, one
// that printed lately or the one on screen stays, as does everything while the setting is off.

const MINUTE = 60_000;
const HOUR = 3_600_000;

const tab = (name: string, pane: Partial<Pane> = {}): Item =>
  fixtureTab(`i-${name}`, { ...fixturePane(`p-${name}`, { cwd: `/srv/${name}` }), ...pane });

interface Setup {
  clock: ManualClock;
  store: WorkspaceStore;
  archiver: AutoArchiver;
  settings: { current: ArchiveSettings };
  errors: unknown[];
  archived(): Id[];
  open(): Id[];
}

/**
 * A workspace with `items` in one space (the first one is the one on screen), pinned and favorite
 * as asked, and an archiver started at `startAt` on the clock.
 */
function setup(
  items: readonly Item[],
  options: { pinned?: Id[]; favorites?: Id[]; startAt?: number; afterHours?: number } = {},
): Setup {
  const clock = new ManualClock();
  clock.advance(options.startAt ?? 0);
  const backend = new FakeBackend({ clock });
  const space = fixtureSpace("s1", items);
  const pinned = options.pinned ?? [];
  const workspace: Workspace = {
    version: 2,
    spaces: [
      {
        ...space,
        pinned,
        tree: space.tree.filter((node) => !pinned.includes(node.id)),
      },
    ],
    activeSpaceId: "s1",
    favorites: options.favorites ?? [],
    closed: [],
    archive: [],
  };
  const store = createWorkspaceStore({ backend, workspace, clock });
  const settings = { current: archiveSettingsOf({ afterHours: options.afterHours ?? 12 }) };
  const errors: unknown[] = [];
  const archiver = new AutoArchiver({
    clock,
    workspace: () => store.getState().workspace,
    settings: () => settings.current,
    dispatch: (action) => store.getState().dispatch(action),
    onError: (error) => errors.push(error),
  });
  archiver.start();
  return {
    clock,
    store,
    archiver,
    settings,
    errors,
    archived: () => store.getState().workspace.archive.map((entry) => entry.item.id),
    open: () => Object.keys(store.getState().workspace.spaces[0]?.items ?? {}),
  };
}

describe("a quiet tab", () => {
  it("goes to the archive when it has been left alone for the hours the setting says, and not before", () => {
    const t = setup([tab("shown"), tab("quiet")]);
    t.clock.advance(12 * HOUR - 2 * MINUTE);
    expect(t.archived()).toEqual([]);
    t.clock.advance(3 * MINUTE);
    expect(t.archived()).toEqual(["i-quiet"]);
    expect(t.open()).toEqual(["i-shown"]);
    expect(t.errors).toEqual([]);
  });

  it("is looked for every minute", () => {
    const t = setup([tab("shown"), tab("quiet")], { afterHours: 1 / 120 });
    // Half a minute of quiet is enough here; the check that sees it is the one at the end of the minute.
    t.clock.advance(MINUTE - 1);
    expect(t.archived()).toEqual([]);
    t.clock.advance(1);
    expect(t.archived()).toEqual(["i-quiet"]);
  });

  it("keeps the place and the folder it had in the archive entry", () => {
    const t = setup([tab("shown"), tab("quiet")]);
    t.clock.advance(13 * HOUR);
    const entry = t.store.getState().workspace.archive[0];
    expect(entry?.place).toEqual({ list: "tree", index: 1 });
    expect(entry?.spaceId).toBe("s1");
    expect(entry && layoutPanes(entry.item.layout)[0]?.cwd).toBe("/srv/quiet");
    expect(entry?.archivedAt).toBeGreaterThanOrEqual(12 * HOUR);
  });

  it("every quiet tab goes, each on its own", () => {
    const t = setup([tab("shown"), tab("a"), tab("b"), tab("c")]);
    t.clock.advance(13 * HOUR);
    expect(t.archived()).toEqual(["i-a", "i-b", "i-c"]);
    expect(t.open()).toEqual(["i-shown"]);
  });

  it("the sessions of the shells it puts away are ended", () => {
    const t = setup([tab("shown"), tab("quiet", { sessionId: "7" })]);
    t.clock.advance(13 * HOUR);
    const entry = t.store.getState().workspace.archive[0];
    expect(entry && layoutPanes(entry.item.layout)[0]?.sessionId).toBeUndefined();
  });
});

describe("a tab that is not archived", () => {
  it("one with a command running (OSC 133), however long it has run", () => {
    const t = setup([tab("shown"), tab("busy", { runningCommand: { text: "make" } })]);
    t.clock.advance(48 * HOUR);
    expect(t.archived()).toEqual([]);
    expect(t.open()).toContain("i-busy");
  });

  it("one whose pane has the status running", () => {
    const t = setup([tab("shown"), tab("busy", { status: "running" })]);
    t.clock.advance(48 * HOUR);
    expect(t.archived()).toEqual([]);
  });

  it("a pinned tab", () => {
    const t = setup([tab("shown"), tab("pin"), tab("quiet")], { pinned: ["i-pin"] });
    t.clock.advance(48 * HOUR);
    expect(t.archived()).toEqual(["i-quiet"]);
    expect(t.open()).toContain("i-pin");
  });

  it("a favorite", () => {
    const t = setup([tab("shown"), tab("fav"), tab("quiet")], { favorites: ["i-fav"] });
    t.clock.advance(48 * HOUR);
    expect(t.archived()).toEqual(["i-quiet"]);
    expect(t.open()).toContain("i-fav");
  });

  it("one that printed lately: the quiet time counts from the last output", () => {
    const t = setup([tab("shown"), tab("talky"), tab("quiet")]);
    t.clock.advance(11 * HOUR);
    t.archiver.noteActivity("p-talky");
    t.clock.advance(HOUR + 5 * MINUTE);
    // The quiet one has been left alone for more than 12 hours; the one that printed has not.
    expect(t.archived()).toEqual(["i-quiet"]);
    t.clock.advance(10 * HOUR);
    expect(t.archived()).toEqual(["i-quiet"]);
    t.clock.advance(HOUR);
    expect(t.archived()).toEqual(["i-quiet", "i-talky"]);
  });

  it("one with an unread mark or a bell", () => {
    const t = setup([tab("shown"), tab("unread", { unread: true }), tab("bell", { bell: true })]);
    t.clock.advance(48 * HOUR);
    expect(t.archived()).toEqual([]);
  });

  it("the tab on screen, and one that was on screen counts from the moment it was left", () => {
    const t = setup([tab("a"), tab("b")]);
    t.clock.advance(20 * HOUR);
    // "a" has been on screen all along; "b" never was.
    expect(t.archived()).toEqual(["i-b"]);
    t.store.getState().dispatch({ type: "item/create" });
    const created = t.store.getState().workspace.spaces[0]?.activeItemId;
    expect(created).toBeDefined();
    // "a" is left on screen's side now: its quiet time counts from the last check it was shown at.
    t.clock.advance(11 * HOUR);
    expect(t.archived()).toEqual(["i-b"]);
    t.clock.advance(2 * HOUR);
    expect(t.archived()).toEqual(["i-b", "i-a"]);
    expect(t.open()).toEqual([created]);
  });

  it("nothing at all while the setting is off", () => {
    const t = setup([tab("shown"), tab("quiet")]);
    t.settings.current = archiveSettingsOf({ enabled: false });
    t.clock.advance(100 * HOUR);
    expect(t.archived()).toEqual([]);
    expect(t.open()).toEqual(["i-shown", "i-quiet"]);
  });

  it("nothing before the app opened: a long time on the clock of the tabs counts from the start", () => {
    // The tabs were last active at 1; the app opens at 100 hours.
    const t = setup([tab("shown"), tab("old")], { startAt: 100 * HOUR });
    t.clock.advance(11 * HOUR);
    expect(t.archived()).toEqual([]);
    t.clock.advance(2 * HOUR);
    expect(t.archived()).toEqual(["i-old"]);
  });
});

describe("the setting is read at every check", () => {
  it("turning it on later archives what is quiet, and spares what was in use while it was off", () => {
    const t = setup([tab("shown"), tab("quiet"), tab("busy-lately")]);
    t.settings.current = archiveSettingsOf({ enabled: false });
    t.clock.advance(30 * HOUR);
    t.archiver.noteActivity("p-busy-lately");
    t.clock.advance(MINUTE);
    t.settings.current = archiveSettingsOf({});
    t.clock.advance(MINUTE);
    expect(t.archived()).toEqual(["i-quiet"]);
  });

  it("a shorter wait archives at the next check", () => {
    const t = setup([tab("shown"), tab("quiet")]);
    t.clock.advance(3 * HOUR);
    expect(t.archived()).toEqual([]);
    t.settings.current = archiveSettingsOf({ afterHours: 2 });
    t.clock.advance(MINUTE);
    expect(t.archived()).toEqual(["i-quiet"]);
  });
});

describe("the archiver itself", () => {
  it("check() archives now and answers with the ids", () => {
    const t = setup([tab("shown"), tab("quiet")]);
    t.clock.advance(13 * HOUR);
    expect(t.archiver.check()).toEqual([]);
    const t2 = setup([tab("shown"), tab("quiet")]);
    t2.archiver.stop();
    t2.clock.advance(13 * HOUR);
    expect(t2.archived()).toEqual([]);
    expect(t2.archiver.check()).toEqual(["i-quiet"]);
    expect(t2.archived()).toEqual(["i-quiet"]);
  });

  it("stop() ends the checks and start() brings them back, once", () => {
    const t = setup([tab("shown"), tab("quiet")]);
    t.archiver.stop();
    t.clock.advance(13 * HOUR);
    expect(t.archived()).toEqual([]);
    t.archiver.start();
    t.archiver.start();
    expect(t.clock.pending).toBe(1);
    t.clock.advance(MINUTE);
    expect(t.archived()).toEqual(["i-quiet"]);
  });

  it("a failure is reported and the checks go on", () => {
    const clock = new ManualClock();
    const errors: unknown[] = [];
    let calls = 0;
    const store = createWorkspaceStore({
      backend: new FakeBackend({ clock }),
      clock,
      workspace: {
        version: 2,
        spaces: [fixtureSpace("s1", [tab("shown"), tab("quiet")])],
        activeSpaceId: "s1",
        favorites: [],
        closed: [],
        archive: [],
      },
    });
    const archiver = new AutoArchiver({
      clock,
      workspace: () => store.getState().workspace,
      settings: () => archiveSettingsOf({ afterHours: 1 / 120 }),
      dispatch: (action) => {
        calls += 1;
        if (calls === 1) throw new Error("the store broke");
        store.getState().dispatch(action);
      },
      onError: (error) => errors.push(error),
    });
    archiver.start();
    clock.advance(MINUTE);
    expect(errors).toHaveLength(1);
    expect(store.getState().workspace.archive).toEqual([]);
    clock.advance(MINUTE);
    expect(store.getState().workspace.archive).toHaveLength(1);
  });

  it("the activity of a tab that is gone leaves nothing behind", () => {
    const t = setup([tab("shown"), tab("quiet")]);
    t.archiver.noteActivity("p-quiet");
    t.clock.advance(MINUTE);
    t.store.getState().dispatch({ type: "item/close", itemId: "i-quiet" });
    t.archiver.noteActivity("p-quiet");
    t.clock.advance(MINUTE);
    // Brought back, it is on screen: it stays, and the tab it replaced there is the quiet one now.
    t.store.getState().dispatch({ type: "item/reopen" });
    t.clock.advance(13 * HOUR);
    expect(t.archived()).toEqual(["i-shown"]);
    expect(t.open()).toEqual(["i-quiet"]);
  });
});
