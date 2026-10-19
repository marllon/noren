import { emit } from "@tauri-apps/api/event";
import { insideTauri } from "./backend";

/** Name of the event the page emits when a terminal has drawn its first prompt (`noren --smoke-perf`). */
export const PROMPT_SHOWN_EVENT = "perf-prompt-shown";

/** When the page began and the moments it went through, in milliseconds since 1970. */
const marks: [string, number][] = [];

/** The wall clock with sub-millisecond detail, on the same scale as the Rust side's marks. */
let marksSent = false;

const wallNow = () => performance.timeOrigin + performance.now();

if (insideTauri) marks.push(["page-navigation-start", performance.timeOrigin]);

/**
 * Notes that the page reached `name` now (NOR-F11-01d). Nothing leaves the page here: the list goes
 * in the payload of `reportPromptShown`, which only `noren --smoke-perf` listens to, so a normal
 * start pays one array push per mark and no IPC call.
 */
export function perfMark(name: string): void {
  if (insideTauri) marks.push([name, wallNow()]);
}

/** Like {@link perfMark}, but only the first time `name` is reached (a component that renders often). */
export function perfMarkOnce(name: string): void {
  if (insideTauri && !marks.some(([known]) => known === name)) marks.push([name, wallNow()]);
}

/**
 * Tells the Rust side the first prompt of session `id` is on the terminal, with the marks the page
 * made. Only `noren --smoke-perf` listens (as only `--smoke` listens to `app-ready`); outside the
 * app it does nothing.
 */
export function reportPromptShown(id: number): void {
  if (!insideTauri) return;
  // The marks go with the first prompt only: they are the start of the app, and one report is enough.
  const sent = marksSent ? [] : [...marks, ["prompt-written", wallNow()]];
  marksSent = true;
  emit(PROMPT_SHOWN_EVENT, { id, marks: sent }).catch(() => undefined);
}
