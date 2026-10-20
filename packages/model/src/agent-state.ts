import { DEFAULT_WAITING_PATTERNS, compileAgentPattern, silenceMsOf } from "./agents";
import type { AgentEntry } from "./agents";
import type { Clock } from "./clock";
import { NO_LAST_LINE, TerminalTextStripper, advanceLastLine, lastLineOf } from "./terminal-text";
import type { LastLineMemory } from "./terminal-text";

// What a CLI agent is doing in its pane: working, waiting for you, or idle. Told from what the
// agent prints (plain text, no escape sequences), from a notification it raised (OSC 9 and OSC 777
// reach here as `notification`), from what the person types, and from silence.
//
// The rules, in the order they apply to a piece of output:
//
//   1. a `waiting` pattern matches          -> waiting  (a question; beats everything below)
//   2. a `working` pattern matches          -> working  (a status line with its interrupt hint)
//   3. an `idle` pattern matches            -> idle     (the input prompt is back)
//   4. any other visible text               -> working, unless the agent is waiting (a redraw of
//      the question is not an answer) or it is idle and the person has just typed (the agent
//      echoing the keys is not work)
//
//   - a notification raised by the agent    -> waiting
//   - the person types while it waits       -> working (the answer went in)
//   - silence of `silenceMs` while working  -> idle     (waiting never decays: it waits for you)
//
// The patterns are data of the user (`agents.catalog[].patterns`), so all three are optional and a
// catalog without any still has the last four lines.
//
// Pure: no DOM, no Tauri, no dictionary of the interface. Time is a number the caller passes in,
// or a `Clock` the tracker is given, so tests move it by hand.

/** What an agent is doing. */
export type AgentState = "working" | "waiting" | "idle";

export const AGENT_STATES: readonly AgentState[] = ["working", "waiting", "idle"];

/** Output that comes this soon after the person typed is taken for the echo of the keys. */
export const AGENT_ECHO_WINDOW_MS = 150;

/** The part of the last line of a chunk kept for the next one, so a question cut in two is read whole. */
const MAX_PARTIAL_CHARS = 1000;
/** Most of a chunk the patterns are tried on (the end of it): a flood of output costs the same as a page. */
const MAX_WINDOW_CHARS = 8000;

/** The patterns of an agent, compiled, and how long its silence lasts. */
export interface AgentRules {
  readonly working: readonly RegExp[];
  readonly waiting: readonly RegExp[];
  readonly idle: readonly RegExp[];
  readonly silenceMs: number;
}

function compileAll(sources: readonly string[] | undefined): RegExp[] {
  const compiled: RegExp[] = [];
  for (const source of sources ?? []) {
    // A pattern that is not a regular expression never gets here from the settings file (the
    // schema refuses it); a caller that built an entry by hand just loses that pattern.
    const regex = compileAgentPattern(source);
    if (regex !== undefined) compiled.push(regex);
  }
  return compiled;
}

/**
 * The rules of one catalog entry. `defaultSilenceMs` (`agents.silenceSeconds`) applies unless the
 * entry has a `silenceSeconds` of its own. `undefined` (an agent the catalog does not have) gets no
 * patterns.
 */
export function compileAgentRules(
  entry: AgentEntry | undefined,
  defaultSilenceMs: number,
): AgentRules {
  return {
    working: compileAll(entry?.patterns?.working),
    waiting: compileAll(entry?.patterns?.waiting ?? DEFAULT_WAITING_PATTERNS),
    idle: compileAll(entry?.patterns?.idle),
    silenceMs:
      entry?.silenceSeconds !== undefined ? silenceMsOf(entry.silenceSeconds) : defaultSilenceMs,
  };
}

/** What the classifier remembers between two signals. */
export interface AgentStateMemory {
  readonly state: AgentState;
  /** When the state began, on the caller's clock. */
  readonly since: number;
  /** When the last output that counted as work arrived; `undefined` until there is one. */
  readonly lastOutputAt: number | undefined;
  /** When the person last typed. */
  readonly lastInputAt: number | undefined;
  /** The end of the last line of the output so far (it may be the start of a question). */
  readonly partial: string;
}

/** The memory of an agent just seen: idle, with nothing heard. */
export function startAgentState(now: number): AgentStateMemory {
  return {
    state: "idle",
    since: now,
    lastOutputAt: undefined,
    lastInputAt: undefined,
    partial: "",
  };
}

/** What happened to the agent. `output` carries plain text (see `TerminalTextStripper`). */
export type AgentSignal =
  | { readonly kind: "output"; readonly text: string }
  | { readonly kind: "notification" }
  | { readonly kind: "input" };

const matchesAny = (patterns: readonly RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

function withState(memory: AgentStateMemory, state: AgentState, now: number): AgentStateMemory {
  return state === memory.state ? memory : { ...memory, state, since: now };
}

/** The end of `text` after its last line break, cut to what is worth keeping. */
function partialOf(text: string): string {
  const rest = text.slice(text.lastIndexOf("\n") + 1);
  return rest.length > MAX_PARTIAL_CHARS ? rest.slice(rest.length - MAX_PARTIAL_CHARS) : rest;
}

/** The memory after `signal`, at time `now`. Never changes `memory`. */
export function advanceAgentState(
  memory: AgentStateMemory,
  signal: AgentSignal,
  now: number,
  rules: AgentRules,
): AgentStateMemory {
  if (signal.kind === "notification") return withState(memory, "waiting", now);
  if (signal.kind === "input") {
    if (memory.state === "waiting") {
      return {
        ...withState(memory, "working", now),
        lastOutputAt: now,
        lastInputAt: now,
        partial: "",
      };
    }
    return { ...memory, lastInputAt: now, partial: "" };
  }

  const joined = memory.partial + signal.text;
  const partial = partialOf(joined);
  if (joined.trim() === "") return partial === memory.partial ? memory : { ...memory, partial };
  const window =
    joined.length > MAX_WINDOW_CHARS ? joined.slice(joined.length - MAX_WINDOW_CHARS) : joined;

  // A match uses up the text it matched: the end of that line is not read again with the next chunk.
  if (matchesAny(rules.waiting, window)) {
    return { ...withState(memory, "waiting", now), partial: "" };
  }
  if (matchesAny(rules.working, window)) {
    return { ...withState(memory, "working", now), lastOutputAt: now, partial: "" };
  }
  if (matchesAny(rules.idle, window)) {
    return { ...withState(memory, "idle", now), partial: "" };
  }
  if (memory.state === "waiting") return { ...memory, partial };
  if (
    memory.state === "idle" &&
    memory.lastInputAt !== undefined &&
    now - memory.lastInputAt < AGENT_ECHO_WINDOW_MS
  ) {
    return { ...memory, partial };
  }
  return { ...withState(memory, "working", now), lastOutputAt: now, partial };
}

/** The memory after time passed with no signal: a working agent that was silent long enough is idle. */
export function settleAgentState(
  memory: AgentStateMemory,
  now: number,
  rules: AgentRules,
): AgentStateMemory {
  if (memory.state !== "working") return memory;
  const since = memory.lastOutputAt ?? memory.since;
  return now - since >= rules.silenceMs ? withState(memory, "idle", now) : memory;
}

/**
 * The `AgentState` of an agent over time, with a timer for the silence. Feed it what the agent
 * prints, the notifications it raises and the keys the person types; `onChange` runs when the state
 * changes and `onLine` when the last line of the output changes. `dispose` stops the timer.
 */
export class AgentStateTracker {
  readonly #clock: Clock;
  #rules: AgentRules;
  readonly #onChange: ((state: AgentState) => void) | undefined;
  readonly #onLine: (() => void) | undefined;
  readonly #stripper = new TerminalTextStripper();
  #memory: AgentStateMemory;
  #line: LastLineMemory = NO_LAST_LINE;
  #cancel: (() => void) | undefined;
  #disposed = false;

  constructor(options: {
    clock: Clock;
    rules: AgentRules;
    onChange?: (state: AgentState) => void;
    onLine?: () => void;
  }) {
    this.#clock = options.clock;
    this.#rules = options.rules;
    this.#onChange = options.onChange;
    this.#onLine = options.onLine;
    this.#memory = startAgentState(options.clock.now());
  }

  get state(): AgentState {
    return this.#memory.state;
  }

  /** When the current state began, on the clock of the tracker. */
  get since(): number {
    return this.#memory.since;
  }

  /**
   * The last line with something on it in the plain text of the output so far (the one still being
   * written counts, so a prompt shows); `""` before the agent printed anything. It is cut to
   * `MAX_LAST_LINE_CHARS`; the list of agents cuts it shorter for the screen.
   */
  get lastLine(): string {
    return lastLineOf(this.#line);
  }

  /** The rules in force from now on (the settings file changed). */
  setRules(rules: AgentRules): void {
    this.#rules = rules;
    this.#schedule();
  }

  /** A chunk of the output of the session, as the bytes it arrived in. */
  feed(chunk: Uint8Array | string): void {
    this.feedText(this.#stripper.feed(chunk));
  }

  /** A chunk of the output, already plain text. */
  feedText(text: string): void {
    if (!this.#disposed) {
      const before = this.lastLine;
      this.#line = advanceLastLine(this.#line, text);
      if (this.lastLine !== before) this.#onLine?.();
    }
    this.#signal({ kind: "output", text });
  }

  /** The agent raised a notification (OSC 9 or OSC 777). */
  notify(): void {
    this.#signal({ kind: "notification" });
  }

  /** The person typed. */
  input(): void {
    this.#signal({ kind: "input" });
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  #signal(signal: AgentSignal): void {
    if (this.#disposed) return;
    this.#set(advanceAgentState(this.#memory, signal, this.#clock.now(), this.#rules));
  }

  #set(next: AgentStateMemory): void {
    const before = this.#memory.state;
    this.#memory = next;
    this.#schedule();
    if (next.state !== before) this.#onChange?.(next.state);
  }

  /** Keeps one timer, set for the moment the silence of a working agent would be long enough. */
  #schedule(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    if (this.#disposed || this.#memory.state !== "working") return;
    const from = this.#memory.lastOutputAt ?? this.#memory.since;
    const wait = Math.max(0, from + this.#rules.silenceMs - this.#clock.now());
    this.#cancel = this.#clock.setTimer(() => {
      this.#cancel = undefined;
      this.#set(settleAgentState(this.#memory, this.#clock.now(), this.#rules));
    }, wait);
  }
}
