// Game mode (NOR-F11-04, D20): when the user is playing, the heavy commands of the repository run
// lighter. The Windows watcher keeps a signal file while a game is open (contract in
// D:/Projetos/_modo-jogo/LEIA-ME.md); this is the only reader of it in the repository.
//
// The signal is valid when the file exists and was modified less than 60 s ago (an older one means
// the watcher stopped). It is read once, when a command starts, never in the middle of it. The path
// can be changed with NOREN_MODO_JOGO_ARQUIVO (the tests point it at a temporary file). CI (Linux)
// has no such file and never sees the signal. Without the signal nothing changes.
import { statSync } from "node:fs";

export const SIGNAL_PATH = "D:/Projetos/.modo-jogo";
export const SIGNAL_ENV = "NOREN_MODO_JOGO_ARQUIVO";
export const MAX_AGE_MS = 60_000;

/** The lighter limits that apply while game mode is on. */
export const LIMITS = { vitestWorkers: 8, playwrightWorkers: 4, cargoJobs: 8 };

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
 * (`pnpm shot`, NOR-F20-05, D22) refuses to run while it does, even when the watcher left it behind
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

/** Max workers for Vitest, or `undefined` (its own default) without the signal. */
export function vitestWorkers(env = process.env, now = Date.now()) {
  if (!gameModeActive(env, now)) return undefined;
  announce(`vitest maxWorkers=${LIMITS.vitestWorkers}`, env);
  return LIMITS.vitestWorkers;
}

/** Workers for Playwright, or `undefined` (its own default) without the signal. */
export function playwrightWorkers(env = process.env, now = Date.now()) {
  if (!gameModeActive(env, now)) return undefined;
  announce(`playwright workers=${LIMITS.playwrightWorkers}`, env);
  return LIMITS.playwrightWorkers;
}

/** The environment a heavy command runs with: `CARGO_BUILD_JOBS=8` while game mode is on. */
export function cargoEnv(env = process.env, now = Date.now()) {
  if (!gameModeActive(env, now)) return { ...env };
  announce(`CARGO_BUILD_JOBS=${LIMITS.cargoJobs}`, env);
  return { ...env, CARGO_BUILD_JOBS: String(LIMITS.cargoJobs) };
}
