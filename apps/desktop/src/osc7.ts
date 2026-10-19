// OSC 7 is how a shell with integration reports its folder: `ESC ] 7 ; file://host/path BEL`.
// xterm.js splits the sequence out of the output (even when it arrives in pieces); this turns its
// text into a folder path. The text comes from the terminal output, so nothing in it is trusted:
// a value that is not a plain `file:` URL with a path gives `undefined`.

/** Longest folder path taken; anything longer is not a folder a person works in. */
const MAX_PATH = 4096;

/**
 * The folder named by the data of an OSC 7 sequence (`file://host/C:/Users/me`), or `undefined`
 * when there is none. The host is ignored, percent escapes are decoded, and the slash before a
 * Windows drive letter is dropped (`/C:/Users/me` becomes `C:/Users/me`).
 */
export function parseOsc7(data: string): string | undefined {
  const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(data.trim());
  if (match === null) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(match[2] ?? "");
  } catch {
    return undefined;
  }
  // A control character in a path is never a folder the user is in.
  // eslint-disable-next-line no-control-regex
  if (path.length > MAX_PATH || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const windows = /^\/[A-Za-z]:(\/|$)/.test(path);
  const result = windows ? path.slice(1) : path;
  return result === "" ? undefined : result;
}
