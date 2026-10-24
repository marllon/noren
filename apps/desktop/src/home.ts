import { homeDir } from "@tauri-apps/api/path";
import { insideTauri } from "./backend";

/** Home folder of the in-memory backend (web mode), the one `FakeBackend` starts shells in. */
export const WEB_HOME = "/home/fake";

let asked: Promise<string | undefined> | undefined;

/**
 * The home folder of the user, so folders under it show as `~`; `undefined` when unknown. It is
 * asked once: `main.tsx` asks at the first line of the page script, and the boot and the window
 * read the same answer (the folder cannot change while the app runs).
 */
export function loadHome(): Promise<string | undefined> {
  if (!insideTauri) return Promise.resolve(WEB_HOME);
  asked ??= homeDir().then(
    (path) => path,
    () => undefined,
  );
  return asked;
}
