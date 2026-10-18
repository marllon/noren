import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBackend } from "./fake-backend";
import { ManualClock } from "./clock";
import { createDefaultWorkspace } from "./default-workspace";
import { parseState, serializeWorkspace } from "./state";
import { StateWriter } from "./state-writer";
import type { Workspace } from "./types";

/** The default workspace renamed, to tell changes apart. */
const named = (name: string): Workspace => {
  const ws = createDefaultWorkspace();
  const [space] = ws.spaces;
  if (!space) throw new Error("no space");
  return { ...ws, spaces: [{ ...space, name }] };
};

const savedName = (backend: FakeBackend): string | undefined => {
  const text = backend.stateContent;
  if (text === null) return undefined;
  const parsed = parseState(text);
  return parsed.ok ? parsed.workspace.spaces[0]?.name : undefined;
};

describe("StateWriter with fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes once, 500 ms after a change", async () => {
    const backend = new FakeBackend();
    const writer = new StateWriter({ backend });
    writer.schedule(named("a"));
    expect(writer.pending).toBe(true);

    await vi.advanceTimersByTimeAsync(499);
    expect(backend.callsTo("saveState")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.callsTo("saveState")).toHaveLength(1);
    expect(savedName(backend)).toBe("a");
    expect(writer.pending).toBe(false);
  });

  it("turns many changes into one write with the last state", async () => {
    const backend = new FakeBackend();
    const writer = new StateWriter({ backend });
    for (const name of ["a", "b", "c", "d"]) {
      writer.schedule(named(name));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(backend.callsTo("saveState")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(backend.callsTo("saveState")).toHaveLength(1);
    expect(savedName(backend)).toBe("d");
  });

  it("restarts the wait on every change", async () => {
    const backend = new FakeBackend();
    const writer = new StateWriter({ backend });
    writer.schedule(named("a"));
    await vi.advanceTimersByTimeAsync(400);
    writer.schedule(named("b"));
    await vi.advanceTimersByTimeAsync(400);
    expect(backend.callsTo("saveState")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(savedName(backend)).toBe("b");
  });

  it("writes again for a change after the first write", async () => {
    const backend = new FakeBackend();
    const writer = new StateWriter({ backend });
    writer.schedule(named("a"));
    await vi.advanceTimersByTimeAsync(500);
    writer.schedule(named("b"));
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.callsTo("saveState")).toHaveLength(2);
    expect(savedName(backend)).toBe("b");
  });

  it("does not write before there is a change", async () => {
    const backend = new FakeBackend();
    new StateWriter({ backend });
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.callsTo("saveState")).toHaveLength(0);
  });

  it("flush writes the waiting state at once and stops the timer", async () => {
    const backend = new FakeBackend();
    const writer = new StateWriter({ backend });
    writer.schedule(named("a"));
    writer.schedule(named("b"));
    await writer.flush();
    expect(backend.callsTo("saveState")).toHaveLength(1);
    expect(savedName(backend)).toBe("b");
    expect(writer.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(backend.callsTo("saveState")).toHaveLength(1);
  });

  it("flush with nothing waiting writes nothing", async () => {
    const backend = new FakeBackend();
    await new StateWriter({ backend }).flush();
    expect(backend.callsTo("saveState")).toHaveLength(0);
  });

  it("cancel drops the waiting state", async () => {
    const backend = new FakeBackend();
    const writer = new StateWriter({ backend });
    writer.schedule(named("a"));
    writer.cancel();
    expect(writer.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(backend.callsTo("saveState")).toHaveLength(0);
  });

  it("saves the serialized workspace, without sessions", async () => {
    const backend = new FakeBackend();
    const writer = new StateWriter({ backend });
    const ws = createDefaultWorkspace();
    writer.schedule(ws);
    await writer.flush();
    expect(backend.stateContent).toBe(serializeWorkspace(ws));
  });

  it("honors another delay", async () => {
    const backend = new FakeBackend();
    const writer = new StateWriter({ backend, delayMs: 50 });
    writer.schedule(named("a"));
    await vi.advanceTimersByTimeAsync(50);
    expect(backend.callsTo("saveState")).toHaveLength(1);
  });

  it("reports a failed timed write and keeps working", async () => {
    const backend = new FakeBackend();
    const errors: unknown[] = [];
    let fail = true;
    const original = backend.saveState.bind(backend);
    backend.saveState = async (content) => {
      if (fail) throw new Error("disk full");
      await original(content);
    };
    const writer = new StateWriter({ backend, onError: (error) => errors.push(error) });
    writer.schedule(named("a"));
    await vi.advanceTimersByTimeAsync(500);
    expect(errors).toHaveLength(1);
    fail = false;
    writer.schedule(named("b"));
    await vi.advanceTimersByTimeAsync(500);
    expect(errors).toHaveLength(1);
    expect(savedName(backend)).toBe("b");
  });

  it("makes flush reject when the write fails", async () => {
    const backend = new FakeBackend();
    backend.saveState = () => Promise.reject(new Error("disk full"));
    const writer = new StateWriter({ backend });
    writer.schedule(named("a"));
    await expect(writer.flush()).rejects.toThrow("disk full");
  });

  it("never overlaps two writes", async () => {
    const backend = new FakeBackend();
    let running = 0;
    let overlapped = false;
    const finishers: (() => void)[] = [];
    backend.saveState = async () => {
      running++;
      overlapped ||= running > 1;
      await new Promise<void>((resolve) => finishers.push(resolve));
      running--;
    };
    const writer = new StateWriter({ backend });
    writer.schedule(named("a"));
    await vi.advanceTimersByTimeAsync(500);
    writer.schedule(named("b"));
    await vi.advanceTimersByTimeAsync(500);
    expect(finishers).toHaveLength(1);
    finishers[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(finishers).toHaveLength(2);
    finishers[1]?.();
    await writer.flush();
    expect(overlapped).toBe(false);
  });
});

describe("StateWriter with an injected clock", () => {
  it("uses the clock for the wait", async () => {
    const backend = new FakeBackend();
    const clock = new ManualClock();
    const writer = new StateWriter({ backend, clock });
    writer.schedule(named("a"));
    clock.advance(499);
    expect(backend.callsTo("saveState")).toHaveLength(0);
    clock.advance(1);
    await writer.flush();
    expect(backend.callsTo("saveState")).toHaveLength(1);
    expect(clock.pending).toBe(0);
  });
});
