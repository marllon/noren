import { homeDir } from "@tauri-apps/api/path";
import { insideTauri } from "./backend";

/** Home folder of the in-memory backend (web mode), the one `FakeBackend` starts shells in. */
export const WEB_HOME = "/home/fake";

/** The home folder of the user, so folders under it show as `~`; `undefined` when unknown. */
export function loadHome(): Promise<string | undefined> {
  if (!insideTauri) return Promise.resolve(WEB_HOME);
  return homeDir().then(
    (path) => path,
    () => undefined,
  );
}
