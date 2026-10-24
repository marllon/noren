import { invoke } from "@tauri-apps/api/core";

/**
 * The reads the boot of the main window makes first, and nothing else: each is a command with no
 * arguments that only reads (the settings, the themes and the mods of the user, the saved state).
 * Their answers do not depend on anything the boot does before it asks.
 */
export const EARLY_READS = ["config_load", "theme_list", "mod_list", "state_load"] as const;

type Invoke = (command: string) => Promise<unknown>;

/** The reads started and not taken yet. */
const waiting = new Map<string, Promise<unknown>>();
/** The reads started, taken or not: each is started once. */
const started = new Set<string>();

/**
 * Asks for the reads of {@link EARLY_READS} now, side by side, instead of one after the other
 * when the boot reaches them (NOR-F20-14b). The page script runs well before the boot does (the
 * scripts of the app still have to be fetched and read), so the app answers while the page is busy
 * and the boot finds its answers already in. Asking twice starts nothing new.
 */
export function startEarlyReads(call: Invoke = invoke): void {
  for (const command of EARLY_READS) {
    if (started.has(command)) continue;
    started.add(command);
    const answer = call(command);
    // Whoever takes the answer gets the failure too; this only keeps a read nobody took (a page that
    // never reaches its boot) from being reported as an unhandled rejection.
    answer.catch(() => undefined);
    waiting.set(command, answer);
  }
}

/**
 * The answer of the early read of `command`, once: the first call that asks for exactly that read
 * (no arguments) gets it, and every later call goes to the app as it always did. `undefined` when
 * the read was not started, was taken already, or has arguments.
 */
export function takeEarlyRead<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> | undefined {
  if (args !== undefined) return undefined;
  const answer = waiting.get(command);
  if (answer === undefined) return undefined;
  waiting.delete(command);
  return answer as Promise<T>;
}

/** Forgets every read that was started, so a test starts from nothing. */
export function resetEarlyReads(): void {
  waiting.clear();
  started.clear();
}
