import { describe, expect, it } from "vitest";
import { FakeBackend, ManualClock } from "@noren/model";
import type { Id } from "@noren/model";
import { ScrollbackSaver, scrollbackPanes } from "./scrollback-saver";
import type { ScrollbackPane } from "./scrollback-saver";

// The rules of when a snapshot is written, with a clock the test moves and a backend that records.

const ESC = "\x1b";

interface World {
  clock: ManualClock;
  backend: FakeBackend;
  saver: ScrollbackSaver;
  /** The panes the saver is told are open; edit it to change the answer. */
  panes: Map<Id, ScrollbackPane>;
  /** What each pane's terminal serializes. */
  terminals: Map<Id, string>;
  settings: { enabled: boolean };
  /** The notes the saver made: pane id, and whether it now has a file. */
  notes: [Id, boolean][];
  errors: unknown[];
}

function world(): World {
  const clock = new ManualClock();
  const backend = new FakeBackend({ clock });
  const panes = new Map<Id, ScrollbackPane>();
  const terminals = new Map<Id, string>();
  const settings = { enabled: true };
  const notes: [Id, boolean][] = [];
  const errors: unknown[] = [];
  const saver = new ScrollbackSaver({
    backend,
    clock,
    panes: () => [...panes.values()],
    snapshot: (paneId) => terminals.get(paneId),
    enabled: () => settings.enabled,
    onFile: (pane, has) => {
      notes.push([pane.paneId, has]);
      const known = panes.get(pane.paneId);
      if (known) panes.set(pane.paneId, { ...known, hasFile: has });
    },
    onError: (error) => errors.push(error),
  });
  return { clock, backend, saver, panes, terminals, settings, notes, errors };
}

function open(w: World, paneId: Id, text: string, extra: Partial<ScrollbackPane> = {}): void {
  w.panes.set(paneId, {
    paneId,
    itemId: `item-${paneId}`,
    spaceSaves: true,
    hasFile: false,
    ...extra,
  });
  w.terminals.set(paneId, text);
}

/** Lets the writes that were started finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const writes = (w: World) =>
  w.backend.calls
    .filter((c) => c.method === "saveScrollback" || c.method === "deleteScrollback")
    .map((c) => [c.method, c.args[0]]);

describe("ScrollbackSaver", () => {
  it("saves a pane that had activity once 60 seconds have passed, and not before", async () => {
    const w = world();
    w.saver.start();
    open(w, "pane-1", "hello\r\nworld");
    w.saver.noteActivity("pane-1");

    w.clock.advance(59_999);
    await settle();
    expect(writes(w)).toEqual([]);
    w.clock.advance(1);
    await settle();
    expect(writes(w)).toEqual([["saveScrollback", "pane-1"]]);
    expect(w.backend.scrollbackFiles).toEqual({ "pane-1": "hello\nworld" });
  });

  it("does not save a pane that had no activity", async () => {
    const w = world();
    w.saver.start();
    open(w, "pane-1", "idle");
    w.clock.advance(180_000);
    await settle();
    expect(writes(w)).toEqual([]);
  });

  it("saves again only when the pane printed after its last snapshot", async () => {
    const w = world();
    w.saver.start();
    open(w, "pane-1", "one");
    w.saver.noteActivity("pane-1");
    w.clock.advance(60_000);
    await settle();
    expect(writes(w)).toHaveLength(1);

    w.clock.advance(60_000);
    await settle();
    expect(writes(w)).toHaveLength(1);

    w.terminals.set("pane-1", "one\r\ntwo");
    w.saver.noteActivity("pane-1");
    w.clock.advance(60_000);
    await settle();
    expect(writes(w)).toHaveLength(2);
    expect(w.backend.scrollbackFiles["pane-1"]).toBe("one\ntwo");
  });

  it("keeps saving every 60 seconds for as long as it runs, and stops when stopped", async () => {
    const w = world();
    w.saver.start();
    // Starting it again changes nothing: still one timer.
    w.saver.start();
    expect(w.clock.pending).toBe(1);
    open(w, "pane-1", "x");
    for (let minute = 1; minute <= 3; minute++) {
      w.saver.noteActivity("pane-1");
      w.clock.advance(60_000);
      await settle();
      expect(writes(w)).toHaveLength(minute);
    }
    w.saver.stop();
    expect(w.clock.pending).toBe(0);
    w.saver.noteActivity("pane-1");
    w.clock.advance(300_000);
    await settle();
    expect(writes(w)).toHaveLength(3);
  });

  it("saves only the panes that had activity, each with its own text", async () => {
    const w = world();
    w.saver.start();
    open(w, "pane-1", "first");
    open(w, "pane-2", "second");
    open(w, "pane-3", "third");
    w.saver.noteActivity("pane-1");
    w.saver.noteActivity("pane-3");
    w.clock.advance(60_000);
    await settle();
    expect(writes(w)).toEqual([
      ["saveScrollback", "pane-1"],
      ["saveScrollback", "pane-3"],
    ]);
    expect(w.backend.scrollbackFiles).toEqual({ "pane-1": "first", "pane-3": "third" });
  });

  it("flush saves what is due at once, for the window closing", async () => {
    const w = world();
    open(w, "pane-1", "closing");
    w.saver.noteActivity("pane-1");
    const done = w.saver.flush();
    // The write was started before anything was waited for.
    expect(writes(w)).toEqual([["saveScrollback", "pane-1"]]);
    await done;
    expect(w.backend.scrollbackFiles).toEqual({ "pane-1": "closing" });
  });

  it("starts the writes of all the panes before waiting for any of them", () => {
    const w = world();
    for (const id of ["pane-1", "pane-2", "pane-3"]) {
      open(w, id, id);
      w.saver.noteActivity(id);
    }
    void w.saver.flush();
    // All three calls were made in the same turn, as the window closing needs.
    expect(writes(w)).toHaveLength(3);
  });

  it("writes only text and colors, whatever the terminal serialized", async () => {
    const w = world();
    open(
      w,
      "pane-1",
      `${ESC}[1mbold${ESC}[0m${ESC}[3Cgap${ESC}]52;c;SGVsbG8=\x07${ESC}[6n${ESC}[?1049h\r\nsecond\r\n\r\n`,
    );
    w.saver.noteActivity("pane-1");
    await w.saver.flush();
    expect(w.backend.scrollbackFiles["pane-1"]).toBe(`${ESC}[1mbold${ESC}[0m   gap\nsecond`);
  });

  it("writes only the last 2000 lines", async () => {
    const w = world();
    open(w, "pane-1", Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\r\n"));
    w.saver.noteActivity("pane-1");
    await w.saver.flush();
    const lines = (w.backend.scrollbackFiles["pane-1"] ?? "").split("\n");
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toBe("line 1000");
    expect(lines.at(-1)).toBe("line 2999");
  });

  describe("when the space says never", () => {
    it("writes nothing, in a minute or when the window closes", async () => {
      const w = world();
      w.saver.start();
      open(w, "pane-1", "secret", { spaceSaves: false });
      w.saver.noteActivity("pane-1");
      w.clock.advance(60_000);
      await settle();
      await w.saver.flush();
      expect(writes(w)).toEqual([]);
      expect(w.backend.scrollbackFiles).toEqual({});
      expect(w.notes).toEqual([]);
      // And it is not due either: turning the space on later does not save what was printed before.
      expect(w.saver.dirtyPaneIds).toEqual([]);
    });

    it("removes the file saved before and the note about it", async () => {
      const w = world();
      w.backend.setScrollback("pane-1", "saved before");
      open(w, "pane-1", "secret", { spaceSaves: false, hasFile: true });
      w.saver.noteActivity("pane-1");
      await w.saver.flush();
      expect(writes(w)).toEqual([["deleteScrollback", "pane-1"]]);
      expect(w.backend.scrollbackFiles).toEqual({});
      expect(w.notes).toEqual([["pane-1", false]]);
      // Nothing more to remove the next time.
      await w.saver.flush();
      expect(writes(w)).toHaveLength(1);
    });

    it("keeps the note when the file could not be removed, so the next time tries again", async () => {
      const w = world();
      w.backend.setScrollback("pane-1", "saved before");
      w.backend.setScrollbackFailure(new Error("disk locked"));
      open(w, "pane-1", "secret", { spaceSaves: false, hasFile: true });
      await w.saver.flush();
      expect(w.notes).toEqual([]);
      expect(w.errors).toHaveLength(1);
      expect(w.backend.scrollbackFiles).toEqual({ "pane-1": "saved before" });
      w.backend.setScrollbackFailure(undefined);
      await w.saver.flush();
      expect(w.backend.scrollbackFiles).toEqual({});
      expect(w.notes).toEqual([["pane-1", false]]);
    });
  });

  describe("when the setting of the app says never", () => {
    it("writes nothing and removes the files that are there", async () => {
      const w = world();
      w.settings.enabled = false;
      w.backend.setScrollback("pane-2", "saved before");
      open(w, "pane-1", "secret");
      open(w, "pane-2", "also secret", { hasFile: true });
      w.saver.noteActivity("pane-1");
      w.saver.noteActivity("pane-2");
      await w.saver.flush();
      expect(writes(w)).toEqual([["deleteScrollback", "pane-2"]]);
      expect(w.backend.scrollbackFiles).toEqual({});
    });

    it("saves again once the setting is back on, for panes that print after that", async () => {
      const w = world();
      w.settings.enabled = false;
      open(w, "pane-1", "off");
      w.saver.noteActivity("pane-1");
      await w.saver.flush();
      expect(writes(w)).toEqual([]);
      w.settings.enabled = true;
      w.saver.noteActivity("pane-1");
      await w.saver.flush();
      expect(writes(w)).toEqual([["saveScrollback", "pane-1"]]);
    });
  });

  it("tells the pane it has a file before the file is written, so the state saved at closing knows", async () => {
    const w = world();
    open(w, "pane-1", "text");
    w.saver.noteActivity("pane-1");
    const done = w.saver.flush();
    expect(w.notes).toEqual([["pane-1", true]]);
    await done;
    // A pane that already has the note is not told again.
    w.saver.noteActivity("pane-1");
    await w.saver.flush();
    expect(w.notes).toEqual([["pane-1", true]]);
  });

  it("leaves a terminal with nothing in it alone: the file from before stays and the pane stays due", async () => {
    const w = world();
    w.backend.setScrollback("pane-1", "saved before");
    open(w, "pane-1", "\r\n   \r\n", { hasFile: true });
    w.saver.noteActivity("pane-1");
    await w.saver.flush();
    expect(writes(w)).toEqual([]);
    expect(w.backend.scrollbackFiles).toEqual({ "pane-1": "saved before" });
    expect(w.saver.dirtyPaneIds).toEqual(["pane-1"]);
    // Once it has text, it is saved.
    w.terminals.set("pane-1", "back");
    await w.saver.flush();
    expect(w.backend.scrollbackFiles).toEqual({ "pane-1": "back" });
  });

  it("skips a pane that has no terminal now and tries it later", async () => {
    const w = world();
    open(w, "pane-1", "text");
    w.terminals.delete("pane-1");
    w.saver.noteActivity("pane-1");
    await w.saver.flush();
    expect(writes(w)).toEqual([]);
    w.terminals.set("pane-1", "text");
    await w.saver.flush();
    expect(writes(w)).toEqual([["saveScrollback", "pane-1"]]);
  });

  it("does not ask the backend about an id that cannot be a file name", async () => {
    const w = world();
    open(w, "../escape", "text");
    open(w, "con", "text");
    w.saver.noteActivity("../escape");
    w.saver.noteActivity("con");
    await w.saver.flush();
    expect(writes(w)).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  it("a failed write is reported, the pane stays due and the next time saves it", async () => {
    const w = world();
    w.backend.setScrollbackFailure(new Error("disk full"));
    open(w, "pane-1", "text");
    w.saver.noteActivity("pane-1");
    await w.saver.flush();
    expect(w.errors).toHaveLength(1);
    expect(w.saver.dirtyPaneIds).toEqual(["pane-1"]);
    w.backend.setScrollbackFailure(undefined);
    await w.saver.flush();
    expect(w.backend.scrollbackFiles).toEqual({ "pane-1": "text" });
    expect(w.saver.dirtyPaneIds).toEqual([]);
  });

  it("a terminal that throws when asked is reported and does not stop the other panes", async () => {
    const clock = new ManualClock();
    const backend = new FakeBackend({ clock });
    const errors: unknown[] = [];
    const saver = new ScrollbackSaver({
      backend,
      clock,
      panes: () => [
        { paneId: "pane-1", itemId: "i1", spaceSaves: true, hasFile: false },
        { paneId: "pane-2", itemId: "i2", spaceSaves: true, hasFile: false },
      ],
      snapshot: (paneId) => {
        if (paneId === "pane-1") throw new Error("the terminal is gone");
        return "fine";
      },
      enabled: () => true,
      onFile: () => undefined,
      onError: (error) => errors.push(error),
    });
    saver.noteActivity("pane-1");
    saver.noteActivity("pane-2");
    await saver.flush();
    expect(backend.scrollbackFiles).toEqual({ "pane-2": "fine" });
    expect(errors).toHaveLength(1);
  });

  it("output that arrives while a snapshot is being written makes the pane due again", async () => {
    const w = world();
    open(w, "pane-1", "first");
    w.saver.noteActivity("pane-1");
    const done = w.saver.flush();
    // The write is in flight; the pane prints.
    w.saver.noteActivity("pane-1");
    await done;
    expect(w.saver.dirtyPaneIds).toEqual(["pane-1"]);
  });

  it("two saves of the same pane never overlap: the newer text is the one that stays", async () => {
    const clock = new ManualClock();
    const order: string[] = [];
    const gate: { release?: () => void } = {};
    const backend = {
      saveScrollback: (_paneId: string, text: string) => {
        order.push(`start ${text}`);
        // The first write is slow, the second would be quick.
        if (text === "old") {
          return new Promise<void>((resolve) => {
            gate.release = () => {
              order.push(`end ${text}`);
              resolve();
            };
          });
        }
        order.push(`end ${text}`);
        return Promise.resolve();
      },
      deleteScrollback: () => Promise.resolve(),
    };
    let text = "old";
    const saver = new ScrollbackSaver({
      backend,
      clock,
      panes: () => [{ paneId: "pane-1", itemId: "i1", spaceSaves: true, hasFile: true }],
      snapshot: () => text,
      enabled: () => true,
      onFile: () => undefined,
    });
    saver.noteActivity("pane-1");
    const first = saver.flush();
    text = "new";
    saver.noteActivity("pane-1");
    const second = saver.flush();
    expect(order).toEqual(["start old"]);
    gate.release?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["start old", "end old", "start new", "end new"]);
  });
});

describe("scrollbackPanes", () => {
  it("lists every pane of every open item with the setting of its space and whether it has a file", () => {
    const pane = (id: string, ref?: string) => ({
      kind: "pane" as const,
      pane: {
        id,
        type: "terminal" as const,
        profileId: "default",
        status: "idle" as const,
        unread: false,
        bell: false,
        ...(ref !== undefined ? { scrollbackRef: ref } : {}),
      },
    });
    const item = (id: string, layout: ReturnType<typeof pane> | object) => ({
      id,
      titleLocked: false,
      layout,
      focusedPaneId: "x",
      lastActivityAt: 0,
    });
    const space = (id: string, saves: boolean, items: Record<string, unknown>) => ({
      id,
      name: id,
      icon: "terminal",
      color: "#fff",
      modIds: [],
      defaults: { env: {} },
      aiEnabled: true,
      saveScrollback: saves,
      pinned: [],
      tree: [],
      items,
    });
    const workspace = {
      version: 2,
      activeSpaceId: "s1",
      favorites: [],
      closed: [],
      archive: [],
      spaces: [
        space("s1", true, {
          i1: item("i1", pane("p1", "p1.txt")),
          i2: item("i2", {
            kind: "split",
            dir: "row",
            sizes: [50, 50],
            children: [pane("p2"), pane("p3", "p3.txt")],
          }),
        }),
        space("s2", false, { i3: item("i3", pane("p4")) }),
      ],
    } as unknown as Parameters<typeof scrollbackPanes>[0];
    expect(scrollbackPanes(workspace)).toEqual([
      { paneId: "p1", itemId: "i1", spaceSaves: true, hasFile: true },
      { paneId: "p2", itemId: "i2", spaceSaves: true, hasFile: false },
      { paneId: "p3", itemId: "i2", spaceSaves: true, hasFile: true },
      { paneId: "p4", itemId: "i3", spaceSaves: false, hasFile: false },
    ]);
  });
});
