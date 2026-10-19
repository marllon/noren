import { OLLAMA_PROVIDER_ID, aiIsOn } from "@noren/model";
import type {
  AiChatEvent,
  AskChip,
  AskCut,
  AskRefusal,
  Config,
  Id,
  OllamaModels,
  RedactionKind,
  Space,
} from "@noren/model";

// The Ask panel without the screen: which chips the person chose and what they read from the
// terminal, which provider and model answer, the words of the preview, and how an answer that
// arrives in pieces builds up. Pure, so each rule can be tested without a terminal or a provider.
// What goes out is made by `buildAskMessages` in `@noren/model` and nothing here touches it.

// ---------------------------------------------------------------------------------------------
// Context chips

/** The chips the person has switched on: three that stand for a place in the current pane, and tabs. */
export interface AskChoice {
  selection: boolean;
  lastOutput: boolean;
  screen: boolean;
  /** The tabs added with `@`, in the order they were added. */
  tabs: readonly Id[];
}

export const NO_CHOICE: AskChoice = {
  selection: false,
  lastOutput: false,
  screen: false,
  tabs: [],
};

/** What the chips are read from: the terminals, asked when the question is reviewed. */
export interface AskSources {
  /** The text selected in the terminal of the pane in use. */
  selection(): string;
  /** The output of the last command that ended there, with the command line when it is known. */
  lastOutput(): { text: string; command?: string | undefined } | undefined;
  /** The rows on screen in that terminal. */
  screen(): string;
  /** The title of a tab and the text of its terminal; `undefined` when the tab is gone. */
  tab(itemId: Id): { title: string; text: string } | undefined;
}

export interface ReadChips {
  /** The chips that had something to say, in the order the message will carry them. */
  chips: AskChip[];
  /** One sentence for each chip that was switched on and had nothing, so it is not a silent gap. */
  left: string[];
}

/** Where the text of a chip comes from may fail (a terminal that went away): that is nothing to say. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Reads the chips that are on, in a fixed order (selection, last output, screen, then the tabs as
 * they were added). A chip with no text is left out and says why in `left`.
 */
export function readAskChips(choice: AskChoice, sources: AskSources): ReadChips {
  const chips: AskChip[] = [];
  const left: string[] = [];
  if (choice.selection) {
    const text = attempt(() => sources.selection()) ?? "";
    if (text.trim() === "") left.push("Selection: nothing is selected in the terminal.");
    else chips.push({ kind: "selection", text });
  }
  if (choice.lastOutput) {
    const output = attempt(() => sources.lastOutput());
    if (output === undefined) {
      left.push("Last output: no command has finished in this pane yet.");
    } else if (output.text.trim() === "") {
      left.push("Last output: the last command printed nothing.");
    } else {
      chips.push({
        kind: "lastOutput",
        text: output.text,
        ...(output.command !== undefined ? { command: output.command } : {}),
      });
    }
  }
  if (choice.screen) {
    const text = attempt(() => sources.screen()) ?? "";
    if (text.trim() === "") left.push("Screen: the screen is empty.");
    else chips.push({ kind: "screen", text });
  }
  for (const itemId of choice.tabs) {
    const tab = attempt(() => sources.tab(itemId));
    if (tab === undefined) left.push("A tab you added is gone.");
    else if (tab.text.trim() === "") left.push(`Tab ${tab.title}: it has no text yet.`);
    else chips.push({ kind: "tab", title: tab.title, text: tab.text });
  }
  return { chips, left };
}

/** The choice with a tab added (once) or taken out. */
export function withTab(choice: AskChoice, itemId: Id, on: boolean): AskChoice {
  const others = choice.tabs.filter((id) => id !== itemId);
  return { ...choice, tabs: on ? [...others, itemId] : others };
}

/** The tabs the choice names that still exist: a tab that was closed leaves the choice. */
export function liveChoice(choice: AskChoice, exists: (itemId: Id) => boolean): AskChoice {
  const tabs = choice.tabs.filter(exists);
  return tabs.length === choice.tabs.length ? choice : { ...choice, tabs };
}

// ---------------------------------------------------------------------------------------------
// Who answers

/** The provider and model a question goes to. */
export interface AskTarget {
  providerId: string;
  model: string;
  /** For the header of the panel: `Ollama · llama3`. */
  label: string;
}

function providerName(id: string): string {
  return id === OLLAMA_PROVIDER_ID ? "Ollama" : id;
}

/**
 * Whether the settings alone do not say who answers, so the Ollama of this computer has to be asked
 * for its models: no provider is named for Ask in `ai.defaults` and none is listed in `ai.providers`.
 */
export function askNeedsOllama(config: Pick<Config, "ai">): boolean {
  return config.ai?.defaults?.ask === undefined && (config.ai?.providers ?? []).length === 0;
}

/**
 * The provider and model that answer Ask. The one the settings name for Ask wins; else the first
 * provider of the file, with its own model; else Ollama with the first model it has installed.
 * `undefined` when nothing could answer (the steps are shown then).
 */
export function askTarget(
  config: Pick<Config, "ai">,
  ollama: OllamaModels | undefined,
): AskTarget | undefined {
  const named = config.ai?.defaults?.ask;
  if (named !== undefined) {
    return {
      providerId: named.provider,
      model: named.model,
      label: `${providerName(named.provider)} · ${named.model}`,
    };
  }
  const first = (config.ai?.providers ?? [])[0];
  if (first !== undefined) {
    return {
      providerId: first.id,
      model: first.model,
      label: `${providerName(first.id)} · ${first.model}`,
    };
  }
  const model = ollama?.found === true ? ollama.models[0] : undefined;
  if (model === undefined) return undefined;
  return {
    providerId: OLLAMA_PROVIDER_ID,
    model,
    label: `${providerName(OLLAMA_PROVIDER_ID)} · ${model}`,
  };
}

/** The steps to a first provider, shown in the panel while nothing could answer. */
export const ASK_STEPS: readonly string[] = [
  "Install Ollama, start it and install a model in it (ollama pull followed by the name of a model). Then close this panel and open it again.",
  "Or open Settings, then AI, and add a provider of your own: the kind, the address of its API and a model. A key goes to the keychain of your system, never to config.jsonc.",
  "In the same place, choose the provider and the model for Ask, and press Save.",
];

// ---------------------------------------------------------------------------------------------
// The words of the panel

/** Why the AI is off here, for the notice of the shortcut that cannot open the panel. */
export function askOffNotice(config: Pick<Config, "ai">, space: Pick<Space, "aiEnabled">): string {
  if (aiIsOn(config, space)) return "";
  return config.ai?.enabled === true
    ? "The AI is off for this space. Turn it on in the space menu."
    : "The AI is off. Turn it on in Settings, in the AI section.";
}

/** What to say when `buildAskMessages` refuses. */
export function refusalText(reason: AskRefusal, config: Pick<Config, "ai">): string {
  switch (reason) {
    case "ai-off":
      return config.ai?.enabled === true
        ? "The AI is off for this space. Turn it on in the space menu."
        : "The AI is off. Turn it on in Settings, in the AI section.";
    case "empty-question":
      return "Type a question first.";
    case "question-too-long":
      return "The question is too long. Shorten it and try again.";
  }
}

/** The line of the preview about the secrets that were swapped for markers. */
export function secretsLine(redactions: number, kinds: readonly RedactionKind[]): string {
  if (redactions === 0) return "No secret was found in what will be sent.";
  const what =
    redactions === 1
      ? "1 secret was replaced by a marker"
      : `${redactions} secrets were replaced by markers`;
  return `${what} (${kinds.join(", ")}).`;
}

const CHIP_NAMES: Readonly<Record<AskChip["kind"], string>> = {
  selection: "The selection",
  lastOutput: "The output of the last command",
  screen: "The visible screen",
  tab: "A tab",
};

/** The line of the preview about a chip that was too long and was cut. */
export function cutLine(cut: AskCut): string {
  const end = cut.from === "end" ? "the end" : "the start";
  return `${CHIP_NAMES[cut.chip]} was cut: ${cut.removed} characters left out from ${end}.`;
}

// ---------------------------------------------------------------------------------------------
// An answer that arrives in pieces

/** `streaming` until the provider ends it; then how it ended. */
export type AskStatus = "streaming" | "done" | "stopped" | "failed";

/** One question and its answer, as the panel lists them. */
export interface AskExchange {
  /** Order of asking, for the list. */
  key: number;
  requestId: string;
  question: string;
  /** What has come of the answer so far. */
  answer: string;
  status: AskStatus;
  /** Why it failed; absent unless `status` is `failed`. */
  error?: string;
  /** How many secrets were replaced in what was sent. */
  redactions: number;
}

/** A question just sent: nothing has come back. */
export function startExchange(
  key: number,
  requestId: string,
  question: string,
  redactions: number,
): AskExchange {
  return { key, requestId, question, answer: "", status: "streaming", redactions };
}

/**
 * The exchange after an event of its stream. Pieces are appended in order; the end is the first
 * `done` or `error`, and anything that arrives after it is ignored. A cancelled request is a
 * `stopped` answer (what had come stays), any other error is `failed` with its sentence.
 */
export function applyAskEvent(exchange: AskExchange, event: AiChatEvent): AskExchange {
  if (exchange.status !== "streaming") return exchange;
  switch (event.type) {
    case "delta":
      return { ...exchange, answer: exchange.answer + event.text };
    case "done":
      return { ...exchange, status: "done" };
    case "error":
      return event.kind === "cancelled"
        ? { ...exchange, status: "stopped" }
        : { ...exchange, status: "failed", error: event.message };
  }
}

/** The exchange after a request that could not even start. */
export function failExchange(exchange: AskExchange, reason: string): AskExchange {
  return exchange.status === "streaming"
    ? { ...exchange, status: "failed", error: reason }
    : exchange;
}

/** The id of the request number `seq`, made at time `now` (ms): letters, digits and `-`, at most 64. */
export function askRequestId(seq: number, now: number): string {
  const whole = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `ask-${whole(now).toString(36)}-${whole(seq)}`;
}

/** The word under an answer that did not end well, or `undefined` for one that did. */
export function statusNote(exchange: AskExchange): string | undefined {
  switch (exchange.status) {
    case "stopped":
      return "Stopped.";
    case "failed":
      return exchange.error ?? "The AI could not answer.";
    default:
      return undefined;
  }
}
