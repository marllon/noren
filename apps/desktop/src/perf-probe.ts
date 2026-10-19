import { emit } from "@tauri-apps/api/event";
import { insideTauri } from "./backend";

/** Name of the event the page emits when a terminal has drawn its first prompt (`noren --smoke-perf`). */
export const PROMPT_SHOWN_EVENT = "perf-prompt-shown";

/**
 * Tells the Rust side the first prompt of session `id` is on the terminal. Only `noren --smoke-perf`
 * listens (as only `--smoke` listens to `app-ready`); outside the app it does nothing.
 */
export function reportPromptShown(id: number): void {
  if (!insideTauri) return;
  emit(PROMPT_SHOWN_EVENT, { id }).catch(() => undefined);
}
