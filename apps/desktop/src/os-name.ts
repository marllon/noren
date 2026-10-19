// The name of the system the window runs on, for the request of a command ("? text"): the shell
// alone does not tell the AI which tools exist. The page reads it from the user agent of its web
// view, which names the system on every platform Noren runs on. Pure.

/** `Windows`, `macOS` or `Linux`, from a user agent; `this system` when it names none of them. */
export function osNameOf(userAgent: string): string {
  if (/windows/i.test(userAgent)) return "Windows";
  // iPhone and iPad user agents say "like Mac OS X": they are not a computer Noren runs on.
  if (/mac os x|macintosh/i.test(userAgent) && !/iphone|ipad/i.test(userAgent)) return "macOS";
  if (/linux|x11|cros/i.test(userAgent) && !/android/i.test(userAgent)) return "Linux";
  return "this system";
}
