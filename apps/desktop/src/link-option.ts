import type { Backend } from "@noren/model";

// The option "Register the noren:// link on this computer" of the settings. Unlike the other
// settings it does something to the computer, so the switch asks the system first and the choice
// is written to `config.jsonc` only when the system did it. Nothing here runs at start: the
// backend is called only from the switch.

/** What the system said to a change of the option. */
export type LinkChange = { ok: true } | { ok: false; reason: string };

/**
 * Registers the `noren://` link (`true`) or removes it (`false`), and says whether it worked. A
 * system that refuses (or cannot do it at all) is a reason to show, never an error to throw.
 */
export async function changeLink(
  backend: Pick<Backend, "setLinkRegistered">,
  registered: boolean,
): Promise<LinkChange> {
  try {
    await backend.setLinkRegistered(registered);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
