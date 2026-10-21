import type { Space } from "./types";

/**
 * The environment new sessions of a space get: the git identity as author and committer, under the
 * variables of the space, which win on a conflict (names compare ignoring case, as on Windows).
 * A blank name or email leaves its variables out. One rule for the interface and for the local API
 * (`dispatchApiCall`), so a shell the API starts has the environment of one the interface starts.
 */
export function spaceSessionEnv(space: Space): Record<string, string> {
  const { env, gitIdentity } = space.defaults;
  if (gitIdentity === undefined) return env;
  const taken = new Set(Object.keys(env).map((name) => name.toUpperCase()));
  const fromIdentity: Record<string, string> = {};
  const add = (names: string[], value: string) => {
    if (value === "") return;
    for (const name of names) if (!taken.has(name)) fromIdentity[name] = value;
  };
  add(["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"], gitIdentity.name);
  add(["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"], gitIdentity.email);
  return { ...fromIdentity, ...env };
}
