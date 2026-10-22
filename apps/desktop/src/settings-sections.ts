import {
  AI_FUNCTIONS,
  ConfigSchema,
  DEFAULT_ARCHIVE_AFTER_HOURS,
  DEFAULT_ARCHIVE_ENABLED,
  DEFAULT_BELL_STYLE,
  DEFAULT_CURSOR_BLINK,
  DEFAULT_CURSOR_STYLE,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_LIGATURES,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_MAX_PANES,
  DEFAULT_RIGHT_CLICK,
  DEFAULT_SCREEN_READER_MODE,
  DEFAULT_SCROLLBACK,
  MAX_FONT_SIZE,
  MAX_LINE_HEIGHT,
  MAX_MAX_PANES,
  MAX_SCROLLBACK,
  MIN_FONT_SIZE,
  MIN_LINE_HEIGHT,
  MIN_MAX_PANES,
  MIN_SCROLLBACK,
  OLLAMA_PROVIDER_ID,
  clampFontSize,
  safeFontFamily,
} from "@noren/model";
import type {
  AiFunction,
  BellStyle,
  Config,
  ConfigChange,
  ConfigEdit,
  ConfigPath,
  CursorStyle,
  RightClickAction,
  TerminalOptions,
} from "@noren/model";

// The pure part of the Terminal, Auto-archive and AI sections of the settings screen: where each
// setting lives in `config.jsonc`, the values in force (the file over the defaults), and what Save
// has to write for what the person changed. A value is checked against the schema of the file
// (`ConfigSchema`) before anything is written, so the screen can never ask for a file the app would
// refuse to read; the boxes show the reason where the value is typed.

/** What `ConfigSchema` says about one setting set to `value`: the first complaint, or `undefined`. */
export function schemaProblem(path: ConfigPath, value: unknown): string | undefined {
  const tree = path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  const parsed = ConfigSchema.safeParse(tree);
  if (parsed.success) return undefined;
  return parsed.error.issues[0]?.message ?? "Not a valid value.";
}

/** A number in a box, with blanks around and a sign allowed (the schema judges the range). */
export function numberOfText(text: string): number | undefined {
  if (!/^\s*-?(\d+(\.\d+)?|\.\d+)\s*$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Terminal

/** The settings of the Terminal section. */
export interface TerminalValues {
  /** The list of font names, as written in the file (`Cascadia Code, Consolas, monospace`). */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  ligatures: boolean;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  bell: BellStyle;
  screenReaderMode: boolean;
  rightClick: RightClickAction;
  /** The most panes one tab holds. */
  maxPanes: number;
}

export type TerminalKey = keyof TerminalValues;

/** The place of each terminal setting in `config.jsonc`, in the order a new setting is written. */
export const TERMINAL_PATHS: Readonly<Record<TerminalKey, readonly string[]>> = {
  fontFamily: ["terminal", "font", "family"],
  fontSize: ["terminal", "font", "size"],
  lineHeight: ["terminal", "font", "lineHeight"],
  ligatures: ["terminal", "font", "ligatures"],
  cursorStyle: ["terminal", "cursor", "style"],
  cursorBlink: ["terminal", "cursor", "blink"],
  scrollback: ["terminal", "scrollback"],
  bell: ["terminal", "bell"],
  screenReaderMode: ["terminal", "screenReaderMode"],
  rightClick: ["terminal", "rightClick"],
  maxPanes: ["terminal", "maxPanes"],
};

const TERMINAL_KEYS = Object.keys(TERMINAL_PATHS) as TerminalKey[];

export const DEFAULT_TERMINAL_VALUES: TerminalValues = {
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
  lineHeight: DEFAULT_LINE_HEIGHT,
  ligatures: DEFAULT_LIGATURES,
  cursorStyle: DEFAULT_CURSOR_STYLE,
  cursorBlink: DEFAULT_CURSOR_BLINK,
  scrollback: DEFAULT_SCROLLBACK,
  bell: DEFAULT_BELL_STYLE,
  screenReaderMode: DEFAULT_SCREEN_READER_MODE,
  rightClick: DEFAULT_RIGHT_CLICK,
  maxPanes: DEFAULT_MAX_PANES,
};

/** The terminal settings in force: what the file says, and the default for what it does not say. */
export function terminalValuesOf(config: Config): TerminalValues {
  const { font, cursor, scrollback, bell, screenReaderMode, rightClick, maxPanes } =
    config.terminal ?? {};
  return {
    fontFamily: font?.family ?? DEFAULT_TERMINAL_VALUES.fontFamily,
    fontSize: font?.size ?? DEFAULT_TERMINAL_VALUES.fontSize,
    lineHeight: font?.lineHeight ?? DEFAULT_TERMINAL_VALUES.lineHeight,
    ligatures: font?.ligatures ?? DEFAULT_TERMINAL_VALUES.ligatures,
    cursorStyle: cursor?.style ?? DEFAULT_TERMINAL_VALUES.cursorStyle,
    cursorBlink: cursor?.blink ?? DEFAULT_TERMINAL_VALUES.cursorBlink,
    scrollback: scrollback ?? DEFAULT_TERMINAL_VALUES.scrollback,
    bell: bell ?? DEFAULT_TERMINAL_VALUES.bell,
    screenReaderMode: screenReaderMode ?? DEFAULT_TERMINAL_VALUES.screenReaderMode,
    rightClick: rightClick ?? DEFAULT_TERMINAL_VALUES.rightClick,
    maxPanes: maxPanes ?? DEFAULT_TERMINAL_VALUES.maxPanes,
  };
}

/** The font list the "Installed font" choice writes: the name, then the generic family as a fallback. */
export function fontChoice(name: string): string {
  return `${name}, monospace`;
}

/** The boxes of the section, as typed: the numbers are text because half a number is typed on the way. */
export type TerminalTextKey = "fontFamily" | "fontSize" | "lineHeight" | "scrollback" | "maxPanes";

/** What the person changed in the Terminal section and has not saved. */
export type TerminalDraft = Partial<Omit<TerminalValues, TerminalTextKey>> &
  Partial<Record<TerminalTextKey, string>>;

/** What the controls of the section show: the draft over the settings in force. */
export type ShownTerminal = Omit<TerminalValues, TerminalTextKey> & Record<TerminalTextKey, string>;

export function shownTerminal(config: Config, draft: TerminalDraft | undefined): ShownTerminal {
  const now = terminalValuesOf(config);
  return {
    ...now,
    ...draft,
    fontFamily: draft?.fontFamily ?? now.fontFamily,
    fontSize: draft?.fontSize ?? String(now.fontSize),
    lineHeight: draft?.lineHeight ?? String(now.lineHeight),
    scrollback: draft?.scrollback ?? String(now.scrollback),
    maxPanes: draft?.maxPanes ?? String(now.maxPanes),
  };
}

export const FONT_SIZE_PROBLEM = `A number of pixels from ${MIN_FONT_SIZE} to ${MAX_FONT_SIZE}.`;
export const LINE_HEIGHT_PROBLEM = `A number from ${MIN_LINE_HEIGHT} to ${MAX_LINE_HEIGHT}.`;
export const SCROLLBACK_PROBLEM = `A whole number of lines, from ${MIN_SCROLLBACK} to ${MAX_SCROLLBACK}.`;
export const MAX_PANES_PROBLEM = `A whole number of panes, from ${MIN_MAX_PANES} to ${MAX_MAX_PANES}.`;

export type TerminalProblems = Partial<Record<TerminalKey, string>>;

/** One terminal setting of the draft as the value to write, or why it cannot be one. */
function terminalWanted(
  key: TerminalKey,
  value: string | number | boolean,
): { value: string | number | boolean } | { problem: string } {
  let wanted: string | number | boolean = value;
  let friendly: string | undefined;
  switch (key) {
    case "fontFamily":
      wanted = String(value).trim();
      break;
    case "fontSize":
      friendly = FONT_SIZE_PROBLEM;
      break;
    case "lineHeight":
      friendly = LINE_HEIGHT_PROBLEM;
      break;
    case "scrollback":
      friendly = SCROLLBACK_PROBLEM;
      break;
    case "maxPanes":
      friendly = MAX_PANES_PROBLEM;
      break;
    default:
      break;
  }
  if (friendly !== undefined) {
    const number = numberOfText(String(value));
    if (number === undefined) return { problem: friendly };
    wanted = number;
  }
  const problem = schemaProblem(TERMINAL_PATHS[key], wanted);
  if (problem === undefined) return { value: wanted };
  // The words of the schema say it best for a list of fonts; a number gets its range in plain words.
  return { problem: friendly ?? problem };
}

/**
 * What the Terminal draft tries out in the terminals at once, before Save: the font, the size, the
 * line height, the ligatures and the cursor (what a person sees change). A box whose text is not a
 * value the schema takes yet (half a number on the way) keeps what the terminals were already
 * trying out, `kept`, so the text does not jump while someone types; the settings that have no
 * effect to see (scrollback, bell, panes) are not tried out. `undefined` when there is nothing.
 */
export function previewTerminal(
  draft: TerminalDraft | undefined,
  kept?: Partial<TerminalOptions>,
): Partial<TerminalOptions> | undefined {
  if (draft === undefined) return undefined;
  const tried: Partial<TerminalOptions> = {};
  const text = (key: "fontFamily" | "fontSize" | "lineHeight") => {
    const value = draft[key];
    if (value === undefined) return undefined;
    const wanted = terminalWanted(key, value);
    return "value" in wanted ? wanted.value : kept?.[key];
  };
  const family = text("fontFamily");
  if (typeof family === "string" && family !== "") tried.fontFamily = safeFontFamily(family);
  const size = text("fontSize");
  if (typeof size === "number") tried.fontSize = clampFontSize(size);
  const lineHeight = text("lineHeight");
  if (typeof lineHeight === "number") tried.lineHeight = lineHeight;
  if (draft.ligatures !== undefined) tried.ligatures = draft.ligatures;
  if (draft.cursorStyle !== undefined) tried.cursorStyle = draft.cursorStyle;
  if (draft.cursorBlink !== undefined) tried.cursorBlink = draft.cursorBlink;
  return Object.keys(tried).length === 0 ? undefined : tried;
}

/**
 * The changes to write for the Terminal draft: only the settings whose value is not the one in
 * force, in the order of the file. A box with a value the schema refuses is a problem and writes
 * nothing.
 */
export function planTerminal(
  config: Config,
  draft: TerminalDraft | undefined,
): { changes: ConfigChange[]; problems: TerminalProblems } {
  const now = terminalValuesOf(config);
  const changes: ConfigChange[] = [];
  const problems: TerminalProblems = {};
  if (draft === undefined) return { changes, problems };
  for (const key of TERMINAL_KEYS) {
    const value = draft[key];
    if (value === undefined) continue;
    const wanted = terminalWanted(key, value);
    if ("problem" in wanted) problems[key] = wanted.problem;
    else if (wanted.value !== now[key])
      changes.push({ path: TERMINAL_PATHS[key], value: wanted.value });
  }
  return { changes, problems };
}

// ---------------------------------------------------------------------------------------------
// Auto-archive

/** The settings of the Auto-archive section. */
export interface ArchiveValues {
  enabled: boolean;
  afterHours: number;
}

export type ArchiveKey = keyof ArchiveValues;

export const ARCHIVE_PATHS: Readonly<Record<ArchiveKey, readonly string[]>> = {
  enabled: ["archive", "enabled"],
  afterHours: ["archive", "afterHours"],
};

export const DEFAULT_ARCHIVE_VALUES: ArchiveValues = {
  enabled: DEFAULT_ARCHIVE_ENABLED,
  afterHours: DEFAULT_ARCHIVE_AFTER_HOURS,
};

export function archiveValuesOf(config: Config): ArchiveValues {
  return {
    enabled: config.archive?.enabled ?? DEFAULT_ARCHIVE_VALUES.enabled,
    afterHours: config.archive?.afterHours ?? DEFAULT_ARCHIVE_VALUES.afterHours,
  };
}

/** What the person changed in the Auto-archive section; the hours are the text of their box. */
export interface ArchiveDraft {
  enabled?: boolean;
  afterHours?: string;
}

export interface ShownArchive {
  enabled: boolean;
  afterHours: string;
}

export function shownArchive(config: Config, draft: ArchiveDraft | undefined): ShownArchive {
  const now = archiveValuesOf(config);
  return {
    enabled: draft?.enabled ?? now.enabled,
    afterHours: draft?.afterHours ?? String(now.afterHours),
  };
}

export const AFTER_HOURS_PROBLEM =
  "A number of hours above zero. A fraction is fine: 0.5 is half an hour.";

export type ArchiveProblems = Partial<Record<ArchiveKey, string>>;

/** The changes to write for the Auto-archive draft, with the same rules as `planTerminal`. */
export function planArchive(
  config: Config,
  draft: ArchiveDraft | undefined,
): { changes: ConfigChange[]; problems: ArchiveProblems } {
  const now = archiveValuesOf(config);
  const changes: ConfigChange[] = [];
  const problems: ArchiveProblems = {};
  if (draft === undefined) return { changes, problems };
  if (draft.enabled !== undefined && draft.enabled !== now.enabled) {
    changes.push({ path: ARCHIVE_PATHS.enabled, value: draft.enabled });
  }
  if (draft.afterHours !== undefined) {
    const hours = numberOfText(draft.afterHours);
    if (hours === undefined || schemaProblem(ARCHIVE_PATHS.afterHours, hours) !== undefined) {
      problems.afterHours = AFTER_HOURS_PROBLEM;
    } else if (hours !== now.afterHours) {
      changes.push({ path: ARCHIVE_PATHS.afterHours, value: hours });
    }
  }
  return { changes, problems };
}

// ---------------------------------------------------------------------------------------------
// AI

/** The provider and the model a function of the AI uses; both empty is "no default". */
export interface AiTarget {
  provider: string;
  model: string;
}

/** The settings of the AI section: the switch, and the default of each function. */
export interface AiValues {
  enabled: boolean;
  ask: AiTarget;
  explain: AiTarget;
  command: AiTarget;
}

export type AiKey = keyof AiValues;

/** The place of each AI setting in `config.jsonc`: a function's target is the group `provider` and `model` sit in. */
export const AI_PATHS: Readonly<Record<AiKey, readonly string[]>> = {
  enabled: ["ai", "enabled"],
  ask: ["ai", "defaults", "ask"],
  explain: ["ai", "defaults", "explain"],
  command: ["ai", "defaults", "command"],
};

/** The name of each function of the AI on the screen. */
export const AI_FUNCTION_LABELS: Readonly<Record<AiFunction, string>> = {
  ask: "Ask",
  explain: "Explain",
  command: "Command",
};

export const NO_AI_TARGET: AiTarget = { provider: "", model: "" };

export const DEFAULT_AI_VALUES: AiValues = {
  enabled: false,
  ask: NO_AI_TARGET,
  explain: NO_AI_TARGET,
  command: NO_AI_TARGET,
};

/** The AI settings in force: what the file says, and the default (off, no default target) for the rest. */
export function aiValuesOf(config: Config): AiValues {
  const { enabled, defaults } = config.ai ?? {};
  const target = (fn: AiFunction): AiTarget => defaults?.[fn] ?? NO_AI_TARGET;
  return {
    enabled: enabled ?? DEFAULT_AI_VALUES.enabled,
    ask: target("ask"),
    explain: target("explain"),
    command: target("command"),
  };
}

/** What the person changed for one function: the provider id and the text of the model box. */
export interface AiTargetDraft {
  provider?: string;
  model?: string;
}

/** What the person changed in the AI section and has not saved. */
export interface AiDraft {
  enabled?: boolean;
  ask?: AiTargetDraft;
  explain?: AiTargetDraft;
  command?: AiTargetDraft;
}

export interface ShownAi {
  enabled: boolean;
  ask: AiTarget;
  explain: AiTarget;
  command: AiTarget;
}

export function shownAi(config: Config, draft: AiDraft | undefined): ShownAi {
  const now = aiValuesOf(config);
  const target = (fn: AiFunction): AiTarget => ({
    provider: draft?.[fn]?.provider ?? now[fn].provider,
    model: draft?.[fn]?.model ?? now[fn].model,
  });
  return {
    enabled: draft?.enabled ?? now.enabled,
    ask: target("ask"),
    explain: target("explain"),
    command: target("command"),
  };
}

/** The ids a function can pick: the Ollama of this computer, then the providers of the file. */
export function aiProviderIds(config: Config): readonly string[] {
  return [OLLAMA_PROVIDER_ID, ...(config.ai?.providers ?? []).map((provider) => provider.id)];
}

export const AI_MODEL_MISSING = "Type the model to use with this provider, or choose no provider.";
export const AI_PROVIDER_MISSING = "Choose the provider this model belongs to.";

/** What is wrong with the target of one function, and in which of its two controls. */
export interface AiTargetProblem {
  field: "provider" | "model";
  message: string;
}

export type AiProblems = Partial<Record<AiFunction, AiTargetProblem>>;

/**
 * What `ConfigSchema` says about `target` as the default of `fn`, with the providers of the file
 * beside it (the schema refuses a provider the file does not list): the first complaint.
 */
function aiTargetProblem(
  config: Config,
  fn: AiFunction,
  target: AiTarget,
): AiTargetProblem | undefined {
  const providers = config.ai?.providers;
  const tree = {
    ai: {
      ...(providers !== undefined ? { providers } : {}),
      defaults: { [fn]: target },
    },
  };
  const parsed = ConfigSchema.safeParse(tree);
  if (parsed.success) return undefined;
  const [issue] = parsed.error.issues;
  const field = issue?.path.at(-1) === "model" ? "model" : "provider";
  return { field, message: issue?.message ?? "Not a valid value." };
}

/**
 * The changes to write for the AI draft, with the same rules as `planArchive`, in the order of the
 * file: the switch, then the functions. A function with a provider and a model is written when it
 * differs from the file (only the part that differs when the file has it already); one with neither
 * is taken out of the file, and left alone when the file has none; one with only a provider, or only
 * a model, or a pair the schema refuses (a provider the file does not list), is a problem and writes
 * nothing.
 */
export function planAi(
  config: Config,
  draft: AiDraft | undefined,
): { changes: ConfigEdit[]; problems: AiProblems } {
  const now = aiValuesOf(config);
  const changes: ConfigEdit[] = [];
  const problems: AiProblems = {};
  if (draft === undefined) return { changes, problems };
  if (draft.enabled !== undefined && draft.enabled !== now.enabled) {
    changes.push({ path: AI_PATHS.enabled, value: draft.enabled });
  }
  for (const fn of AI_FUNCTIONS) {
    const part = draft[fn];
    if (part === undefined) continue;
    const had = now[fn];
    const provider = (part.provider ?? had.provider).trim();
    const model = (part.model ?? had.model).trim();
    const path = AI_PATHS[fn];
    if (provider === "" && model === "") {
      if (had.provider !== "") changes.push({ path, remove: true });
    } else if (provider === "") {
      problems[fn] = { field: "provider", message: AI_PROVIDER_MISSING };
    } else if (model === "") {
      problems[fn] = { field: "model", message: AI_MODEL_MISSING };
    } else {
      const problem = aiTargetProblem(config, fn, { provider, model });
      if (problem !== undefined) {
        problems[fn] = problem;
      } else {
        if (provider !== had.provider)
          changes.push({ path: [...path, "provider"], value: provider });
        if (model !== had.model) changes.push({ path: [...path, "model"], value: model });
      }
    }
  }
  return { changes, problems };
}
