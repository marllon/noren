import { z } from "zod";

// The AI providers: the schema of one entry of `ai.providers` in `config.jsonc`, the checks the
// backend repeats before it takes a list, and the shapes the `ai.*` methods of the backend talk in.
// No key is ever part of any of it: a key lives in the keychain of the system, under the id of its
// provider, and `ai.setKey` is the only way it travels. Pure; none of it throws.

/** What a provider speaks. `openai-compatible` covers Ollama, LM Studio, vLLM, OpenRouter, OpenAI and Groq. */
export const AI_PROVIDER_KINDS = ["openai-compatible", "anthropic"] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/** What the AI is asked to do; each has a default provider and model of its own. */
export const AI_FUNCTIONS = ["ask", "explain", "command"] as const;
export type AiFunction = (typeof AI_FUNCTIONS)[number];

/** The id of the provider every installation has: Ollama on this computer. No provider of the settings may take it. */
export const OLLAMA_PROVIDER_ID = "ollama";

/** Where Ollama listens by default, as the address of an `openai-compatible` provider. */
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";

/**
 * An id is lower case letters and digits, with `-` and `_` inside, starting with a letter or digit.
 * It is the name of the entry in the keychain, so it is held to what the keychain takes, and in lower
 * case because the keychain of Windows does not tell `Work` from `work`.
 */
export const AI_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** The longest id of a provider. */
export const MAX_AI_PROVIDER_ID = 64;

/** The most providers a settings file may list. */
export const MAX_AI_PROVIDERS = 50;

/** The longest model name. */
export const MAX_AI_MODEL = 200;

/** The longest address of a provider. */
export const MAX_AI_BASE_URL = 2048;

const notBlank = /\S/;

/**
 * Whether `address` starts with `http://` or `https://` and names a host. Anything else (`file:`,
 * `ftp:`, a bare `localhost:11434`) is not an address of a provider, and neither is one with blanks
 * or control characters, or with a user name or password in it (`http://me:secret@host`), which
 * would keep a secret in the settings file. The Rust side applies the same rule.
 */
export function isHttpAddress(address: string): boolean {
  const trimmed = address.trim();
  const rest = /^https?:\/\//.test(trimmed) ? trimmed.slice(trimmed.indexOf("//") + 2) : "";
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  return authority !== "" && !authority.includes("@") && ![...trimmed].some(isBlankOrControl);
}

/** A blank, or a control character (the C0 and C1 ranges): nothing an address can hold. */
function isBlankOrControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return /\s/.test(char) || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

export const AiProviderSchema = z
  .strictObject({
    id: z
      .string()
      .max(MAX_AI_PROVIDER_ID)
      .regex(
        AI_PROVIDER_ID_PATTERN,
        "Must be lower case letters, digits, '-' or '_', starting with a letter or digit, such as my-openai",
      )
      .meta({
        description:
          'The id of the provider, such as "my-openai". Unique among the providers; "ollama" is taken by the Ollama that Noren already knows. The API key is kept in the system keychain under this id.',
      }),
    kind: z.enum(AI_PROVIDER_KINDS).meta({
      description:
        '"openai-compatible" for Ollama, LM Studio, vLLM, OpenRouter, OpenAI, Groq and the like (the address is the API root, such as "https://api.openai.com/v1"); "anthropic" for the Anthropic API (such as "https://api.anthropic.com").',
    }),
    baseUrl: z
      .string()
      .max(MAX_AI_BASE_URL)
      .refine(isHttpAddress, {
        message:
          "Must start with http:// or https://, name a host and hold no user name or password",
      })
      .meta({
        description:
          "The address of the API, up to its root. Only http and https; never put a key in it, the key goes to the system keychain.",
      }),
    model: z.string().max(MAX_AI_MODEL).regex(notBlank, "The model is empty").meta({
      description: "The model this provider uses when a function does not name one in ai.defaults.",
    }),
  })
  .meta({ description: "An AI provider of your own." });

/** A provider as the settings list it (and as the backend takes it): no key. */
export type AiProviderConfig = z.infer<typeof AiProviderSchema>;

/** A provider as the backend reports it: the ones of the settings and Ollama, each with whether a key is stored. */
export interface AiProviderInfo {
  id: string;
  kind: AiProviderKind;
  baseUrl: string;
  /** The default model of the provider; empty for Ollama, whose model is chosen from the models it has installed. */
  model: string;
  /** A key is stored in the keychain under this id. The key itself is never reported. */
  hasKey: boolean;
}

/** What asking Ollama for its models found. Ollama not running is `found: false`, not an error. */
export type OllamaModels = { found: true; models: string[] } | { found: false };

/** Why a connection test failed: the kinds of the errors of the AI client. */
export type AiErrorKind =
  | "invalid-request"
  | "auth"
  | "http"
  | "network"
  | "timeout"
  | "cancelled"
  | "provider"
  | "protocol";

/**
 * How testing the connection to a provider ended. A failure is an answer, not a rejection: `message`
 * is a sentence for the person (a rejected key, an unreachable address, no answer in time), never
 * carries the key, and `kind` tells what to look at.
 */
export type AiConnectionResult = { ok: true } | { ok: false; kind: AiErrorKind; message: string };

/**
 * The AI side of the backend (`backend.ai`). Every call goes to the Rust side, the only one that
 * talks to a provider; the page never opens a connection to one. A key travels only in `setKey`.
 */
export interface AiBackend {
  /** Ollama first, then the providers handed over with `configure`, each with whether a key is stored. */
  providers(): Promise<AiProviderInfo[]>;
  /**
   * Gives the backend the providers of `ai.providers` in the settings, replacing the ones it had
   * (Ollama is always there and is not part of the list). The list is taken whole or not at all:
   * it rejects, with the reason, and keeps the providers it had when a provider does not match
   * `AiProviderSchema`, an id is used twice or is `ollama`, or there are too many (`aiProvidersProblem`
   * tells which). A key is never part of a provider.
   */
  configure(providers: readonly AiProviderConfig[]): Promise<void>;
  /**
   * Stores the API key of the provider `providerId` in the keychain of the system, or removes it when
   * `key` is blank (blanks around a pasted key are dropped). The only way a key enters the app.
   * Rejects, with a reason that does not hold the key, when `providerId` is not an id or the
   * keychain refuses.
   */
  setKey(providerId: string, key: string): Promise<void>;
  /** The models Ollama has installed, asked at the address of the pre-defined provider. Never rejects for a missing Ollama. */
  listOllamaModels(): Promise<OllamaModels>;
  /**
   * Checks that the provider answers and accepts its stored key, by reading its list of models: no
   * model is needed and nothing is billed. Resolves with the outcome. Rejects only when the test
   * could not start: `providerId` is not an id, there is no such provider, or the keychain cannot be read.
   */
  testConnection(providerId: string): Promise<AiConnectionResult>;
}

/** The first problem of a failed parse in a sentence: `baseUrl: Must start with http://`. */
function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "it is not a provider";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/**
 * Why a list of providers cannot be taken as it is, in a sentence, or `undefined` when it can. A
 * provider must match `AiProviderSchema` (which has no room for a key), ids must be unique and not
 * `ollama`, and there are at most `MAX_AI_PROVIDERS`. The backend runs the same checks.
 */
export function aiProvidersProblem(providers: readonly unknown[]): string | undefined {
  try {
    if (providers.length > MAX_AI_PROVIDERS) {
      return `There are more than ${MAX_AI_PROVIDERS} providers`;
    }
    const seen = new Set<string>();
    for (const [index, entry] of providers.entries()) {
      const parsed = AiProviderSchema.safeParse(entry);
      if (!parsed.success) return `Provider ${index + 1}: ${firstProblem(parsed.error)}`;
      const { id } = parsed.data;
      if (id === OLLAMA_PROVIDER_ID) return `Provider ${index + 1}: the id "${id}" is reserved`;
      if (seen.has(id)) return `Provider ${index + 1}: the id "${id}" is used by another provider`;
      seen.add(id);
    }
    return undefined;
  } catch {
    return "The providers could not be checked";
  }
}

/**
 * Whether the AI is on for a space: the settings turn it on (`ai.enabled`, off unless the file says
 * so) and the space has not turned it off for itself (`Space.aiEnabled`, on for a new space). Off
 * in either place means off, and no AI function may be offered or sent anything.
 */
export function aiIsOn(
  settings: { ai?: { enabled?: boolean | undefined } | undefined },
  space: { aiEnabled: boolean },
): boolean {
  return settings.ai?.enabled === true && space.aiEnabled;
}
