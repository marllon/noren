import { describe, expect, it } from "vitest";
import {
  FakeBackend,
  ManualClock,
  createDefaultWorkspace,
  createSequentialIds,
} from "@noren/model";
import { appSpaceSyncPort } from "./space-sync";
import { runPushOnClose } from "./sync-run";
import type { PushOnCloseDeps } from "./sync-run";
import { createWorkspaceStore } from "./workspace-store";

// The push when the app closes (NOR-F19-01d): `runPushOnClose` is what the save of the closing page
// runs after the state is written. It pushes only when the option is on, a remote is connected and
// something waits; and whatever happens, it ends within its limit and never rejects.

const REMOTE = "https://example.com/me/settings.git";
const LIMIT = 4000;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { enabled?: boolean; connect?: boolean } = {}) {
  const backend = new FakeBackend();
  const store = createWorkspaceStore({
    backend,
    workspace: createDefaultWorkspace(),
    newId: createSequentialIds("t"),
  });
  const clock = new ManualClock();
  const log: string[] = [];
  const enabled = { value: options.enabled ?? true };
  const deps: PushOnCloseDeps = {
    backend,
    spaces: appSpaceSyncPort(store, backend),
    enabled: () => enabled.value,
    clock,
    limitMs: LIMIT,
    log: (message) => void log.push(message),
  };
  const ready =
    options.connect === false ? Promise.resolve() : backend.syncConnect(REMOTE).then(() => {});
  return { backend, store, clock, log, enabled, deps, ready };
}

const callsTo = (backend: FakeBackend, method: "syncPush" | "syncWriteSpaceFiles"): number =>
  backend.callsTo(method).length;

describe("runPushOnClose", () => {
  it("pushes the pending files and the spaces when it is on and a remote is connected", async () => {
    const { backend, deps, ready, log } = setup();
    await ready;
    backend.setSyncLocalFile("config.jsonc", '{ "terminal": { "scrollback": 500 } }\n');
    const outcome = await runPushOnClose(deps);
    expect(outcome).toEqual({ kind: "pushed", files: 2 });
    expect(Object.keys(backend.syncRemoteFiles()).sort()).toEqual([
      "config.jsonc",
      expect.stringMatching(/^spaces\/.*\.noren-space\.json$/) as unknown as string,
    ]);
    expect(log).toEqual([]);
  });

  it("does nothing, and asks the backend for nothing, when the option is off", async () => {
    const { backend, deps, ready, log } = setup({ enabled: false });
    await ready;
    backend.setSyncLocalFile("config.jsonc", "{}");
    const before = backend.calls.length;
    expect(await runPushOnClose(deps)).toEqual({ kind: "skipped", reason: "off" });
    expect(backend.calls.length).toBe(before);
    expect(backend.syncRemoteFiles()).toEqual({});
    expect(log).toEqual([]);
  });

  it("reads the option when the close happens, not when the push was set up", async () => {
    const { backend, deps, ready, enabled } = setup({ enabled: false });
    await ready;
    backend.setSyncLocalFile("config.jsonc", "{}");
    expect((await runPushOnClose(deps)).kind).toBe("skipped");
    enabled.value = true;
    expect((await runPushOnClose(deps)).kind).toBe("pushed");
    enabled.value = false;
    backend.setSyncLocalFile("mods/a.css", "/* a */\n");
    expect((await runPushOnClose(deps)).kind).toBe("skipped");
    expect(backend.syncRemoteFiles()["mods/a.css"]).toBeUndefined();
  });

  it("does not try to push with no remote connected, and writes no space file", async () => {
    const { backend, deps, log } = setup({ connect: false });
    backend.setSyncLocalFile("config.jsonc", "{}");
    expect(await runPushOnClose(deps)).toEqual({ kind: "skipped", reason: "no-remote" });
    expect(callsTo(backend, "syncPush")).toBe(0);
    expect(callsTo(backend, "syncWriteSpaceFiles")).toBe(0);
    expect(log).toEqual([]);
  });

  it("does not push when nothing waits: after one push the next close sends nothing", async () => {
    const { backend, deps, ready } = setup();
    await ready;
    expect((await runPushOnClose(deps)).kind).toBe("pushed");
    expect(callsTo(backend, "syncPush")).toBe(1);
    expect(await runPushOnClose(deps)).toEqual({ kind: "skipped", reason: "nothing-pending" });
    expect(callsTo(backend, "syncPush")).toBe(1);
  });

  it("pushes for a change of the config folder alone, with the spaces already written", async () => {
    const { backend, deps, ready } = setup();
    await ready;
    await runPushOnClose(deps);
    backend.setSyncLocalFile("config.jsonc", '{ "language": "en" }\n');
    expect(await runPushOnClose(deps)).toEqual({ kind: "pushed", files: 1 });
    expect(backend.syncRemoteFiles()["config.jsonc"]).toBe('{ "language": "en" }\n');
  });

  it("pushes for a space that changed even when no other file did", async () => {
    const { backend, store, deps, ready } = setup();
    await ready;
    await runPushOnClose(deps);
    store.getState().dispatch({ type: "space/create", name: "Work" });
    expect(await runPushOnClose(deps)).toEqual({ kind: "pushed", files: 1 });
    expect(Object.keys(backend.syncRemoteFiles())).toContain("spaces/Work.noren-space.json");
  });

  it("an error of the push is recorded and does not reject: the close goes on", async () => {
    const { backend, deps, ready, log } = setup();
    await ready;
    backend.setSyncLocalFile("config.jsonc", "{}");
    backend.setSyncFailure(new Error("git is not installed"));
    const outcome = await runPushOnClose(deps);
    expect(outcome).toEqual({ kind: "failed", reason: "git is not installed" });
    expect(log).toEqual(["push on close failed: git is not installed"]);
  });

  it("a remote that moved on is a refusal that is recorded, and nothing is overwritten", async () => {
    const { backend, deps, ready, log } = setup();
    await ready;
    backend.setSyncLocalFile("config.jsonc", "{}");
    backend.setSyncRemoteFile("mods/a.css", "/* a */\n");
    const outcome = await runPushOnClose(deps);
    expect(outcome.kind).toBe("failed");
    expect(log[0]).toMatch(/^push on close failed: .*pull first/);
    expect(backend.syncRemoteFiles()).toEqual({ "mods/a.css": "/* a */\n" });
  });

  it("an error while writing the space files is recorded too", async () => {
    const { backend, deps, ready, log } = setup();
    await ready;
    backend.syncWriteSpaceFiles = () => Promise.reject(new Error("disk full"));
    const outcome = await runPushOnClose(deps);
    expect(outcome).toEqual({ kind: "failed", reason: "disk full" });
    expect(log).toEqual(["push on close failed: disk full"]);
    expect(callsTo(backend, "syncPush")).toBe(0);
  });

  it("gives up at the limit when the push is too slow, records it, and the close goes on", async () => {
    const { backend, deps, ready, clock, log } = setup();
    await ready;
    backend.setSyncLocalFile("config.jsonc", "{}");
    backend.syncPush = () => new Promise(() => undefined);
    let outcome: Awaited<ReturnType<typeof runPushOnClose>> | undefined;
    void runPushOnClose(deps).then((done) => {
      outcome = done;
    });
    await settle();
    clock.advance(LIMIT - 1);
    await settle();
    expect(outcome).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(outcome).toEqual({ kind: "timeout" });
    expect(log).toEqual([`push on close given up after ${LIMIT} ms`]);
  });

  it("gives up at the limit when the status itself never answers", async () => {
    const { backend, deps, ready, clock } = setup();
    await ready;
    backend.syncStatus = () => new Promise(() => undefined);
    let outcome: Awaited<ReturnType<typeof runPushOnClose>> | undefined;
    void runPushOnClose(deps).then((done) => {
      outcome = done;
    });
    await settle();
    clock.advance(LIMIT);
    await settle();
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("leaves no timer behind when it ends in time", async () => {
    const { deps, ready, clock } = setup();
    await ready;
    await runPushOnClose(deps);
    expect(clock.pending).toBe(0);
  });

  it("a push that finishes after the limit changes nothing about what was already answered", async () => {
    const { backend, deps, ready, clock } = setup();
    await ready;
    backend.setSyncLocalFile("config.jsonc", "{}");
    const late: { release?: (value: never) => void } = {};
    const real = backend.syncPush.bind(backend);
    backend.syncPush = () =>
      new Promise((resolve, reject) => {
        late.release = () => real().then(resolve, reject);
      }) as ReturnType<typeof real>;
    let outcome: Awaited<ReturnType<typeof runPushOnClose>> | undefined;
    void runPushOnClose(deps).then((done) => {
      outcome = done;
    });
    await settle();
    clock.advance(LIMIT);
    await settle();
    expect(outcome).toEqual({ kind: "timeout" });
    late.release?.(undefined as never);
    await settle();
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("works without the spaces of a window: only the config folder is pushed", async () => {
    const { backend, deps, ready } = setup();
    await ready;
    backend.setSyncLocalFile("config.jsonc", "{}");
    expect(await runPushOnClose({ ...deps, spaces: undefined })).toEqual({
      kind: "pushed",
      files: 1,
    });
    expect(Object.keys(backend.syncRemoteFiles())).toEqual(["config.jsonc"]);
  });
});
