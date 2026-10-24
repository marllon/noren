// Game mode (NOR-F11-04) and the fixed ceiling (NOR-F20-22): the heavy commands of the
// repository never run with more than 8 workers or cargo jobs, and while the user is playing, with
// no more than 4. The Windows watcher keeps a signal file while a game is open (contract in
// D:/Projetos/_modo-jogo/LEIA-ME.md); this is the only reader of it in the repository.
//
// The signal is valid when the file exists and was modified less than 60 s ago (an older one means
// the watcher stopped). It is read once, when a command starts, never in the middle of it. The path
// can be changed with NOREN_MODO_JOGO_ARQUIVO (the tests point it at a temporary file). CI (Linux)
// has no such file and never sees the signal; it gets the normal ceiling.
import { statSync } from "node:fs";

export const SIGNAL_PATH = "D:/Projetos/.modo-jogo";
export const SIGNAL_ENV = "NOREN_MODO_JOGO_ARQUIVO";
export const MAX_AGE_MS = 60_000;

/** The ceiling that always applies: at most 8 of each, signal or not. */
export const NORMAL_LIMITS = { vitestWorkers: 8, playwrightWorkers: 8, cargoJobs: 8 };

/** The lighter ceiling that applies while game mode is on. */
export const LIMITS = { vitestWorkers: 4, playwrightWorkers: 4, cargoJobs: 4 };

/** The file the signal is: the one `NOREN_MODO_JOGO_ARQUIVO` names, else the real one. */
export function signalPath(env = process.env) {
  const custom = env[SIGNAL_ENV];
  return custom !== undefined && custom !== "" ? custom : SIGNAL_PATH;
}

/** Whether the signal is valid at `now` (ms since the epoch): it exists and is under 60 s old. */
export function gameModeActive(env = process.env, now = Date.now()) {
  try {
    const age = now - statSync(signalPath(env)).mtimeMs;
    return age < MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Whether the signal file exists, of any age. The mode that draws the real window out of sight
 * (`pnpm shot`, NOR-F20-05) refuses to run while it does, even when the watcher left it behind
 * long ago: a window that draws costs a game a frame, so only a clear "not playing" lets it go. A
 * file that cannot be looked at for another reason than being absent counts as there.
 */
export function gameModeSignalPresent(env = process.env) {
  try {
    statSync(signalPath(env));
    return true;
  } catch (error) {
    return error?.code !== "ENOENT" && error?.code !== "ENOTDIR";
  }
}

/** Prints one short line on stderr, once per command tree (child processes inherit the mark). */
export function announce(text, env = process.env) {
  if (env["NOREN_GAME_MODE_ANNOUNCED"] === text) return;
  process.stderr.write(`game mode: ${text}\n`);
  process.env["NOREN_GAME_MODE_ANNOUNCED"] = text;
}

/** Max workers for Vitest: 8, or 4 while game mode is on. */
export function vitestWorkers(env = process.env, now = Date.now()) {
  const active = gameModeActive(env, now);
  const value = (active ? LIMITS : NORMAL_LIMITS).vitestWorkers;
  if (active) announce(`vitest maxWorkers=${value}`, env);
  return value;
}

/** Workers for Playwright: 8, or 4 while game mode is on. */
export function playwrightWorkers(env = process.env, now = Date.now()) {
  const active = gameModeActive(env, now);
  const value = (active ? LIMITS : NORMAL_LIMITS).playwrightWorkers;
  if (active) announce(`playwright workers=${value}`, env);
  return value;
}

/**
 * The environment a heavy command runs with: `CARGO_BUILD_JOBS` is 8, or 4 while game mode is on.
 * A smaller number the person already set is kept (it is never raised).
 */
export function cargoEnv(env = process.env, now = Date.now()) {
  const active = gameModeActive(env, now);
  const ceiling = (active ? LIMITS : NORMAL_LIMITS).cargoJobs;
  const set = Number.parseInt(env["CARGO_BUILD_JOBS"] ?? "", 10);
  const jobs = Number.isInteger(set) && set > 0 && set < ceiling ? set : ceiling;
  if (active) announce(`CARGO_BUILD_JOBS=${jobs}`, env);
  return { ...env, CARGO_BUILD_JOBS: String(jobs) };
}
