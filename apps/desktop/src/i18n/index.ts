import { useSyncExternalStore } from "react";
import { LANGUAGES, SYSTEM_LANGUAGE } from "@noren/model";
import type { LanguageSetting } from "@noren/model";
import { en } from "./en";
import { ptBR } from "./pt-BR";

// The words of the interface in the languages Noren speaks, without a library. `en.ts` is the source
// and holds every key; `pt-BR.ts` has the same keys, which `tsc` checks. A text with a value that
// changes has it written as `{name}`, and `t` fills it in. `@noren/model` never imports this: it is
// pure and hands out ids and numbers, and the interface says them in the language in force.

export type Language = (typeof LANGUAGES)[number];

/** Every text of the interface, by key. */
export type MessageKey = keyof typeof en;

/** The names between braces in a text: the values `t` has to be given. */
type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

/** The values a text asks for; no argument at all for a text without a placeholder. */
type ParamsOf<K extends MessageKey> = [Placeholders<(typeof en)[K]>] extends [never]
  ? []
  : [params: Readonly<Record<Placeholders<(typeof en)[K]>, string | number>>];

/** The same keys as `en`, each with the text in another language. */
export type Dictionary = { readonly [K in MessageKey]: string };

export const DICTIONARIES: Readonly<Record<Language, Dictionary>> = { en, "pt-BR": ptBR };

export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: "English",
  "pt-BR": "Português (Brasil)",
};

/**
 * The language to use for a setting of the file and the language of the system (what
 * `navigator.language` says). A language of ours is used as it is; "system", or no value, takes the
 * system's, and any other language of the system (or none) gets English.
 */
export function resolveLanguage(
  setting: LanguageSetting | string | undefined,
  system: string | undefined,
): Language {
  const own = LANGUAGES.find((language) => language === setting);
  if (own !== undefined) return own;
  if (setting !== undefined && setting !== SYSTEM_LANGUAGE) return "en";
  const tag = (system ?? "").toLowerCase();
  // pt-PT and the other Portuguese read the Brazilian one better than English.
  return tag === "pt" || tag.startsWith("pt-") ? "pt-BR" : "en";
}

/** Fills the `{name}` placeholders of a text; one without a value is left as it is. */
function fill(text: string, params: Readonly<Record<string, string | number>> | undefined): string {
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/**
 * The text of `key` in `language`, with the values filled in. A language Noren does not have, or a
 * key that language lacks, gives the English text.
 */
export function translate(
  language: string,
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  const dictionary: Readonly<Record<string, string>> = Object.hasOwn(DICTIONARIES, language)
    ? DICTIONARIES[language as Language]
    : en;
  return fill(dictionary[key] ?? en[key] ?? key, params);
}

// The language in force. It is English until `applyLanguageSetting` is called (the app does at boot
// and whenever the settings change), so a test never depends on the language of the computer.
let current: Language = "en";
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Makes `language` the one in force: the texts, the `lang` of the page, and whoever listens. */
export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  if (typeof document !== "undefined") document.documentElement.lang = language;
  for (const listener of [...listeners]) listener();
}

/** The language of the system as the browser tells it. */
export function systemLanguage(): string | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.language;
}

/**
 * Puts in force the language a setting of the file stands for (`undefined`: not set, so the
 * system's). Called for the file as it is read and at every change of it, so the language changes
 * with no restart.
 */
export function applyLanguageSetting(setting: LanguageSetting | string | undefined): void {
  const language = resolveLanguage(setting, systemLanguage());
  // The page says its language even when it did not change (the first call).
  if (typeof document !== "undefined") document.documentElement.lang = language;
  setLanguage(language);
}

/** The text of `key` in the language in force. */
export function t<K extends MessageKey>(key: K, ...args: ParamsOf<K>): string {
  return translate(current, key, args[0]);
}

/** `t` for a key that is only known at run time (no check of its placeholders). */
export function tDynamic(
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  return translate(current, key, params);
}

/**
 * The language in force. A component that says anything in words uses it (or `useT`), so it draws
 * again when the person changes the language.
 */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/** `t`, for a component that draws again when the language changes. */
export function useT(): typeof t {
  useLanguage();
  return t;
}

/** "1 tab", "3 tabs": the count with the word in the language in force. */
export function tabCount(count: number): string {
  return count === 1 ? t("count.tab.one") : t("count.tab.other", { count });
}

/** "1 pane", "3 panes": the count with the word in the language in force. */
export function paneCount(count: number): string {
  return count === 1 ? t("count.pane.one") : t("count.pane.other", { count });
}
