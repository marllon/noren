// Which project actions the user already agreed to run: the first run of each action asks, and the
// answer is remembered per space. What is remembered is the text that was confirmed, so a file that
// changes the command (or the stop command) asks again.
//
// Provisional storage: the browser's `localStorage` under `noren.ui.actionConsent`, until the
// settings file gets a place for these preferences.

import type { Id, ProjectAction } from "@noren/model";

/** Key of the confirmed actions in the browser storage. */
export const ACTION_CONSENT_KEY = "noren.ui.actionConsent";

/** Confirmed text by space id, then action id. */
export type ActionConsent = Record<Id, Record<string, string>>;

/**
 * What the user is shown and confirms: the exact command, plus the stop command when there is one
 * (it also runs, in a process with no tab, when the action is stopped).
 */
export function consentText(action: ProjectAction): string {
  return action.stop === undefined ? action.command : `${action.command}\n${action.stop}`;
}

/** Reads the saved consent. Anything missing or of the wrong shape is dropped, never thrown. */
export function parseConsent(raw: string | null): ActionConsent {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const consent: ActionConsent = {};
  for (const [spaceId, actions] of Object.entries(value)) {
    if (typeof actions !== "object" || actions === null || Array.isArray(actions)) continue;
    const confirmed: Record<string, string> = {};
    for (const [actionId, text] of Object.entries(actions)) {
      if (typeof text === "string") confirmed[actionId] = text;
    }
    consent[spaceId] = confirmed;
  }
  return consent;
}

/** True when this exact text of the action was confirmed in this space. */
export function isConfirmed(consent: ActionConsent, spaceId: Id, action: ProjectAction): boolean {
  return consent[spaceId]?.[action.id] === consentText(action);
}

/** The consent with the action confirmed in the space. */
export function confirmAction(
  consent: ActionConsent,
  spaceId: Id,
  action: ProjectAction,
): ActionConsent {
  return { ...consent, [spaceId]: { ...consent[spaceId], [action.id]: consentText(action) } };
}

/** The part of the browser storage the consent needs (so tests can hand in a plain object). */
export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The saved consent, or none when the storage is missing or throws. */
export function loadConsent(storage: ConsentStorage | undefined): ActionConsent {
  try {
    return parseConsent(storage?.getItem(ACTION_CONSENT_KEY) ?? null);
  } catch {
    return {};
  }
}

/** Saves the consent; a storage that refuses is ignored, the answer then lasts until the page closes. */
export function saveConsent(storage: ConsentStorage | undefined, consent: ActionConsent): void {
  try {
    storage?.setItem(ACTION_CONSENT_KEY, JSON.stringify(consent));
  } catch {
    // The answer only lasts until the page closes.
  }
}
