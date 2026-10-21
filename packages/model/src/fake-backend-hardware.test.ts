import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { benchHardwareOf, recommendedBenchModels } from "./bench-models";
import { FakeBackend } from "./fake-backend";

// The memory of the fake computer (`readHardware`, `hardware`, `setHardware`) and the one rule it
// shares with the real backend: a reading that makes no sense becomes null (NOR-F16-04b).

const GIB = 1024 * 1024 * 1024;

describe("FakeBackend.readHardware", () => {
  it("knows nothing by default: no hardware, as the browser build answers", async () => {
    const backend = new FakeBackend();
    await expect(backend.readHardware()).resolves.toBeNull();
    expect(backend.callsTo("readHardware")).toHaveLength(1);
  });

  it("answers the memory it was given", async () => {
    const backend = new FakeBackend({ hardware: { ramBytes: 16 * GIB, vramBytes: 8 * GIB } });
    await expect(backend.readHardware()).resolves.toEqual({
      ramBytes: 16 * GIB,
      vramBytes: 8 * GIB,
    });
  });

  it("answers an unknown VRAM as null, and the RAM is still there", async () => {
    const backend = new FakeBackend({ hardware: { ramBytes: 32 * GIB, vramBytes: null } });
    await expect(backend.readHardware()).resolves.toEqual({ ramBytes: 32 * GIB, vramBytes: null });
  });

  it("follows setHardware, including taking the hardware away", async () => {
    const backend = new FakeBackend();
    backend.setHardware({ ramBytes: 8 * GIB, vramBytes: null });
    await expect(backend.readHardware()).resolves.toEqual({ ramBytes: 8 * GIB, vramBytes: null });
    backend.setHardware({ ramBytes: 64 * GIB, vramBytes: 24 * GIB });
    await expect(backend.readHardware()).resolves.toEqual({
      ramBytes: 64 * GIB,
      vramBytes: 24 * GIB,
    });
    backend.setHardware(null);
    await expect(backend.readHardware()).resolves.toBeNull();
    // setHardware is not a Backend call; the three reads are.
    expect(backend.callsTo("readHardware")).toHaveLength(3);
    expect(backend.calls.map((call) => call.method)).toEqual([
      "readHardware",
      "readHardware",
      "readHardware",
    ]);
  });

  it("hands out a copy: changing the answer does not change the computer", async () => {
    const backend = new FakeBackend({ hardware: { ramBytes: 16 * GIB, vramBytes: null } });
    const first = await backend.readHardware();
    if (first === null) throw new Error("hardware expected");
    first.ramBytes = 1;
    await expect(backend.readHardware()).resolves.toEqual({ ramBytes: 16 * GIB, vramBytes: null });
  });

  it("reads a bad VRAM as unknown and a bad RAM as no hardware, as the Rust side does", async () => {
    for (const vramBytes of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, 2 ** 53 + 2]) {
      const backend = new FakeBackend({ hardware: { ramBytes: 8 * GIB, vramBytes } });
      await expect(backend.readHardware(), `vram ${vramBytes}`).resolves.toEqual({
        ramBytes: 8 * GIB,
        vramBytes: null,
      });
      backend.setHardware({ ramBytes: 4 * GIB, vramBytes });
      await expect(backend.readHardware(), `vram ${vramBytes}`).resolves.toEqual({
        ramBytes: 4 * GIB,
        vramBytes: null,
      });
    }
    for (const ramBytes of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, 2 ** 53 + 2]) {
      const backend = new FakeBackend({ hardware: { ramBytes, vramBytes: 8 * GIB } });
      await expect(backend.readHardware(), `ram ${ramBytes}`).resolves.toBeNull();
      backend.setHardware({ ramBytes, vramBytes: null });
      await expect(backend.readHardware(), `ram ${ramBytes}`).resolves.toBeNull();
    }
  });

  it("feeds recommendedBenchModels as it is", async () => {
    const backend = new FakeBackend({ hardware: { ramBytes: 16 * GIB, vramBytes: 12 * GIB } });
    const hardware = await backend.readHardware();
    if (hardware === null) throw new Error("hardware expected");
    const result = recommendedBenchModels(hardware);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memory).toBe("vram");
  });
});

describe("benchHardwareOf", () => {
  it("keeps whole numbers of bytes above 0, up to 2^53 - 1", () => {
    expect(benchHardwareOf({ ramBytes: 1, vramBytes: 1 })).toEqual({ ramBytes: 1, vramBytes: 1 });
    expect(
      benchHardwareOf({ ramBytes: Number.MAX_SAFE_INTEGER, vramBytes: Number.MAX_SAFE_INTEGER }),
    ).toEqual({
      ramBytes: Number.MAX_SAFE_INTEGER,
      vramBytes: Number.MAX_SAFE_INTEGER,
    });
  });

  it("makes a missing or undefined VRAM null", () => {
    expect(benchHardwareOf({ ramBytes: 5 })).toEqual({ ramBytes: 5, vramBytes: null });
    expect(benchHardwareOf({ ramBytes: 5, vramBytes: undefined })).toEqual({
      ramBytes: 5,
      vramBytes: null,
    });
  });

  it("is null for anything that is not a reading", () => {
    const inputs = [null, undefined, 7, "16", [], true, {}, { vramBytes: 5 }, { ramBytes: "5" }];
    for (const input of inputs) {
      expect(benchHardwareOf(input), JSON.stringify(input)).toBeNull();
    }
  });

  it("leaves out any other field", () => {
    expect(benchHardwareOf({ ramBytes: 5, vramBytes: 6, extra: "x", gpu: "y" })).toEqual({
      ramBytes: 5,
      vramBytes: 6,
    });
  });

  it("never throws and always gives numbers a JavaScript number holds exactly", () => {
    const good = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = benchHardwareOf(input);
        if (result === null) return true;
        return good(result.ramBytes) && (result.vramBytes === null || good(result.vramBytes));
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.double(), fc.double(), (ram, vram) => {
        const result = benchHardwareOf({ ramBytes: ram, vramBytes: vram });
        if (!good(ram)) return result === null;
        return result?.vramBytes === (good(vram) ? vram : null);
      }),
      { numRuns: 500 },
    );
  });
});
