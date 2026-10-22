import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";

// The transparency switch of the fake computer (`systemTransparencyReduced`, `setSystemTransparencyReduced`):
// the answer the glass interface style asks of the system (NOR-F20-18a).

describe("FakeBackend.systemTransparencyReduced", () => {
  it("answers no by default: the system has its transparency effects on", async () => {
    const backend = new FakeBackend();
    await expect(backend.systemTransparencyReduced()).resolves.toBe(false);
    expect(backend.callsTo("systemTransparencyReduced")).toHaveLength(1);
  });

  it("answers what the switch of the fake system says, each time it is asked", async () => {
    const backend = new FakeBackend();
    backend.setSystemTransparencyReduced(true);
    await expect(backend.systemTransparencyReduced()).resolves.toBe(true);
    backend.setSystemTransparencyReduced(false);
    await expect(backend.systemTransparencyReduced()).resolves.toBe(false);
    expect(backend.callsTo("systemTransparencyReduced")).toHaveLength(2);
  });
});
