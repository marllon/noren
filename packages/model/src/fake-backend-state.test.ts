import { describe, expect, it } from "vitest";
import { FakeBackend } from "./index";

describe("FakeBackend state", () => {
  it("starts without a saved state", async () => {
    const backend = new FakeBackend();
    await expect(backend.loadState()).resolves.toBeNull();
    expect(backend.stateContent).toBeNull();
    expect(backend.quarantineCount).toBe(0);
  });

  it("starts with the injected content", async () => {
    const backend = new FakeBackend({ state: '{"a":1}' });
    await expect(backend.loadState()).resolves.toBe('{"a":1}');
  });

  it("returns what was saved and replaces the previous content", async () => {
    const backend = new FakeBackend({ state: "old" });
    await backend.saveState("one");
    await backend.saveState("two");
    await expect(backend.loadState()).resolves.toBe("two");
    expect(backend.callsTo("saveState").map((call) => call.args)).toEqual([["one"], ["two"]]);
  });

  it("quarantine keeps a copy, leaves the original and counts", async () => {
    const backend = new FakeBackend({ state: "broken" });
    await expect(backend.quarantineState()).resolves.toBe("state.broken-1.json");
    await backend.saveState("fresh");
    await expect(backend.quarantineState()).resolves.toBe("state.broken-2.json");
    expect(backend.quarantined).toEqual(["broken", "fresh"]);
    expect(backend.quarantineCount).toBe(2);
    expect(backend.stateContent).toBe("fresh");
  });

  it("quarantine fails when there is no file, like the real backend", async () => {
    const backend = new FakeBackend();
    await expect(backend.quarantineState()).rejects.toThrow("no state file");
    expect(backend.quarantineCount).toBe(0);
  });

  it("records the state calls", async () => {
    const backend = new FakeBackend();
    await backend.loadState();
    await backend.saveState("x");
    expect(backend.calls.map((call) => call.method)).toEqual(["loadState", "saveState"]);
  });
});
