import { DEFAULT_PROFILE_ID, OLLAMA_PROVIDER_ID, aiIsOn } from "@noren/model";
import type {
  AiChatEvent,
  AiFunction,
  AskChip,
  AskCut,
  AskRefusal,
  Config,
  Id,
  OllamaModels,
  RedactionKind,
  ShellProfile,
  Space,
} from "@noren/model";
import { t } from "./i18n";

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
    if (text.trim() === "") left.push(t("ask.left.selection"));
    else chips.push({ kind: "selection", text });
  }
  if (choice.lastOutput) {
    const output = attempt(() => sources.lastOutput());
    if (output === undefined) {
      left.push(t("ask.left.lastNone"));
    } else if (output.text.trim() === "") {
      left.push(t("ask.left.lastEmpty"));
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
    if (text.trim() === "") left.push(t("ask.left.screen"));
    else chips.push({ kind: "screen", text });
  }
  for (const itemId of choice.tabs) {
    const tab = attempt(() => sources.tab(itemId));
    if (tab === undefined) left.push(t("ask.left.tabGone"));
    else if (tab.text.trim() === "") left.push(t("ask.left.tabEmpty", { title: tab.title }));
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
// Explaining a command

/** A command that ended with an error, picked on its mark: what the Explain button hands to Ask. */
export interface ExplainRequest {
  /** The command line, as the row of its prompt shows it (the prompt text may come along). */
  command: string;
  /** What the command printed. */
  output: string;
  /** The code the shell reported; absent when it did not say. */
  exitCode?: number | undefined;
  /** The start of the output was already trimmed from the scrollback, so `output` is only the end of it. */
  truncated: boolean;
}

/**
 * What the Explain button asks, in the language in force. The person sees it in the preview and may
 * change it with Edit.
 */
export const explainQuestion = (): string => t("ask.explainQuestion");

/** The chip that carries the command and its output. */
export function explainChip(request: ExplainRequest): AskChip {
  return {
    kind: "command",
    command: request.command,
    text: request.output,
    exitCode: request.exitCode,
    truncated: request.truncated,
  };
}

/** The chips of an explained command first, then the ones read from the terminal, as the message will carry them. */
export function chipsWithExplained(
  explained: ExplainRequest | undefined,
  read: readonly AskChip[],
): AskChip[] {
  return explained === undefined ? [...read] : [explainChip(explained), ...read];
}

/** What the chip of an explained command says on the panel: `Command: <line>`, cut to one short line. */
export function explainChipLabel(request: Pick<ExplainRequest, "command">): string {
  const flat = request.command.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : flat;
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

/** What the AI is asked to do: the panel asks and explains, the palette asks for a command. */
export type AskFunction = AiFunction;

/**
 * Whether the settings alone do not say who answers `fn`, so the Ollama of this computer has to be
 * asked for its models: no provider is named for `fn` in `ai.defaults` and none is listed in
 * `ai.providers`.
 */
export function askNeedsOllama(config: Pick<Config, "ai">, fn: AskFunction = "ask"): boolean {
  return config.ai?.defaults?.[fn] === undefined && (config.ai?.providers ?? []).length === 0;
}

/**
 * The provider and model that answer `fn` (Ask, Explain or Command). The one the settings name for
 * that function in `ai.defaults` wins; else the first provider of the file, with its own model; else
 * Ollama with the first model it has installed. `undefined` when nothing could answer (the steps
 * are shown then).
 */
export function askTarget(
  config: Pick<Config, "ai">,
  ollama: OllamaModels | undefined,
  fn: AskFunction = "ask",
): AskTarget | undefined {
  const named = config.ai?.defaults?.[fn];
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

/** The steps to a first provider, shown while nothing could answer `fn`. */
export function askSteps(fn: AskFunction = "ask"): readonly string[] {
  return [
    t("ask.step.ollama", {
      where: fn === "command" ? t("ask.where.dialog") : t("ask.where.panel"),
    }),
    t("ask.step.provider"),
    t("ask.step.choose", { function: t(`settings.ai.${fn}`) }),
  ];
}

/** The steps to a first provider, shown in the panel while nothing could answer. */
export const ASK_STEPS: readonly string[] = askSteps("ask");

// ---------------------------------------------------------------------------------------------
// The shell of a pane

/**
 * The name of the shell a pane runs, for the request of a command: the profile it names, or the
 * default profile of the machine when it names none (`default`). The id itself when the profile is
 * not among those listed, and `the shell` when there is nothing to say.
 */
export function shellNameOf(
  profileId: string | undefined,
  profiles: readonly ShellProfile[],
): string {
  if (profileId === undefined) return "the shell";
  const profile =
    profileId === DEFAULT_PROFILE_ID
      ? (profiles.find((one) => one.default) ?? profiles[0])
      : profiles.find((one) => one.id === profileId);
  return profile?.name ?? (profileId === DEFAULT_PROFILE_ID ? "the shell" : profileId);
}

// ---------------------------------------------------------------------------------------------
// The words of the panel

/** Why the AI is off here, for the notice of the shortcut that cannot open the panel. */
export function askOffNotice(config: Pick<Config, "ai">, space: Pick<Space, "aiEnabled">): string {
  if (aiIsOn(config, space)) return "";
  return config.ai?.enabled === true ? t("ask.off.space") : t("ask.off.global");
}

/** What to say when `buildAskMessages` refuses. */
export function refusalText(reason: AskRefusal, config: Pick<Config, "ai">): string {
  switch (reason) {
    case "ai-off":
      return config.ai?.enabled === true ? t("ask.off.space") : t("ask.off.global");
    case "empty-question":
      return t("ask.emptyQuestion");
    case "question-too-long":
      return t("ask.questionTooLong");
  }
}

/** The line of the preview about the secrets that were swapped for markers. */
export function secretsLine(redactions: number, kinds: readonly RedactionKind[]): string {
  if (redactions === 0) return t("ask.secrets.none");
  const joined = kinds.join(", ");
  return redactions === 1
    ? t("ask.secrets.one", { kinds: joined })
    : t("ask.secrets.other", { count: redactions, kinds: joined });
}

/** The line of the preview about a chip that was too long and was cut. */
export function cutLine(cut: AskCut): string {
  return t("ask.cut", {
    chip: t(`ask.chipName.${cut.chip}`),
    removed: cut.removed,
    end: cut.from === "end" ? t("ask.end.end") : t("ask.end.start"),
  });
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
      return t("ask.stopped");
    case "failed":
      return exchange.error ?? t("ask.couldNot");
    default:
      return undefined;
  }
}
