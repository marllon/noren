// What the terminal does when a program rings the bell (`terminal.bell` in config.jsonc): a flash
// of the pane, a short beep, both or nothing. The tab is marked as unread whichever it is; that is
// `unread.ts`, which reads the bytes of the session and knows nothing of this.

import type { BellStyle } from "@noren/model";

/** How long the pane stays lit, in milliseconds. */
export const BELL_FLASH_MS = 150;

/** The pitch, length and loudness of the beep. A bell is a hint, not an alarm: it is quiet. */
const BEEP_HZ = 880;
const BEEP_SECONDS = 0.1;
const BEEP_GAIN = 0.05;

/** The part of the Web Audio API the beep uses, so a test can hand in a fake. */
export interface BeepOutput {
  currentTime: number;
  destination: unknown;
  state?: string;
  resume?(): Promise<void>;
  createOscillator(): {
    frequency: { value: number };
    connect(node: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): {
    gain: { value: number };
    connect(node: unknown): unknown;
  };
}

/** Whether a bell of this style lights the pane. */
export function flashes(style: BellStyle): boolean {
  return style === "visual" || style === "both";
}

/** Whether a bell of this style beeps. */
export function beeps(style: BellStyle): boolean {
  return style === "sound" || style === "both";
}

const audioOutput = (): BeepOutput | undefined => {
  const Context =
    typeof AudioContext === "undefined" ? undefined : (AudioContext as new () => BeepOutput);
  return Context === undefined ? undefined : new Context();
};

let output: BeepOutput | undefined;
let makeOutput: () => BeepOutput | undefined = audioOutput;

/** Replaces how the audio output is made (a test hands in a fake); `undefined` puts the real one back. */
export function setBeepOutputFactory(factory: (() => BeepOutput | undefined) | undefined): void {
  output = undefined;
  makeOutput = factory ?? audioOutput;
}

/**
 * Plays one short beep. A system with no audio, or one that refuses to start it (the browser lets
 * sound begin only after the person used the page), gets silence: a bell must never be an error.
 */
export function beep(): void {
  try {
    output ??= makeOutput();
    const context = output;
    if (context === undefined) return;
    if (context.state === "suspended") void context.resume?.().catch(() => undefined);
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.frequency.value = BEEP_HZ;
    volume.gain.value = BEEP_GAIN;
    oscillator.connect(volume);
    volume.connect(context.destination);
    oscillator.start(context.currentTime);
    oscillator.stop(context.currentTime + BEEP_SECONDS);
  } catch {
    // No sound is not worth an error.
  }
}
