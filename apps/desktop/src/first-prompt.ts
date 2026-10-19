/** `ESC ] 133 ; A`: what the shell integration writes at the start of every prompt. */
const PROMPT_START = [0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b, 0x41];

/**
 * Looks for the first prompt of one terminal in the chunks of its output. Answers `true` for the
 * chunk in which the mark of the prompt is complete (it may start in the chunk before), and `false`
 * for every other, including all those after it, which are not even scanned.
 */
export function watchFirstPrompt(): (chunk: Uint8Array) => boolean {
  let seen = false;
  let tail: number[] = [];
  return (chunk) => {
    if (seen) return false;
    const bytes = [...tail, ...chunk];
    for (let at = 0; at + PROMPT_START.length <= bytes.length; at++) {
      if (PROMPT_START.every((byte, i) => bytes[at + i] === byte)) {
        seen = true;
        tail = [];
        return true;
      }
    }
    tail = bytes.slice(Math.max(0, bytes.length - (PROMPT_START.length - 1)));
    return false;
  };
}
