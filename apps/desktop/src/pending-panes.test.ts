import {
  FakeBackend,
  createSequentialIds,
  layoutPanes,
  restoreWorkspace,
  serializeWorkspace,
} from "@noren/model";
import type { Pane, Workspace } from "@noren/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingPanes } from "./pending-panes";
import { queuePendingPanes } from "./pending-start";
import { ResumeService } from "./resume-service";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

// The shells of the tabs the restore left for later (NOR-F20-14a): the queue, and the start of a
// pane as the boot does it.

const clock = { now: () => 1000 };

const never = () => new Promise<void>(() => undefined);

describe("PendingPanes", () => {
  it("starts nothing before it is released, and then one pane after the other in order", async () => {
    const queue = new PendingPanes();
    const order: string[] = [];
    let finish = (): void => undefined;
    queue.load(["a", "b", "c"], (id) => {
      order.push(`start ${id}`);
      return id === "a"
        ? new Promise<void>((done) => {
            finish = done;
          })
        : Promise.resolve();
    });
    expect(queue.count).toBe(3);
    expect(queue.waiting("a")).toBe(true);
    await Promise.resolve();
    expect(order).toEqual([]);

    queue.release();
    await Promise.resolve();
    // "b" waits for "a": the shells start one after the other.
    expect(order).toEqual(["start a"]);
    finish();
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(order).toEqual(["start a", "start b", "start c"]);
    expect(queue.waiting("b")).toBe(false);
  });

  it("starts as many panes at once as it was told to, and no more", async () => {
    const queue = new PendingPanes(2);
    const open: string[] = [];
    const finish = new Map<string, () => void>();
    queue.load(["a", "b", "c", "d"], (id) => {
      open.push(id);
      return new Promise<void>((done) => finish.set(id, done));
    });
    queue.release();
    expect(open).toEqual(["a", "b"]);
    finish.get("a")?.();
    await vi.waitFor(() => expect(open).toEqual(["a", "b", "c"]));
    finish.get("b")?.();
    await vi.waitFor(() => expect(open).toEqual(["a", "b", "c", "d"]));
    finish.get("c")?.();
    finish.get("d")?.();
    await vi.waitFor(() => expect(queue.count).toBe(0));
  });

  it("starts a prioritized pane before the queue is released, and before the ones ahead of it", async () => {
    const queue = new PendingPanes();
    const order: string[] = [];
    queue.load(["a", "b", "c"], (id) => {
      order.push(id);
      return Promise.resolve();
    });
    queue.prioritize(["c", "not-waiting"]);
    await vi.waitFor(() => expect(queue.waiting("c")).toBe(false));
    expect(order).toEqual(["c"]);
    expect(queue.waiting("a")).toBe(true);

    queue.release();
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(order).toEqual(["c", "a", "b"]);
  });

  it("puts a prioritized pane ahead of the rest while the queue is running", async () => {
    const queue = new PendingPanes();
    const order: string[] = [];
    let finish = (): void => undefined;
    queue.load(["a", "b", "c", "d"], (id) => {
      order.push(id);
      return id === "a"
        ? new Promise<void>((done) => {
            finish = done;
          })
        : Promise.resolve();
    });
    queue.release();
    await Promise.resolve();
    queue.prioritize(["d"]);
    finish();
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(order).toEqual(["a", "d", "b", "c"]);
  });

  it("tells its listeners when a pane stops waiting, and a pane whose start throws stops waiting too", async () => {
    const queue = new PendingPanes();
    const heard = vi.fn();
    queue.subscribe(heard);
    queue.load(["a", "b"], (id) => (id === "a" ? Promise.reject(new Error("boom")) : never()));
    heard.mockClear();
    queue.release();
    await vi.waitFor(() => expect(queue.waiting("a")).toBe(false));
    expect(heard).toHaveBeenCalled();
    expect(queue.waiting("b")).toBe(true);
  });

  it("says it is settled at once when nothing waits, and once when the last pane has its shell", async () => {
    const queue = new PendingPanes();
    const now = vi.fn();
    queue.whenSettled(now);
    expect(now).toHaveBeenCalledTimes(1);

    const later = vi.fn();
    queue.load(["a", "b"], () => Promise.resolve());
    queue.whenSettled(later);
    expect(later).not.toHaveBeenCalled();
    queue.prioritize(["a"]);
    await vi.waitFor(() => expect(queue.waiting("a")).toBe(false));
    expect(later).not.toHaveBeenCalled();
    queue.release();
    await vi.waitFor(() => expect(later).toHaveBeenCalledTimes(1));
    expect(queue.count).toBe(0);
  });

  it("keeps a held release until it is let go, but still starts a pane asked for", async () => {
    const queue = new PendingPanes();
    const order: string[] = [];
    queue.hold();
    queue.load(["a", "b"], (id) => {
      order.push(id);
      return Promise.resolve();
    });
    queue.release();
    queue.prioritize(["b"]);
    await vi.waitFor(() => expect(queue.waiting("b")).toBe(false));
    expect(order).toEqual(["b"]);
    expect(queue.waiting("a")).toBe(true);

    queue.unhold();
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(order).toEqual(["b", "a"]);
  });

  it("stops telling a listener that unsubscribed", () => {
    const queue = new PendingPanes();
    const heard = vi.fn();
    const stop = queue.subscribe(heard);
    stop();
    queue.load(["a"], never);
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("queuePendingPanes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A state with `tabs` tabs in one space; the last one made is the one on screen. */
  async function savedTabs(tabs: number, edit?: (panes: Pane[]) => void): Promise<string> {
    const backend = new FakeBackend();
    const newId = createSequentialIds("n");
    const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
    const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
    for (let i = 1; i < tabs; i++) store.getState().newTab();
    const workspace = store.getState().workspace;
    edit?.(
      workspace.spaces.flatMap((space) =>
        Object.values(space.items).flatMap((item) => layoutPanes(item.layout)),
      ),
    );
    return serializeWorkspace(workspace);
  }

  async function start(state: string, backend = new FakeBackend({ state }), concurrency = 1) {
    const restored = await restoreWorkspace(backend, {
      defaults: { newId: createSequentialIds("d"), clock },
      start: "visible",
    });
    const store = createWorkspaceStore({
      backend,
      workspace: restored.workspace,
      failedPaneIds: restored.failedPaneIds,
      newId: createSequentialIds("w"),
      clock,
    });
    const queue = new PendingPanes(concurrency);
    const resume = new ResumeService();
    const scrollback = new Map<string, string>();
    for (const space of restored.workspace.spaces) {
      for (const item of Object.values(space.items)) {
        for (const pane of layoutPanes(item.layout)) scrollback.set(pane.id, `saved ${pane.id}`);
      }
    }
    queuePendingPanes({
      pending: restored.pending,
      workspace: restored.workspace,
      store,
      queue,
      scrollback,
      settings: () => ({ enabled: true, resumeOnRestore: true, catalog: [] }),
      backend,
      resume,
    });
    return { backend, restored, store, queue, scrollback, resume };
  }

  const sessions = (store: ReturnType<typeof createWorkspaceStore>) =>
    Object.values(activeSpaceOf(store.getState().workspace).items).map((item) => {
      const pane = layoutPanes(item.layout)[0];
      return pane?.sessionId;
    });

  it("starts the shell of the tab on screen only, and the others once the queue is released", async () => {
    const { backend, restored, store, queue } = await start(await savedTabs(4));
    expect(restored.pending).toHaveLength(3);
    expect(backend.callsTo("createSession")).toHaveLength(1);
    expect(sessions(store).filter((id) => id !== undefined)).toHaveLength(1);

    queue.release();
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(backend.callsTo("createSession")).toHaveLength(4);
    expect(sessions(store).every((id) => id !== undefined)).toBe(true);
    expect(new Set(sessions(store)).size).toBe(4);
  });

  it("records the panes that got a shell in groups, not one change of the store for each", async () => {
    const state = await savedTabs(8);
    const { store, queue } = await start(state, new FakeBackend({ state }), 8);
    let changes = 0;
    store.subscribe((state, before) => {
      if (state.workspace !== before.workspace) changes++;
    });
    queue.release();
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(sessions(store).every((id) => id !== undefined)).toBe(true);
    // Seven panes came in; the store changed once, or twice at the most (a group per window).
    expect(changes).toBeGreaterThan(0);
    expect(changes).toBeLessThanOrEqual(2);
  });

  it("lets the queue run at once when no shell is on screen to show a first prompt", async () => {
    const backend = new FakeBackend({ state: await savedTabs(3) });
    const restored = await restoreWorkspace(backend, { start: "visible" });
    // Take the shell of the tab on screen away, as a tab of previews would have none.
    const workspace = JSON.parse(JSON.stringify(restored.workspace), (key, value: unknown) =>
      key === "sessionId" ? undefined : value,
    ) as Workspace;
    const store = createWorkspaceStore({
      backend,
      workspace,
      newId: createSequentialIds("w"),
      clock,
    });
    const queue = new PendingPanes();
    queuePendingPanes({
      pending: restored.pending,
      workspace,
      store,
      queue,
      scrollback: undefined,
      settings: () => ({ enabled: true, resumeOnRestore: true, catalog: [] }),
      backend,
      resume: new ResumeService(),
    });
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(backend.callsTo("createSession")).toHaveLength(restored.pending.length + 1);
  });

  it("lets the queue run by itself if no first prompt ever shows", async () => {
    const { backend, queue } = await start(await savedTabs(3));
    expect(backend.callsTo("createSession")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(backend.callsTo("createSession")).toHaveLength(3);
  });

  it("starts a tab at once when it is opened before its turn", async () => {
    const { backend, store, queue } = await start(await savedTabs(4));
    const space = activeSpaceOf(store.getState().workspace);
    const behind = spaceItemIds(space)[0] as string;
    const item = space.items[behind];
    const pane = item && layoutPanes(item.layout)[0];
    if (!pane) throw new Error("no pane");

    queue.prioritize([pane.id]);
    await vi.waitFor(() => expect(queue.waiting(pane.id)).toBe(false));
    expect(backend.callsTo("createSession")).toHaveLength(2);
    const after = activeSpaceOf(store.getState().workspace).items[behind];
    expect(after && layoutPanes(after.layout)[0]?.sessionId).toBeDefined();
  });

  it("gives back the shell the backend kept and leaves its saved scrollback out", async () => {
    const state = await savedTabs(3);
    const backend = new FakeBackend({ state });
    const kept = await backend.createSession({ cols: 80, rows: 24 });
    const workspace = JSON.parse(state) as { spaces: { items: Record<string, unknown> }[] };
    const paneIds = workspace.spaces.flatMap((space) =>
      Object.values(space.items).flatMap((item) =>
        layoutPanes((item as { layout: never }).layout).map((pane: Pane) => pane.id),
      ),
    );
    const first = paneIds[0] as string;
    backend.holdSessionForPane(first, kept);

    const { store, queue, scrollback, restored } = await start(state, backend);
    expect(restored.pending.map((pane) => pane.paneId)).toContain(first);
    queue.release();
    await vi.waitFor(() => expect(queue.count).toBe(0));

    const all = activeSpaceOf(store.getState().workspace);
    const held = Object.values(all.items)
      .flatMap((item) => layoutPanes(item.layout))
      .find((pane) => pane.id === first);
    expect(held?.sessionId).toBe(String(kept));
    expect(scrollback.has(first)).toBe(false);
    expect(scrollback.size).toBe(paneIds.length - 1);
  });

  it("starts nothing for a pane that closed meanwhile, or that got a shell some other way", async () => {
    const { backend, store, queue } = await start(await savedTabs(4));
    const space = activeSpaceOf(store.getState().workspace);
    const [first, second] = spaceItemIds(space);
    const firstPane = layoutPanes((space.items[first as string] as never)["layout"])[0] as Pane;
    const secondPane = layoutPanes((space.items[second as string] as never)["layout"])[0] as Pane;

    store.getState().dispatch({ type: "item/close", itemId: first as string });
    store.getState().attachSession(secondPane.id, "999");
    queue.release();
    await vi.waitFor(() => expect(queue.count).toBe(0));

    // The visible tab, and the one left: the closed pane and the one with a shell started none.
    expect(backend.callsTo("createSession")).toHaveLength(2);
    expect(firstPane.id).not.toBe(secondPane.id);
  });

  it("marks a pane whose shell cannot start as exited and failed", async () => {
    const { backend, store, queue } = await start(await savedTabs(2));
    backend.createSession = () => Promise.reject(new Error("no shell"));
    queue.release();
    await vi.waitFor(() => expect(queue.count).toBe(0));

    const panes = Object.values(activeSpaceOf(store.getState().workspace).items).flatMap((item) =>
      layoutPanes(item.layout),
    );
    const failed = panes.filter((pane) => pane.sessionId === undefined);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("exited");
    expect(store.getState().failedPaneIds).toEqual([failed[0]?.id]);
  });

  it("arms the resume of an agent a pane was running when its shell starts", async () => {
    const state = await savedTabs(2, (panes) => {
      const behind = panes[0];
      if (behind) behind.runningCommand = { text: "alpha --work" };
    });
    const backend = new FakeBackend({ state });
    const restored = await restoreWorkspace(backend, { start: "visible" });
    const armed: string[] = [];
    const resume = new ResumeService();
    vi.spyOn(resume, "arm").mockImplementation((paneId) => {
      armed.push(paneId);
    });
    const store = createWorkspaceStore({
      backend,
      workspace: restored.workspace,
      newId: createSequentialIds("w"),
      clock,
    });
    const queue = new PendingPanes();
    queuePendingPanes({
      pending: restored.pending,
      workspace: restored.workspace,
      store,
      queue,
      scrollback: undefined,
      settings: () => ({
        enabled: true,
        resumeOnRestore: true,
        catalog: [{ id: "alpha", executables: ["alpha"], resume: "alpha --resume" }],
      }),
      backend,
      resume,
    });
    expect(armed).toEqual([]);
    queue.release();
    await vi.waitFor(() => expect(queue.count).toBe(0));
    expect(armed).toHaveLength(1);
  });
});
