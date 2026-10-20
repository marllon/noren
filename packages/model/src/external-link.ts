// Which addresses the app may hand to the system browser. A link in the terminal output is text
// written by whatever program ran there, so it is never trusted: only plain `http://` and `https://`
// addresses pass, and the person confirms before anything opens. The Rust side applies the same
// rule again right before the system is asked (`crates/noren-core/src/link.rs`); keep both the same.

/** The longest address handed to the system, in UTF-8 bytes. */
export const MAX_LINK_BYTES = 2048;

const SCHEME = /^https?:\/\//i;
/** Whether `text` has a blank, a control character (C0 and C1) or a backslash. */
function hasForbiddenCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (/\s/u.test(char) || code <= 0x1f || (code >= 0x7f && code <= 0x9f) || char === "\\") {
      return true;
    }
  }
  return false;
}

/**
 * Why `address` cannot be opened, or `undefined` when it can: it is empty or too long, it is not
 * `http://` or `https://` (the scheme in any case), it has a blank, a control character or a
 * backslash, it has no host, or it has a user name or password before the host
 * (`https://good.example@evil.example` shows one host and opens another).
 */
export function externalLinkProblem(address: string): string | undefined {
  const bytes = new TextEncoder().encode(address).length;
  if (bytes === 0 || bytes > MAX_LINK_BYTES) return "the link is empty or too long";
  const scheme = SCHEME.exec(address);
  if (scheme === null) return "only http and https links can be opened";
  if (hasForbiddenCharacter(address))
    return "the link has a blank, a control character or a backslash";
  const authority = address.slice(scheme[0].length).split(/[/?#]/u, 1)[0] ?? "";
  if (authority === "") return "the link has no host";
  if (authority.includes("@")) return "the link has a user name or password before the host";
  return undefined;
}

/** Whether `address` passes [`externalLinkProblem`]. */
export function isExternalLink(address: string): boolean {
  return externalLinkProblem(address) === undefined;
}
