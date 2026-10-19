import { describe, expect, it } from "vitest";
import type { Action, ProjectAction, Workspace } from "./index";
import { FakeBackend, createDefaultWorkspace, createProjectActions, reduce } from "./index";
import { layoutPanes } from "./sessions";
import { testContext } from "./test-helpers";
import type { LayoutNode } from "./types";

const loop: ProjectAction = {
  id: "loop",
  label: "Loop",
  command: "loop",
  stop: "loop parar",
  tab: "loop",
};
const dev: ProjectAction = { id: "dev", label: "Dev server", command: "pnpm dev", tab: "dev" };

/** The value, or a failure that names the missing piece of the fixture. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture value is missing");
  return value;
}

/** A workspace store, a fake backend and the executor on top. `mount` plays the part of the UI. */
function setup() {
  const { ctx } = testContext();
  const backend = new FakeBackend();
  const first = createDefaultWorkspace();
  const spaceId = first.spaces[0]?.id ?? "";
  let ws: Workspace = reduce(first, { type: "space/set-defaults", spaceId, cwd: "/proj" }, ctx);
  const listeners = new Set<() => void>();
  const stops: Array<{ cwd: string; command: string }> = [];
  const notify = () => listeners.forEach((listener) => listener());
  const dispatch = (action: Action) => {
    ws = reduce(ws, action, ctx);
    notify();
  };
  const actions = createProjectActions({
    getWorkspace: () => ws,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    backend,
    runStop: async (cwd, command) => {
      stops.push({ cwd, command });
    },
  });

  const withSession = (layout: LayoutNode, paneId: string, sessionId: string): LayoutNode =>
    layout.kind === "pane"
      ? layout.pane.id === paneId
        ? { kind: "pane", pane: { ...layout.pane, sessionId } }
        : layout
      : { ...layout, children: layout.children.map((c) => withSession(c, paneId, sessionId)) };

  /** Gives a session to every pane that has none, as the terminal views do when they mount. */
  async function mount(): Promise<void> {
    for (const space of ws.spaces) {
      for (const item of Object.values(space.items)) {
        for (const pane of layoutPanes(item.layout)) {
          if (pane.sessionId !== undefined) continue;
          const id = await backend.createSession({
            cols: 80,
            rows: 24,
            ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
          });
          ws = {
            ...ws,
            spaces: ws.spaces.map((s) =>
              s.id === space.id
                ? {
                    ...s,
                    items: {
                      ...s.items,
                      [item.id]: {
                        ...item,
                        layout: withSession(item.layout, pane.id, String(id)),
                      },
                    },
                  }
                : s,
            ),
          };
          notify();
        }
      }
    }
  }

  const space = () => must(ws.spaces.find((s) => s.id === spaceId));
  const tabsTitled = (title: string) =>
    Object.values(space().items).filter((item) => item.title === title);
  const sessionOf = (title: string): number => {
    const item = must(tabsTitled(title)[0]);
    return Number(must(layoutPanes(item.layout)[0]).sessionId);
  };

  return {
    ws: () => ws,
    spaceId,
    space,
    backend,
    actions,
    stops,
    dispatch,
    mount,
    tabsTitled,
    sessionOf,
  };
}

// This package has no DOM or Node typings; the test runtime provides the global.
declare function setTimeout(handler: () => void, ms: number): unknown;

/** Lets the executor's pending promise chain run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("project actions: run", () => {
  it("opens the named tab in the folder of the space and types the command with Enter", async () => {
    const t = setup();
    const run = t.actions.run(t.spaceId, dev);
    await settle();
    // The tab exists and is shown before its session does.
    const [tab] = t.tabsTitled("dev");
    expect(tab?.titleLocked).toBe(true);
    expect(t.space().activeItemId).toBe(tab?.id);
    expect(layoutPanes(must(tab).layout)[0]?.cwd).toBe("/proj");
    expect(t.backend.callsTo("write")).toHaveLength(0);

    await t.mount();
    expect(await run).toBe("started");
    const writes = t.backend.callsTo("write");
    expect(writes.map((call) => call.args)).toEqual([[t.sessionOf("dev"), "pnpm dev\r"]]);
    expect(t.backend.session(t.sessionOf("dev"))?.cwd).toBe("/proj");
  });

  it("focuses the tab of a running action instead of opening another", async () => {
    const t = setup();
    const first = t.actions.run(t.spaceId, dev);
    await settle();
    await t.mount();
    await first;
    const itemsBefore = Object.keys(t.space().items).length;
    const other = must(Object.values(t.space().items).find((item) => item.title !== "dev"));
    t.dispatch({ type: "space/set-active-item", spaceId: t.spaceId, itemId: other.id });

    expect(await t.actions.run(t.spaceId, dev)).toBe("focused");
    expect(Object.keys(t.space().items)).toHaveLength(itemsBefore);
    expect(t.tabsTitled("dev")).toHaveLength(1);
    expect(t.space().activeItemId).toBe(t.tabsTitled("dev")[0]?.id);
    expect(t.backend.callsTo("write")).toHaveLength(1);
    expect(t.backend.callsTo("createSession")).toHaveLength(2); // the first tab and the action tab
  });

  it("types the command once when run is called again while the session is starting", async () => {
    const t = setup();
    const a = t.actions.run(t.spaceId, dev);
    const b = t.actions.run(t.spaceId, dev);
    await settle();
    await t.mount();
    await Promise.all([a, b]);
    expect(t.tabsTitled("dev")).toHaveLength(1);
    expect(t.backend.callsTo("write")).toHaveLength(1);
  });

  it("keeps following the tab after the user renames it", async () => {
    const t = setup();
    const run = t.actions.run(t.spaceId, dev);
    await settle();
    await t.mount();
    await run;
    const tab = must(t.tabsTitled("dev")[0]);
    t.dispatch({ type: "item/rename", itemId: tab.id, title: "my server" });

    expect(t.actions.status(t.spaceId, dev)).toBe("running");
    expect(await t.actions.run(t.spaceId, dev)).toBe("focused");
    expect(Object.values(t.space().items).filter((i) => i.title === "my server")).toHaveLength(1);
    expect(t.tabsTitled("dev")).toHaveLength(0);
  });

  it("finds an existing tab by its title when it did not open it", async () => {
    const t = setup();
    const run = t.actions.run(t.spaceId, dev);
    await settle();
    await t.mount();
    await run;
    // A second executor over the same workspace has no memory of the tab, as after a restart.
    const again = createProjectActions({
      getWorkspace: t.ws,
      subscribe: () => () => undefined,
      dispatch: t.dispatch,
      backend: t.backend,
      runStop: async () => undefined,
    });
    expect(again.status(t.spaceId, dev)).toBe("running");
    expect(await again.run(t.spaceId, dev)).toBe("focused");
    expect(t.tabsTitled("dev")).toHaveLength(1);
    again.dispose();
  });

  it("opens a fresh tab when the previous session of the action ended", async () => {
    const t = setup();
    const first = t.actions.run(t.spaceId, dev);
    await settle();
    await t.mount();
    await first;
    await t.backend.write(t.sessionOf("dev"), "exit 0\r");
    expect(t.actions.status(t.spaceId, dev)).toBe("idle");

    const second = t.actions.run(t.spaceId, dev);
    await settle();
    await t.mount();
    expect(await second).toBe("started");
    expect(t.tabsTitled("dev")).toHaveLength(1);
    expect(t.actions.status(t.spaceId, dev)).toBe("running");
    expect(t.backend.callsTo("write").filter((c) => c.args[1] === "pnpm dev\r")).toHaveLength(2);
  });

  it("gives up when the tab is closed before its session comes up", async () => {
    const t = setup();
    const run = t.actions.run(t.spaceId, dev);
    await settle();
    t.dispatch({ type: "item/close", itemId: must(t.tabsTitled("dev")[0]).id });
    expect(await run).toBe("abandoned");
    expect(t.backend.callsTo("write")).toHaveLength(0);
  });

  it("gives up on dispose", async () => {
    const t = setup();
    const run = t.actions.run(t.spaceId, dev);
    await settle();
    t.actions.dispose();
    expect(await run).toBe("abandoned");
  });

  it("rejects for an unknown space", async () => {
    const t = setup();
    await expect(t.actions.run("nope", dev)).rejects.toThrow(/Unknown space/);
    await expect(t.actions.stop("nope", dev)).rejects.toThrow(/Unknown space/);
    expect(t.actions.status("nope", dev)).toBe("idle");
  });
});

describe("project actions: stop", () => {
  async function running(action: ProjectAction) {
    const t = setup();
    const run = t.actions.run(t.spaceId, action);
    await settle();
    await t.mount();
    await run;
    return t;
  }

  it("runs the stop command in the folder of the space and leaves the tab alone", async () => {
    const t = await running(loop);
    await t.actions.stop(t.spaceId, loop);
    expect(t.stops).toEqual([{ cwd: "/proj", command: "loop parar" }]);
    expect(t.backend.callsTo("kill")).toHaveLength(0);
  });

  it("ends the session of the tab when there is no stop command", async () => {
    const t = await running(dev);
    const session = t.sessionOf("dev");
    await t.actions.stop(t.spaceId, dev);
    expect(t.stops).toHaveLength(0);
    expect(t.backend.callsTo("kill").map((call) => call.args)).toEqual([[session]]);
    expect(t.backend.session(session)?.alive).toBe(false);
    expect(t.actions.status(t.spaceId, dev)).toBe("idle");
  });

  it("does nothing without a stop command and without a tab", async () => {
    const t = setup();
    await t.actions.stop(t.spaceId, dev);
    expect(t.backend.callsTo("kill")).toHaveLength(0);
    expect(t.stops).toHaveLength(0);
  });

  it("refuses to run a stop command in a space with no folder", async () => {
    const t = setup();
    t.dispatch({ type: "space/set-defaults", spaceId: t.spaceId, cwd: " " });
    await expect(t.actions.stop(t.spaceId, loop)).rejects.toThrow(/no folder/);
    expect(t.stops).toHaveLength(0);
  });
});

describe("project actions: status", () => {
  it("is idle without a tab, running while the session lives and idle again after it ends", async () => {
    const t = setup();
    expect(t.actions.status(t.spaceId, dev)).toBe("idle");

    const exits: number[] = [];
    t.actions.onExit(() => exits.push(exits.length));

    const run = t.actions.run(t.spaceId, dev);
    await settle();
    // The tab is open but has no session yet.
    expect(t.actions.status(t.spaceId, dev)).toBe("idle");
    await t.mount();
    await run;
    expect(t.actions.status(t.spaceId, dev)).toBe("running");
    expect(t.actions.status(t.spaceId, loop)).toBe("idle");

    await t.backend.write(t.sessionOf("dev"), "exit 3\r");
    expect(t.actions.status(t.spaceId, dev)).toBe("idle");
    expect(exits).toEqual([0]);
  });

  it("is idle once the tab is closed", async () => {
    const t = setup();
    const run = t.actions.run(t.spaceId, dev);
    await settle();
    await t.mount();
    await run;
    t.dispatch({ type: "item/close", itemId: must(t.tabsTitled("dev")[0]).id });
    expect(t.actions.status(t.spaceId, dev)).toBe("idle");
  });
});
