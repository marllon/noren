// Vitest tests of the game mode reader (the other scripts/*.test.mjs use node:test and run
// separately). The signal is always a temporary file, never the real one.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_AGE_MS,
  SIGNAL_ENV,
  cargoEnv,
  gameModeActive,
  playwrightWorkers,
  vitestWorkers,
} from "./game-mode.mjs";

let dir;
let signal;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "noren-game-mode-"));
  signal = join(dir, "signal");
  writeFileSync(signal, '{"jogo":"test"}');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("game mode reader", () => {
  it("is on for a fresh signal read through the variable", () => {
    expect(gameModeActive({ [SIGNAL_ENV]: signal })).toBe(true);
  });

  it("is off for an old signal (modified 60 s ago or more)", () => {
    const old = new Date(Date.now() - MAX_AGE_MS - 5_000);
    utimesSync(signal, old, old);
    expect(gameModeActive({ [SIGNAL_ENV]: signal })).toBe(false);
    const fresh = new Date();
    utimesSync(signal, fresh, fresh);
    expect(gameModeActive({ [SIGNAL_ENV]: signal })).toBe(true);
  });

  it("is off when the file is missing", () => {
    expect(gameModeActive({ [SIGNAL_ENV]: join(dir, "missing") })).toBe(false);
  });

  it("follows the path of the variable, not the real signal", () => {
    // Under the real path the answer would depend on the machine; the variable decides.
    expect(gameModeActive({ [SIGNAL_ENV]: join(dir, "nothing-here") })).toBe(false);
    expect(gameModeActive({ [SIGNAL_ENV]: signal })).toBe(true);
  });

  it("uses the clock it is given", () => {
    const env = { [SIGNAL_ENV]: signal };
    expect(gameModeActive(env, Date.now() + MAX_AGE_MS + 60_000)).toBe(false);
  });

  it("sets the limits only while the signal is valid", () => {
    const on = { [SIGNAL_ENV]: signal, NOREN_GAME_MODE_ANNOUNCED: "any" };
    const off = { [SIGNAL_ENV]: join(dir, "missing"), PATH: "p" };
    expect(vitestWorkers(on)).toBe(8);
    expect(playwrightWorkers(on)).toBe(4);
    expect(cargoEnv(on)["CARGO_BUILD_JOBS"]).toBe("8");
    expect(vitestWorkers(off)).toBeUndefined();
    expect(playwrightWorkers(off)).toBeUndefined();
    expect(cargoEnv(off)).toEqual(off);
  });
});
