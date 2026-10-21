// The keys the local API presses (`terminal.send` with `keys`, NOR-F17-01b): a key name such as
// `Enter`, `Ctrl+C` or `Alt+Up` and the bytes a terminal receives for it. Pure: no DOM, no Tauri.
// A name is never guessed at: one that is not here has no bytes, and the caller refuses the whole
// send instead of pressing the keys before it.

const ESC = "\x1b";

/** Keys that are a fixed byte string. */
const FIXED: Readonly<Record<string, string>> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  escape: ESC,
  esc: ESC,
  backspace: "\x7f",
  space: " ",
};

/** Cursor keys and Home/End: `ESC [ <final>`, or `ESC [ 1 ; <modifier> <final>` with a modifier. */
const CURSOR: Readonly<Record<string, string>> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
};

/** Keys written `ESC [ <number> ~`, or `ESC [ <number> ; <modifier> ~` with a modifier. */
const TILDE: Readonly<Record<string, number>> = {
  insert: 2,
  delete: 3,
  del: 3,
  pageup: 5,
  pagedown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
};

/** F1 to F4: `ESC O <final>`, or `ESC [ 1 ; <modifier> <final>` with a modifier. */
const SS3: Readonly<Record<string, string>> = { f1: "P", f2: "Q", f3: "R", f4: "S" };

const MODIFIERS = new Set(["ctrl", "alt", "shift"]);

/**
 * The bytes for a key name, or `undefined` when the name is not a key this knows. Names are not
 * case sensitive. A name is the key alone (`Enter`, `F5`, `a`) or `Ctrl`, `Alt` and `Shift` in any
 * order before it, joined by `+`: `Ctrl+C` is 0x03, `Alt+b` is `ESC b`, `Shift+Tab` is `ESC [ Z`,
 * `Ctrl+Up` is `ESC [ 1 ; 5 A`. `Ctrl` goes with a letter, `Space` or a cursor, tilde or function
 * key; `Shift` with a letter (it is the capital), `Tab` or a cursor, tilde or function key.
 */
export function keySequence(name: string): string | undefined {
  const parts = name.split("+");
  const key = parts.pop()?.toLowerCase();
  if (key === undefined || key === "") return undefined;
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const part of parts) {
    const modifier = part.toLowerCase();
    if (!MODIFIERS.has(modifier)) return undefined;
    if (modifier === "ctrl") {
      if (ctrl) return undefined;
      ctrl = true;
    } else if (modifier === "alt") {
      if (alt) return undefined;
      alt = true;
    } else {
      if (shift) return undefined;
      shift = true;
    }
  }
  // 1 + shift 1 + alt 2 + ctrl 4, as xterm numbers the modifiers of a function or cursor key.
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const modified = modifier > 1;

  const cursor = CURSOR[key];
  if (cursor !== undefined) return modified ? `${ESC}[1;${modifier}${cursor}` : `${ESC}[${cursor}`;
  const tilde = TILDE[key];
  if (tilde !== undefined) return modified ? `${ESC}[${tilde};${modifier}~` : `${ESC}[${tilde}~`;
  const ss3 = SS3[key];
  if (ss3 !== undefined) return modified ? `${ESC}[1;${modifier}${ss3}` : `${ESC}O${ss3}`;

  const fixed = FIXED[key];
  if (fixed !== undefined) {
    if (key === "tab" && shift && !ctrl) return `${alt ? ESC : ""}${ESC}[Z`;
    if (shift) return undefined;
    if (ctrl) return key === "space" ? `${alt ? ESC : ""}\0` : undefined;
    return `${alt ? ESC : ""}${fixed}`;
  }

  // One letter or digit.
  if (/^[a-z0-9]$/.test(key)) {
    let text = key;
    if (shift) {
      if (!/[a-z]/.test(key) || ctrl) return undefined;
      text = key.toUpperCase();
    }
    if (ctrl) {
      if (!/[a-z]/.test(key)) return undefined;
      text = String.fromCharCode(key.charCodeAt(0) - 96);
    }
    return `${alt ? ESC : ""}${text}`;
  }
  return undefined;
}

/**
 * The bytes for the keys, in order, or the first name that has none. Nothing is added: no key
 * the caller did not name, and never a line end.
 */
export function keySequences(
  names: readonly string[],
): { ok: true; bytes: string } | { ok: false; unknown: string } {
  let bytes = "";
  for (const name of names) {
    const sequence = keySequence(name);
    if (sequence === undefined) return { ok: false, unknown: name };
    bytes += sequence;
  }
  return { ok: true, bytes };
}
