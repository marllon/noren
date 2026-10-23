let known: string | undefined;

/** Remembers the home folder once the window has read it (`boot`), for what is named without the store. */
export function rememberHome(path: string | undefined): void {
  known = path;
}

/** The home folder the window read at its start; `undefined` before that or when it is unknown. */
export function knownHome(): string | undefined {
  return known;
}
