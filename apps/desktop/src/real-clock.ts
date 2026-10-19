import type { Clock } from "@noren/model";

/** The clock of the running interface: wall-clock time and real timers. Tests inject a `ManualClock`. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};
