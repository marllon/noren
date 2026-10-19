// Which keyboard focus lets a shortcut act. The shortcuts themselves live in `keybindings.ts`.

/** The slice of an element the check below reads. */
export interface KeyTarget {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range"]);

/**
 * True when the key goes to a field the user is typing in (a rename box, a dialog field), where the
 * shortcuts must not act. The terminal's own input is not one of them.
 */
export function typesText(target: KeyTarget | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName.toUpperCase();
  if (tag === "SELECT") return true;
  return tag === "INPUT" && !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
}
