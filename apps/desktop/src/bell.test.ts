import { afterEach, describe, expect, it, vi } from "vitest";
import { BELL_STYLES } from "@noren/model";
import { beep, beeps, flashes, setBeepOutputFactory } from "./bell";
import type { BeepOutput } from "./bell";

// What the bell does: which styles flash the pane and which beep, and a beep that never throws.

afterEach(() => setBeepOutputFactory(undefined));

function fakeOutput(state?: string) {
  const started: number[] = [];
  const stopped: number[] = [];
  const oscillator = {
    frequency: { value: 0 },
    connect: vi.fn(),
    start: (when?: number) => started.push(when ?? -1),
    stop: (when?: number) => stopped.push(when ?? -1),
  };
  const gain = { gain: { value: 0 }, connect: vi.fn() };
  const resume = vi.fn(() => Promise.resolve());
  const output: BeepOutput = {
    currentTime: 2,
    destination: "speakers",
    ...(state !== undefined ? { state, resume } : {}),
    createOscillator: () => oscillator,
    createGain: () => gain,
  };
  return { output, oscillator, gain, started, stopped, resume };
}

describe("the styles of the bell", () => {
  it("flash for visual and both, beep for sound and both, and do nothing for none", () => {
    const table = Object.fromEntries(
      BELL_STYLES.map((style) => [style, [flashes(style), beeps(style)]]),
    );
    expect(table).toEqual({
      none: [false, false],
      visual: [true, false],
      sound: [false, true],
      both: [true, true],
    });
  });
});

describe("beep", () => {
  it("plays one short quiet tone on the speakers", () => {
    const fake = fakeOutput();
    setBeepOutputFactory(() => fake.output);
    beep();
    expect(fake.started).toEqual([2]);
    expect(fake.stopped).toHaveLength(1);
    expect(fake.stopped[0]).toBeGreaterThan(2);
    expect(fake.stopped[0]).toBeLessThan(2.5);
    expect(fake.oscillator.frequency.value).toBeGreaterThan(0);
    expect(fake.gain.gain.value).toBeGreaterThan(0);
    expect(fake.gain.gain.value).toBeLessThan(0.2);
    expect(fake.oscillator.connect).toHaveBeenCalledWith(fake.gain);
    expect(fake.gain.connect).toHaveBeenCalledWith("speakers");
  });

  it("makes the audio output once and uses it for every beep", () => {
    const fake = fakeOutput();
    const make = vi.fn(() => fake.output);
    setBeepOutputFactory(make);
    beep();
    beep();
    beep();
    expect(make).toHaveBeenCalledTimes(1);
    expect(fake.started).toHaveLength(3);
  });

  it("asks a suspended output to start", () => {
    const fake = fakeOutput("suspended");
    setBeepOutputFactory(() => fake.output);
    beep();
    expect(fake.resume).toHaveBeenCalledTimes(1);
    const running = fakeOutput("running");
    setBeepOutputFactory(() => running.output);
    beep();
    expect(running.resume).not.toHaveBeenCalled();
  });

  it("is silent, not an error, when there is no audio", () => {
    setBeepOutputFactory(() => undefined);
    expect(() => beep()).not.toThrow();
  });

  it("is silent, not an error, when the audio fails", () => {
    setBeepOutputFactory(() => {
      throw new Error("no audio device");
    });
    expect(() => beep()).not.toThrow();
    const broken = fakeOutput();
    broken.output.createOscillator = () => {
      throw new Error("refused");
    };
    setBeepOutputFactory(() => broken.output);
    expect(() => beep()).not.toThrow();
  });

  it("does not wait on a resume that is refused", () => {
    const fake = fakeOutput("suspended");
    fake.output.resume = () => Promise.reject(new Error("needs a gesture"));
    setBeepOutputFactory(() => fake.output);
    expect(() => beep()).not.toThrow();
  });
});
