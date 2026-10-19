import { useSyncExternalStore } from "react";
import type { Backend, ConfigManager, ShellProfile, UserProfile } from "@noren/model";

// The shell profiles the window offers: the ones the machine has and the ones the user lists in
// `config.jsonc`. The backend owns the joined list (the machine's shells first, then the user's);
// this store hands the backend the `profiles` of the settings in force, reads the joined list back,
// and keeps it for whatever draws it (the command palette). It follows the file: a change to
// `profiles`, made by hand or by an import, reaches the backend and the list with no restart.

const listeners = new Set<() => void>();
let list: readonly ShellProfile[] = [];
let problem: string | undefined;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The profiles now: the machine's shells, then the user's. */
export function getProfiles(): readonly ShellProfile[] {
  return list;
}

/** The profiles; the component renders again when they change. */
export function useProfiles(): readonly ShellProfile[] {
  return useSyncExternalStore(subscribe, getProfiles);
}

/** Why the backend refused the profiles of the file, or `undefined` when it took them. */
export function getProfilesProblem(): string | undefined {
  return problem;
}

/** The refusal of the backend; the component renders again when it changes. */
export function useProfilesProblem(): string | undefined {
  return useSyncExternalStore(subscribe, getProfilesProblem);
}

function sameProfiles(a: readonly ShellProfile[], b: readonly ShellProfile[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Hands the backend `user` and reads the joined list back. A list the backend refuses (an empty
 * program, an id the machine has) is `getProfilesProblem`, and the backend keeps the profiles it
 * had. Rejects only when the list cannot be read, which the caller decides what to do about.
 */
export async function syncProfiles(
  backend: Pick<Backend, "setUserProfiles" | "listProfiles">,
  user: readonly UserProfile[],
): Promise<void> {
  let refusal: string | undefined;
  try {
    await backend.setUserProfiles(user);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  const next = await backend.listProfiles();
  const changed = refusal !== problem || !sameProfiles(next, list);
  problem = refusal;
  list = next;
  if (changed) notify();
}

/**
 * Starts following `profiles` of the settings in force. The first sync is done when this resolves
 * (and rejects if the list cannot be read, so the start of the window can say so); after that every
 * change of the profiles in the file syncs again, one after the other. Resolves to the function
 * that stops following.
 */
export async function startProfiles(
  backend: Pick<Backend, "setUserProfiles" | "listProfiles">,
  settings: Pick<ConfigManager, "state" | "subscribe">,
): Promise<() => void> {
  let last: string | undefined;
  const apply = async (): Promise<void> => {
    const user = settings.state.config.profiles ?? [];
    const key = JSON.stringify(user);
    if (key === last) return;
    last = key;
    try {
      await syncProfiles(backend, user);
    } catch (error) {
      // The list could not be read: the next change of the file tries again.
      last = undefined;
      throw error;
    }
  };
  const first = apply();
  let queue: Promise<unknown> = first.catch(() => undefined);
  const stop = settings.subscribe(() => {
    queue = queue.then(() => apply()).catch(() => undefined);
  });
  try {
    await first;
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

/** Forgets the profiles and the refusal, so a test starts from nothing. */
export function resetProfiles(): void {
  list = [];
  problem = undefined;
  notify();
}
