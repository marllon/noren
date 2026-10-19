import { useSyncExternalStore } from "react";
import { DEFAULT_WINDOW_EFFECT } from "@noren/model";
import type { Backend, Config, WindowEffect, WindowEffectReport, WindowScheme } from "@noren/model";
import { t } from "./i18n";
import { effectName } from "./i18n/names";

// The effect the window has. The one that is asked for is `appearance.window.effect` of the settings
// file, painted dark or light like the theme in force (or like the system, when the theme
// follows it); the app hands both to `requestWindowEffect`
// (from an effect of `App`) every time either changes. This store passes them to the backend, which
// asks the system to paint the effect, and keeps what came back: the effect the window has, and why
// it is not the one that was asked for when the system could not paint it. The rest of the
// interface reads `appliedWindowEffect()`, never the setting, so a system without the effect keeps
// an opaque look.

type Listener = () => void;

const listeners = new Set<Listener>();
/** What the backend answered last; `undefined` until it was asked. */
let report: WindowEffectReport | undefined;
/** What was asked for last, so the same request is not made twice in a row. */
let asked: { effect: WindowEffect; scheme: WindowScheme } | undefined;
/** Requests go one after the other, so the answer of the last one is the one that stays. */
let queue: Promise<unknown> = Promise.resolve();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: Listener): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The effect the settings ask for (`none` without a value). */
export function requestedWindowEffect(config: Config): WindowEffect {
  return config.appearance?.window?.effect ?? DEFAULT_WINDOW_EFFECT;
}

/** What the backend answered last (`undefined`: the window has not been given an effect). */
export function getWindowEffectReport(): WindowEffectReport | undefined {
  return report;
}

/** The effect the window has now: `none` until a system that can paint one did. */
export function appliedWindowEffect(): WindowEffect {
  return report?.applied ?? "none";
}

/** The effect the window has; the component renders again when it changes. */
export function useAppliedWindowEffect(): WindowEffect {
  return useSyncExternalStore(subscribe, appliedWindowEffect);
}

/** What the backend answered last; the component renders again when it changes. */
export function useWindowEffectReport(): WindowEffectReport | undefined {
  return useSyncExternalStore(subscribe, getWindowEffectReport);
}

/** A sentence for a person about the last answer; empty when the window has what was asked for. */
export function windowEffectNote(answer: WindowEffectReport | undefined): string {
  if (answer === undefined || answer.applied === answer.requested) return "";
  const why = answer.reason !== undefined && answer.reason !== "" ? ` ${answer.reason}` : "";
  return t("windowEffect.notApplied", { effect: effectName(answer.requested), reason: why });
}

/**
 * Asks the backend for `effect`, painted to match `scheme`, unless that is what was asked last. With
 * no effect and nothing asked yet the backend is not called, since the window has none. A request the
 * backend cannot make (it rejects) leaves the window opaque and the reason in the answer.
 */
export function requestWindowEffect(
  backend: Pick<Backend, "setWindowEffect">,
  effect: WindowEffect,
  scheme: WindowScheme,
): void {
  const current = asked ?? { effect: DEFAULT_WINDOW_EFFECT, scheme };
  // With no effect the scheme does not matter: there is nothing to paint.
  const same =
    current.effect === effect && (effect === DEFAULT_WINDOW_EFFECT || current.scheme === scheme);
  if (same) return;
  asked = { effect, scheme };
  queue = queue.then(async () => {
    let answer: WindowEffectReport;
    try {
      answer = await backend.setWindowEffect(effect, scheme);
    } catch (error) {
      answer = { requested: effect, applied: "none", reason: reasonOf(error) };
    }
    report = answer;
    notify();
  });
}

/** Resolves once every request made so far was answered. For tests. */
export function windowEffectSettled(): Promise<void> {
  return queue.then(() => undefined);
}

/** Forgets the answer and what was asked, so a test starts from nothing. */
export function resetWindowEffect(): void {
  report = undefined;
  asked = undefined;
  queue = Promise.resolve();
  notify();
}
