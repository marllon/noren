import {
  FakeBackend,
  TerminalTail,
  createSequentialIds,
  layoutPanes,
  restoreWorkspace,
} from "@noren/model";
import type { ApiCall, ApiOutcome } from "@noren/model";
import { describe, expect, it, vi } from "vitest";
import {
  API_CALL_EVENT,
  API_RESPOND_COMMAND,
  appApiHost,
  startApiListener,
  startLocalApi,
} from "./api-bridge";
import type { TauriBridge } from "./tauri-backend";
import { createWorkspaceStore } from "./workspace-store";

interface Invocation {
  command: string;
  args: Record<string, unknown> | undefined;
}

/** A bridge whose event is fired by the test and whose `invoke` records the answers. */
function fakeBridge(options: { failRespond?: boolean } = {}) {
  const invocations: Invocation[] = [];
  let handler: ((event: { payload: unknown }) => void) | undefined;
  let unlistened = 0;
  const bridge: Pick<TauriBridge, "invoke" | "listen"> = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      invocations.push({ command, args });
      return options.failRespond === true
        ? Promise.reject(new Error("the window is closing"))
        : Promise.resolve(undefined as T);
    },
    listen: (event, next) => {
      if (event === API_CALL_EVENT) handler = next as typeof handler;
      return Promise.resolve(() => {
        unlistened++;
      });
    },
  };
  return {
    bridge,
    invocations,
    unlistened: () => unlistened,
    listening: () => handler !== undefined,
    emit: (payload: unknown) => handler?.({ payload }),
    answers: () => invocations.filter((i) => i.command === API_RESPOND_COMMAND),
  };
}

/** The byte of Ctrl+C. */
const CTRL_C = "\u0003";
/** Three lines of output, with the line ends a shell prints. */
const FEED = "first\r\nsecond\r\nthird\r\n";

/** The first pane of the first tab of the first space, which the restore gave a shell. */
function firstPane(store: ReturnType<typeof createWorkspaceStore>) {
  const space = store.getState().workspace.spaces[0];
  const item = space && Object.values(space.items)[0];
  const pane = item && layoutPanes(item.layout)[0];
  if (pane === undefined) throw new Error("the workspace has no pane");
  return { pane };
}

/** Lets the promises that are ready run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the listener of the local API", () => {
  it("listens for the call event and answers each call with the outcome of its run, by id", async () => {
    const fake = fakeBridge();
    const run = vi.fn(async (call: ApiCall): Promise<ApiOutcome> => ({
      result: { echoed: call.method },
    }));
    startApiListener({ bridge: fake.bridge, run });
    await settle();
    expect(fake.listening()).toBe(true);

    fake.emit({ id: 41, method: "spaces.list", params: {} });
    await settle();

    // The call is what the server validated, without the id the bridge gave it.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ method: "spaces.list", params: {} });
    expect(fake.answers()).toEqual([
      {
        command: API_RESPOND_COMMAND,
        args: { id: 41, outcome: { result: { echoed: "spaces.list" } } },
      },
    ]);
  });

  it("answers an error outcome as it is, with its code", async () => {
    const fake = fakeBridge();
    const error: ApiOutcome = { error: { code: "not_found", message: "no such terminal" } };
    startApiListener({ bridge: fake.bridge, run: async () => error });
    await settle();
    fake.emit({ id: 1, method: "terminal.read", params: { terminal: "x" } });
    await settle();
    expect(fake.answers()[0]?.args).toEqual({ id: 1, outcome: error });
  });

  it("answers an internal error when the run itself rejects, and goes on", async () => {
    const fake = fakeBridge();
    let first = true;
    startApiListener({
      bridge: fake.bridge,
      run: async () => {
        if (first) {
          first = false;
          throw new Error("boom");
        }
        return { result: null };
      },
    });
    await settle();
    fake.emit({ id: 1, method: "spaces.list", params: {} });
    fake.emit({ id: 2, method: "spaces.list", params: {} });
    await settle();
    const [one, two] = fake.answers().map((a) => a.args);
    expect(one).toMatchObject({ id: 1, outcome: { error: { code: "internal" } } });
    expect(JSON.stringify(one)).toContain("boom");
    expect(two).toEqual({ id: 2, outcome: { result: null } });
  });

  it("drops an event that has no id it could answer, running nothing", async () => {
    const fake = fakeBridge();
    const run = vi.fn(async (): Promise<ApiOutcome> => ({ result: null }));
    startApiListener({ bridge: fake.bridge, run });
    await settle();
    for (const payload of [
      null,
      undefined,
      "spaces.list",
      42,
      [],
      {},
      { method: "spaces.list", params: {} },
      { id: "7", method: "spaces.list", params: {} },
      { id: -1, method: "spaces.list", params: {} },
      { id: 1.5, method: "spaces.list", params: {} },
      { id: 2 ** 60, method: "spaces.list", params: {} },
      { id: null, method: "spaces.list", params: {} },
    ]) {
      fake.emit(payload);
    }
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(fake.invocations).toEqual([]);
  });

  it("runs calls side by side and answers each with its own id", async () => {
    const fake = fakeBridge();
    const releases: Array<() => void> = [];
    startApiListener({
      bridge: fake.bridge,
      run: (call) =>
        new Promise<ApiOutcome>((resolve) => {
          releases.push(() => resolve({ result: call.method }));
        }),
    });
    await settle();
    fake.emit({ id: 1, method: "spaces.list", params: {} });
    fake.emit({ id: 2, method: "spaces.create", params: { name: "x" } });
    await settle();
    // Both are running at once: the second did not wait for the first.
    expect(releases).toHaveLength(2);
    releases[1]?.();
    await settle();
    expect(fake.answers().map((a) => a.args)).toEqual([
      { id: 2, outcome: { result: "spaces.create" } },
    ]);
    releases[0]?.();
    await settle();
    expect(fake.answers().map((a) => (a.args as { id: number }).id)).toEqual([2, 1]);
  });

  it("is not stopped by an answer the Rust side refuses", async () => {
    const fake = fakeBridge({ failRespond: true });
    const run = vi.fn(async (): Promise<ApiOutcome> => ({ result: 1 }));
    startApiListener({ bridge: fake.bridge, run });
    await settle();
    fake.emit({ id: 1, method: "spaces.list", params: {} });
    fake.emit({ id: 2, method: "spaces.list", params: {} });
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops hearing when it is stopped, also when it is stopped before the listening began", async () => {
    const fake = fakeBridge();
    const run = vi.fn(async (): Promise<ApiOutcome> => ({ result: 1 }));
    const stop = startApiListener({ bridge: fake.bridge, run });
    await settle();
    stop();
    expect(fake.unlistened()).toBe(1);
    fake.emit({ id: 1, method: "spaces.list", params: {} });
    await settle();
    expect(run).not.toHaveBeenCalled();
    stop();
    expect(fake.unlistened()).toBe(1);

    const early = fakeBridge();
    const stopEarly = startApiListener({ bridge: early.bridge, run });
    stopEarly();
    await settle();
    expect(early.unlistened()).toBe(1);
  });

  it("does nothing when the Rust side cannot be listened to", async () => {
    const run = vi.fn(async (): Promise<ApiOutcome> => ({ result: 1 }));
    const stop = startApiListener({
      bridge: {
        invoke: () => Promise.resolve(undefined as never),
        listen: () => Promise.reject(new Error("no events")),
      },
      run,
    });
    await settle();
    expect(() => stop()).not.toThrow();
  });
});

// ---- the page's host: the real workspace store and the fake shells -------------------------------

async function openApp() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const clock = { now: () => 1000 };
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  const tail = new TerminalTail();
  const fake = fakeBridge();
  startLocalApi({ store, backend, tail, bridge: fake.bridge });
  await settle();
  let next = 100;
  /** Fires a call as the Rust side does and returns what the page answered. */
  const call = async (method: string, params: Record<string, unknown>) => {
    const id = next++;
    fake.emit({ id, method, params });
    await vi.waitFor(() => {
      expect(fake.answers().some((a) => (a.args as { id: number }).id === id)).toBe(true);
    });
    const answer = fake.answers().find((a) => (a.args as { id: number }).id === id);
    return (answer?.args as { outcome: Record<string, unknown> }).outcome;
  };
  return { backend, store, tail, fake, call };
}

describe("the local API over the app's workspace", () => {
  it("lists the spaces of the workspace the store holds", async () => {
    const { store, call } = await openApp();
    const outcome = await call("spaces.list", {});
    const spaces = (outcome["result"] as { spaces: Array<{ id: string }> }).spaces;
    expect(spaces.map((s) => s.id)).toEqual(store.getState().workspace.spaces.map((s) => s.id));
  });

  it("makes a space in the store without showing it", async () => {
    const { store, call } = await openApp();
    const before = store.getState().workspace.activeSpaceId;
    const outcome = await call("spaces.create", { name: "Automation" });
    expect(outcome["error"]).toBeUndefined();
    const spaces = store.getState().workspace.spaces;
    expect(spaces.map((s) => s.name)).toContain("Automation");
    expect(store.getState().workspace.activeSpaceId).toBe(before);
  });

  it("opens a tab with a shell of its own through the backend and the store", async () => {
    const { store, backend, call } = await openApp();
    const spaceId = store.getState().workspace.activeSpaceId;
    const startedBefore = backend.callsTo("createSession").length;
    const outcome = await call("items.create", { space: spaceId });
    expect(outcome["error"]).toBeUndefined();
    expect(backend.callsTo("createSession").length).toBe(startedBefore + 1);
    const space = store.getState().workspace.spaces.find((s) => s.id === spaceId);
    const items = Object.values(space?.items ?? {});
    const withApiShell = items.filter((item) =>
      layoutPanes(item.layout).some((pane) => pane.sessionId !== undefined),
    );
    expect(withApiShell.length).toBeGreaterThanOrEqual(2);
  });

  it("answers not_found for an id that is not in the workspace and starts no shell", async () => {
    const { backend, call } = await openApp();
    const startedBefore = backend.callsTo("createSession").length;
    const outcome = await call("items.create", { space: "no-such-space" });
    expect(outcome).toMatchObject({ error: { code: "not_found" } });
    expect(backend.callsTo("createSession").length).toBe(startedBefore);
  });

  it("answers invalid_params for a call the server would not have let through", async () => {
    const { call } = await openApp();
    expect(await call("terminal.read", { terminal: "x", lines: 0 })).toMatchObject({
      error: { code: "invalid_params" },
    });
    expect(await call("not.a.method", {})).toMatchObject({ error: { code: "unknown_method" } });
  });

  it("types into the shell of a pane exactly what the call carries, and never an Enter (D8)", async () => {
    const { store, backend, call } = await openApp();
    const { pane } = firstPane(store);
    const terminal = pane.id;
    const writesBefore = backend.callsTo("write").length;
    const outcome = await call("terminal.send", { terminal, text: "rm -rf build" });
    expect(outcome["error"]).toBeUndefined();
    // Keys by name: Ctrl+C is the one byte, and there is no line end anywhere.
    await call("terminal.send", { terminal, keys: ["Ctrl+C"] });
    const sent = backend
      .callsTo("write")
      .slice(writesBefore)
      .map((c) => c.args[1]);
    expect(sent).toEqual(["rm -rf build", CTRL_C]);
  });

  it("reads the last lines from the tail the backend feeds", async () => {
    const { store, tail, call } = await openApp();
    const { pane } = firstPane(store);
    tail.feed(Number(pane.sessionId), FEED);
    const outcome = await call("terminal.read", { terminal: pane.id, lines: 2 });
    expect(outcome).toEqual({
      result: { terminal: pane.id, lines: ["second", "third"], truncated: false },
    });
  });

  it("builds the host from the store, the backend and the tail", async () => {
    const backend = new FakeBackend();
    const newId = createSequentialIds("h");
    const clock = { now: () => 1 };
    const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
    const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
    const tail = new TerminalTail();
    const host = appApiHost({ store, backend, tail });
    expect(host.workspace()).toBe(store.getState().workspace);
    tail.feed(5, "a\r\nb\r\n");
    expect(host.readLines(5, 10)).toEqual(["a", "b"]);
    expect(host.backend).toBe(backend);
  });
});
