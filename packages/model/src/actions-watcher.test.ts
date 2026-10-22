import { describe, expect, it } from "vitest";
import type { ActionsFileState } from "./index";
import {
  ACTIONS_POLL_MS,
  FakeBackend,
  ManualClock,
  createRunStop,
  readActionsFileState,
  watchActionsFile,
} from "./index";

const CWD = "/proj";
const one = (id: string) => JSON.stringify({ actions: [{ id, label: id, command: id, tab: id }] });

/** Lets the promises of a read (and the timer it schedules) settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(options: { intervalMs?: number; file?: string } = {}) {
  const clock = new ManualClock();
  const backend = new FakeBackend({
    clock,
    ...(options.file !== undefined ? { actionsFiles: { [CWD]: options.file } } : {}),
  });
  const states: ActionsFileState[] = [];
  const watcher = watchActionsFile({
    backend,
    cwd: CWD,
    clock,
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    onChange: (state) => states.push(state),
  });
  /** Moves time by one interval and lets the read finish. */
  const tick = async (ms = ACTIONS_POLL_MS) => {
    clock.advance(ms);
    await settle();
  };
  return { clock, backend, states, watcher, tick };
}

describe("FakeBackend actions files", () => {
  it("answers the text set for a folder, null elsewhere, and records the calls", async () => {
    const backend = new FakeBackend({ actionsFiles: { "/a": "text" } });
    await expect(backend.readActionsFile("/a")).resolves.toBe("text");
    await expect(backend.readActionsFile("/b")).resolves.toBeNull();
    backend.setActionsFile("/b", "other");
    await expect(backend.readActionsFile("/b")).resolves.toBe("other");
    backend.setActionsFile("/b", null);
    await expect(backend.readActionsFile("/b")).resolves.toBeNull();
    expect(backend.callsTo("readActionsFile").map((c) => c.args)).toEqual([
      ["/a"],
      ["/b"],
      ["/b"],
      ["/b"],
    ]);
  });

  it("records commands without running them and answers the configured code", async () => {
    const backend = new FakeBackend();
    await expect(backend.runCommand("/proj", "loop parar")).resolves.toBe(0);
    backend.setCommandExitCode(2);
    await expect(backend.runCommand("/proj", "x")).resolves.toBe(2);
    expect(backend.commands).toEqual([
      { cwd: "/proj", command: "loop parar" },
      { cwd: "/proj", command: "x" },
    ]);
    backend.setCommandFailure(new Error("timed out"));
    await expect(backend.runCommand("/proj", "y")).rejects.toThrow("timed out");
    expect(backend.commands).toHaveLength(3);
  });
});

describe("createRunStop", () => {
  it("runs the command in the folder through the backend", async () => {
    const backend = new FakeBackend();
    await createRunStop(backend)("/proj", "loop parar");
    expect(backend.commands).toEqual([{ cwd: "/proj", command: "loop parar" }]);
  });

  it("rejects naming the command and the code when it does not end with 0", async () => {
    const backend = new FakeBackend({ commandExitCode: 4 });
    await expect(createRunStop(backend)("/proj", "loop parar")).rejects.toThrow(
      'The stop command "loop parar" ended with code 4',
    );
  });

  it("lets a failure to run reach the caller", async () => {
    const backend = new FakeBackend();
    backend.setCommandFailure(new Error("did not end in 30 seconds"));
    await expect(createRunStop(backend)("/proj", "x")).rejects.toThrow("30 seconds");
  });
});

describe("watchActionsFile", () => {
  it("reports a missing file at once", async () => {
    const t = setup();
    await settle();
    expect(t.states).toEqual([{ status: "missing" }]);
  });

  it("reports a valid file, parsed, at once", async () => {
    const t = setup({ file: one("dev") });
    await settle();
    expect(t.states).toEqual([
      { status: "ok", actions: [{ id: "dev", label: "dev", command: "dev", tab: "dev" }] },
    ]);
  });

  it("reports an invalid file with the reason", async () => {
    const t = setup({ file: "{ not json" });
    await settle();
    expect(t.states).toHaveLength(1);
    expect(t.states[0]).toMatchObject({ status: "invalid" });
    expect(t.states[0]).toHaveProperty("reason", expect.stringContaining("Not valid JSON"));
  });

  it("stays quiet while the text does not change, however long it polls", async () => {
    const t = setup({ file: one("dev") });
    await settle();
    for (let i = 0; i < 5; i++) await t.tick();
    expect(t.states).toHaveLength(1);
    expect(t.backend.callsTo("readActionsFile")).toHaveLength(6);
  });

  it("reloads when the text changes, on the next interval and not before", async () => {
    const t = setup({ file: one("dev") });
    await settle();
    t.backend.setActionsFile(CWD, one("build"));
    await t.tick(ACTIONS_POLL_MS - 1);
    expect(t.states).toHaveLength(1);
    await t.tick(1);
    expect(t.states).toHaveLength(2);
    expect(t.states[1]).toMatchObject({ status: "ok", actions: [{ id: "build" }] });
  });

  it("follows the file through valid, invalid, missing and valid again", async () => {
    const t = setup({ file: one("dev") });
    await settle();
    t.backend.setActionsFile(CWD, '{"actions": [{"id": "dev"}]}');
    await t.tick();
    t.backend.setActionsFile(CWD, null);
    await t.tick();
    t.backend.setActionsFile(CWD, one("dev"));
    await t.tick();
    expect(t.states.map((s) => s.status)).toEqual(["ok", "invalid", "missing", "ok"]);
  });

  it("does not report a rewrite that leaves the text as it was", async () => {
    const t = setup({ file: one("dev") });
    await settle();
    t.backend.setActionsFile(CWD, one("build"));
    t.backend.setActionsFile(CWD, one("dev"));
    await t.tick();
    expect(t.states).toHaveLength(1);
  });

  it("reports a read that fails once, keeps polling and recovers", async () => {
    const t = setup({ file: one("dev") });
    await settle();
    const original = t.backend.readActionsFile.bind(t.backend);
    let failing = true;
    t.backend.readActionsFile = async (cwd) => {
      if (failing) throw new Error("permission denied");
      return original(cwd);
    };
    await t.tick();
    await t.tick();
    expect(t.states).toHaveLength(2);
    expect(t.states[1]).toEqual({ status: "unreadable", reason: "permission denied" });
    failing = false;
    await t.tick();
    expect(t.states).toHaveLength(3);
    expect(t.states[2]).toMatchObject({ status: "ok" });
  });

  it("uses the interval it was given", async () => {
    const t = setup({ intervalMs: 500 });
    await settle();
    t.backend.setActionsFile(CWD, one("dev"));
    await t.tick(500);
    expect(t.states.map((s) => s.status)).toEqual(["missing", "ok"]);
  });

  it("does not start a read before the previous one ended", async () => {
    const clock = new ManualClock();
    let release: (text: string | null) => void = () => undefined;
    let reads = 0;
    const watcher = watchActionsFile({
      backend: {
        readActionsFile: () => {
          reads++;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
      cwd: CWD,
      clock,
      onChange: () => undefined,
    });
    clock.advance(ACTIONS_POLL_MS * 5);
    await settle();
    expect(reads).toBe(1);
    release(null);
    await settle();
    clock.advance(ACTIONS_POLL_MS);
    await settle();
    expect(reads).toBe(2);
    watcher.dispose();
  });

  it("stops on dispose: no timer left, no read, no call", async () => {
    const t = setup();
    await settle();
    expect(t.clock.pending).toBe(1);
    t.watcher.dispose();
    expect(t.clock.pending).toBe(0);
    t.backend.setActionsFile(CWD, one("dev"));
    await t.tick(ACTIONS_POLL_MS * 3);
    expect(t.states).toHaveLength(1);
    expect(t.backend.callsTo("readActionsFile")).toHaveLength(1);
  });

  it("drops a read that was in flight when it was disposed", async () => {
    const clock = new ManualClock();
    let release: (text: string | null) => void = () => undefined;
    const states: ActionsFileState[] = [];
    const watcher = watchActionsFile({
      backend: {
        readActionsFile: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
      cwd: CWD,
      clock,
      onChange: (state) => states.push(state),
    });
    watcher.dispose();
    release(one("dev"));
    await settle();
    expect(states).toEqual([]);
    expect(clock.pending).toBe(0);
  });
});

describe("readActionsFileState", () => {
  it("says what the file of a folder is right now, once, in the states the watcher uses", async () => {
    const backend = new FakeBackend({
      actionsFiles: { "/ok": one("a"), "/bad": "{ not json", "/empty": "" },
    });
    await expect(readActionsFileState(backend, "/ok")).resolves.toMatchObject({
      status: "ok",
      actions: [{ id: "a" }],
    });
    await expect(readActionsFileState(backend, "/none")).resolves.toEqual({ status: "missing" });
    await expect(readActionsFileState(backend, "/bad")).resolves.toMatchObject({
      status: "invalid",
    });
  });

  it("reports a read that fails as unreadable and never rejects", async () => {
    const failing = {
      readActionsFile: () => Promise.reject(new Error("a folder is in its place")),
    };
    await expect(readActionsFileState(failing, "/x")).resolves.toEqual({
      status: "unreadable",
      reason: "a folder is in its place",
    });
  });
});
