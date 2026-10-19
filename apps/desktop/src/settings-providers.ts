import {
  AI_FUNCTIONS,
  AiProviderSchema,
  OLLAMA_PROVIDER_ID,
  aiProvidersProblem,
} from "@noren/model";
import type {
  AiConnectionResult,
  AiProviderConfig,
  AiProviderKind,
  Config,
  ConfigEdit,
  OllamaModels,
} from "@noren/model";
import { t } from "./i18n";
import { AI_FUNCTION_LABELS, schemaProblem } from "./settings-sections";

// The pure part of the Providers part of the AI section of the settings screen: the form that adds
// a provider, what adding and removing one has to write into `config.jsonc` (the edit, or the
// reason there is none), and the words for what the screen found (Ollama, a connection test, the
// steps when nothing can answer yet). Adding and removing act at once, unlike the draft of the rest
// of the screen, because a provider has to be in the file before its key or its connection can be
// tried. A key is no part of any of it: it is typed into its own box and goes only to the keychain
// (`ai.setKey`), so nothing here can write it into the file.

/** The boxes of the form that adds a provider. */
export interface ProviderDraft {
  id: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
}

export type ProviderField = keyof ProviderDraft;

/** What is wrong, per box; `form` is what is wrong with the provider as a whole (too many, say). */
export type ProviderProblems = Partial<Record<ProviderField | "form", string>>;

export const NEW_PROVIDER: ProviderDraft = {
  id: "",
  kind: "openai-compatible",
  baseUrl: "",
  model: "",
};

export const PROVIDER_KIND_LABELS: Readonly<Record<AiProviderKind, string>> = {
  "openai-compatible": "OpenAI-compatible",
  anthropic: "Anthropic",
};

export const PROVIDER_ID_MISSING = "Type an id for the provider, such as my-openai.";
export const PROVIDER_ID_OLLAMA = `"${OLLAMA_PROVIDER_ID}" is the Ollama of this computer, which is always listed. Choose another id.`;
export const PROVIDER_URL_MISSING =
  "Type the address of the API, such as https://api.openai.com/v1.";
export const PROVIDER_MODEL_MISSING = "Type the model this provider uses.";

/** The first complaint of the schema about one box of a provider, `undefined` when it is fine. */
function fieldProblem(field: "id" | "baseUrl" | "model", value: string): string | undefined {
  const parsed = AiProviderSchema.shape[field].safeParse(value);
  return parsed.success ? undefined : (parsed.error.issues[0]?.message ?? "Not a valid value.");
}

/** The providers the file lists. */
function providersOf(config: Config): readonly AiProviderConfig[] {
  return config.ai?.providers ?? [];
}

export type AddProviderPlan =
  | { ok: true; edits: ConfigEdit[]; provider: AiProviderConfig }
  | { ok: false; problems: ProviderProblems };

/**
 * What adding the provider of the form writes: the provider appended to `ai.providers` (the list is
 * made when the file has none). Blanks around a box are dropped. An id that is `ollama` or is
 * already used, an address that is not an http(s) one without a user name or password, a blank
 * model, a list with too many providers, or anything else the schema of the file refuses is a
 * problem under its box and writes nothing.
 */
export function planAddProvider(config: Config, draft: ProviderDraft): AddProviderPlan {
  const provider: AiProviderConfig = {
    id: draft.id.trim(),
    kind: draft.kind,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
  };
  const problems: ProviderProblems = {};
  if (provider.id === "") problems.id = PROVIDER_ID_MISSING;
  else if (provider.id === OLLAMA_PROVIDER_ID) problems.id = PROVIDER_ID_OLLAMA;
  else if (providersOf(config).some((known) => known.id === provider.id)) {
    problems.id = `The id "${provider.id}" is used by another provider. Choose another id.`;
  } else {
    const problem = fieldProblem("id", provider.id);
    if (problem !== undefined) problems.id = problem;
  }
  if (provider.baseUrl === "") problems.baseUrl = PROVIDER_URL_MISSING;
  else {
    const problem = fieldProblem("baseUrl", provider.baseUrl);
    if (problem !== undefined) problems.baseUrl = problem;
  }
  if (provider.model === "") problems.model = PROVIDER_MODEL_MISSING;
  else {
    const problem = fieldProblem("model", provider.model);
    if (problem !== undefined) problems.model = problem;
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  // The whole list, as the backend and the file will judge it.
  const list = [...providersOf(config), provider];
  const form = aiProvidersProblem(list) ?? schemaProblem(["ai", "providers"], list);
  if (form !== undefined) return { ok: false, problems: { form } };
  return { ok: true, edits: [{ path: ["ai", "providers"], append: [provider] }], provider };
}

export type RemoveProviderPlan = { ok: true; edits: ConfigEdit[] } | { ok: false; reason: string };

/** "Ask", "Ask and Explain", "Ask, Explain and Command". */
function joined(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What removing the provider `id` writes: its entry taken out of `ai.providers`, the rest of the
 * list and the comments around it left as they are. A provider that a function names in
 * `ai.defaults` is not removed: the file would refuse to be read, so the reason says which
 * functions to move first.
 */
export function planRemoveProvider(config: Config, id: string): RemoveProviderPlan {
  const index = providersOf(config).findIndex((provider) => provider.id === id);
  if (index < 0) return { ok: false, reason: `"${id}" is not in the file.` };
  const using = AI_FUNCTIONS.filter((fn) => config.ai?.defaults?.[fn]?.provider === id);
  if (using.length > 0) {
    const names = using.map((fn) => AI_FUNCTION_LABELS[fn]);
    return {
      ok: false,
      reason: `"${id}" is the provider of ${joined(names)}. Choose another provider for ${using.length === 1 ? "it" : "them"} (or none) and save, then remove "${id}".`,
    };
  }
  return { ok: true, edits: [{ path: ["ai", "providers", index], remove: true }] };
}

// ---------------------------------------------------------------------------------------------
// What the screen says

/** What asking Ollama for its models has found so far; `undefined` while the question is out. */
export type OllamaFound = OllamaModels | undefined;

/** The line under Ollama: what was found on this computer. */
export function ollamaLine(found: OllamaFound): string {
  if (found === undefined) return t("providers.ollama.looking");
  if (!found.found) return t("providers.ollama.notFound");
  if (found.models.length === 0) return t("providers.ollama.noModel");
  return found.models.length === 1
    ? t("providers.ollama.one")
    : t("providers.ollama.other", { count: found.models.length });
}

/**
 * Whether there is nothing the AI could answer with yet: the file lists no provider and Ollama is
 * either not there or has no model. While the question to Ollama is out, it is not known, so the
 * steps are not shown.
 */
export function needsSteps(config: Config, found: OllamaFound): boolean {
  if (found === undefined || providersOf(config).length > 0) return false;
  return !found.found || found.models.length === 0;
}

/** The steps that lead to a provider, shown while `needsSteps` holds, in the language in force. */
export const providerSteps = (): readonly string[] => [
  t("providers.step.ollama"),
  t("providers.step.own"),
  t("providers.step.turnOn"),
];

/** What a connection test said, in a sentence for the person. */
export function connectionLine(result: AiConnectionResult): string {
  return result.ok
    ? t("providers.connection.works")
    : t("providers.connection.failed", { message: result.message });
}

/** The message of a failure, with `secret` (the key that was being stored) taken out of it. */
export function reasonWithout(error: unknown, secret: string): string {
  const text = error instanceof Error ? error.message : String(error);
  return secret === "" ? text : text.split(secret).join("[key]");
}
