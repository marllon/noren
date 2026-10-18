import { describe, expect, it } from "vitest";
import { FakeBackend } from "./backend";

describe("FakeBackend", () => {
  it("is named fake and becomes ready", async () => {
    const backend = new FakeBackend();
    expect(backend.name).toBe("fake");
    await expect(backend.ready()).resolves.toBeUndefined();
  });
});
