import {
  AI_FUNCTIONS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_WINDOW_EFFECT,
  MAX_BACKGROUND_BLUR,
  MIN_WINDOW_OPACITY,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SYSTEM_LANGUAGE,
  backgroundImageProblem,
  sameModList,
} from "@noren/model";
import type { Config, ConfigEdit, LanguageSetting, WindowEffect } from "@noren/model";
import type { AppearancePreview } from "./appearance-preview";
import type { Preset } from "./keybindings";
import { DEFAULT_LAYOUT, layoutFromConfig } from "./layout";
import type { Layout } from "./layout";
import { planProfiles, shownProfiles } from "./settings-profiles";
import type { ProfileField, ProfileRow } from "./settings-profiles";
import {
  planAi,
  planArchive,
  planTerminal,
  previewTerminal,
  shownAi,
  shownArchive,
  shownTerminal,
} from "./settings-sections";
import type {
  AiDraft,
  AiProblems,
  ArchiveDraft,
  ArchiveProblems,
  ShownAi,
  ShownArchive,
  ShownTerminal,
  TerminalDraft,
  TerminalProblems,
} from "./settings-sections";

// The pure part of the settings screen: which setting lives where in `config.jsonc`, the values in
// force (the file over the defaults), and what Save has to write for what the person changed. The
// screen itself (`SettingsDialog.tsx`) only draws this and hands the changes to the file.

/** The settings of the screen. The layout ones are the ones the shell already knows. */
export interface SettingsValues extends Layout {
  /** Which set of shortcuts is in force. */
  preset: Preset;
  /** System notifications on or off. */
  notifications: boolean;
  /** A command that runs longer than this many seconds notifies when it ends out of sight. */
  longCommandSeconds: number;
  /** The effect the system paints behind the window. */
  windowEffect: WindowEffect;
  /** The language of the interface: one of ours, or the language of the system. */
  language: LanguageSetting;
}

export type SettingKey = keyof SettingsValues;

/** The place of each setting in `config.jsonc`, in the order a new setting is written. */
export const SETTING_PATHS: Readonly<Record<SettingKey, readonly string[]>> = {
  side: ["appearance", "sidebar", "position"],
  width: ["appearance", "sidebar", "width"],
  compact: ["appearance", "sidebar", "compact"],
  keepOpen: ["appearance", "sidebar", "keepOpen"],
  density: ["appearance", "density"],
  tabs: ["appearance", "tabs"],
  favorites: ["appearance", "favorites"],
  style: ["appearance", "style"],
  paneHeaders: ["appearance", "paneHeaders"],
  preset: ["keybindings", "preset"],
  notifications: ["notifications", "enabled"],
  longCommandSeconds: ["notifications", "longCommandSeconds"],
  windowEffect: ["appearance", "window", "effect"],
  language: ["language"],
};

const KEYS = Object.keys(SETTING_PATHS) as SettingKey[];

export const DEFAULT_SETTINGS: SettingsValues = {
  ...DEFAULT_LAYOUT,
  preset: "safe",
  notifications: DEFAULT_NOTIFICATION_SETTINGS.enabled,
  longCommandSeconds: DEFAULT_NOTIFICATION_SETTINGS.longCommandMs / 1000,
  windowEffect: DEFAULT_WINDOW_EFFECT,
  language: SYSTEM_LANGUAGE,
};

/** The settings in force: what the file says, and the default for what it does not say. */
export function settingsOf(config: Config): SettingsValues {
  return {
    ...DEFAULT_SETTINGS,
    ...layoutFromConfig(config),
    ...(config.keybindings?.preset !== undefined ? { preset: config.keybindings.preset } : {}),
    ...(config.notifications?.enabled !== undefined
      ? { notifications: config.notifications.enabled }
      : {}),
    ...(config.notifications?.longCommandSeconds !== undefined
      ? { longCommandSeconds: config.notifications.longCommandSeconds }
      : {}),
    ...(config.appearance?.window?.effect !== undefined
      ? { windowEffect: config.appearance.window.effect }
      : {}),
    ...(config.language !== undefined ? { language: config.language } : {}),
  };
}

/** The settings the file mentions, which the defaults do not stand in for. */
export function settingsSetBy(config: Config): ReadonlySet<SettingKey> {
  const set = new Set<SettingKey>(Object.keys(layoutFromConfig(config)) as SettingKey[]);
  if (config.keybindings?.preset !== undefined) set.add("preset");
  if (config.notifications?.enabled !== undefined) set.add("notifications");
  if (config.notifications?.longCommandSeconds !== undefined) set.add("longCommandSeconds");
  if (config.appearance?.window?.effect !== undefined) set.add("windowEffect");
  if (config.language !== undefined) set.add("language");
  return set;
}

/**
 * What the person changed in the screen and has not saved yet. A setting that is not here shows the
 * value in force, so a change of the file by another program still shows through. The two numbers
 * are the text of their boxes, because half a number is a thing a person types on the way.
 */
export type SettingsDraft = Partial<Omit<SettingsValues, "width" | "longCommandSeconds">> & {
  width?: string;
  longCommandSeconds?: string;
  /** The mods that are on for every space, in the order they apply (the file names). */
  mods?: readonly string[];
  /** The Terminal section. */
  terminal?: TerminalDraft;
  /** The Auto-archive section. */
  archive?: ArchiveDraft;
  /** The AI section. */
  ai?: AiDraft;
  /** The whole list of profiles as rows, once the person touched it. */
  profiles?: readonly ProfileRow[];
} & Partial<Record<OptionalKey, string>>;

/**
 * The settings that may be left unset, typed in a box (an empty box is "not set"): how opaque the
 * interface is, and the picture behind the terminals with how much of it shows and how blurred it is.
 */
export type OptionalKey =
  "windowOpacity" | "backgroundImage" | "backgroundOpacity" | "backgroundBlur";

/** The place of each optional setting in `config.jsonc`, in the order of the file. */
export const OPTIONAL_PATHS: Readonly<Record<OptionalKey, readonly string[]>> = {
  windowOpacity: ["appearance", "window", "opacity"],
  backgroundImage: ["appearance", "background", "image"],
  backgroundOpacity: ["appearance", "background", "opacity"],
  backgroundBlur: ["appearance", "background", "blur"],
};

const OPTIONAL_KEYS = Object.keys(OPTIONAL_PATHS) as OptionalKey[];

/** What the file holds for an optional setting (`null` for one that is not set). */
function optionalValueOf(config: Config, key: OptionalKey): string | number | null {
  const { window, background } = config.appearance ?? {};
  const value =
    key === "windowOpacity"
      ? window?.opacity
      : key === "backgroundImage"
        ? background?.image
        : key === "backgroundOpacity"
          ? background?.opacity
          : background?.blur;
  return value ?? null;
}

/** The place of the list of global mods in `config.jsonc`. */
export const MODS_PATH: readonly string[] = ["mods"];

/** The two settings typed as numbers. */
export type NumberKey = "width" | "longCommandSeconds";

/** What the boxes and buttons of the screen show: the draft over the settings in force. */
export interface ShownSettings
  extends Omit<SettingsValues, NumberKey>, Record<OptionalKey, string> {
  width: string;
  longCommandSeconds: string;
  mods: readonly string[];
  terminal: ShownTerminal;
  archive: ShownArchive;
  ai: ShownAi;
  profiles: readonly ProfileRow[];
}

export function shownSettings(config: Config, draft: SettingsDraft): ShownSettings {
  const now = settingsOf(config);
  return {
    ...now,
    ...draft,
    width: draft.width ?? String(now.width),
    longCommandSeconds: draft.longCommandSeconds ?? String(now.longCommandSeconds),
    mods: draft.mods ?? config.mods ?? [],
    terminal: shownTerminal(config, draft.terminal),
    archive: shownArchive(config, draft.archive),
    ai: shownAi(config, draft.ai),
    profiles: shownProfiles(config, draft.profiles),
    ...Object.fromEntries(
      OPTIONAL_KEYS.map((key) => [key, draft[key] ?? String(optionalValueOf(config, key) ?? "")]),
    ),
  } as ShownSettings;
}

/** Whether the compact-mode box can be used: with top tabs the sidebar always hides. */
export function compactAvailable(shown: Pick<ShownSettings, "tabs">): boolean {
  return shown.tabs !== "top";
}

/** Whether the keep-open box can be used: only compact mode has a sidebar to keep open. */
export function keepOpenAvailable(shown: Pick<ShownSettings, "tabs" | "compact">): boolean {
  return shown.compact && shown.tabs !== "top";
}

export const WIDTH_PROBLEM = `Whole pixels, from ${SIDEBAR_MIN_WIDTH} to ${SIDEBAR_MAX_WIDTH}.`;
export const SECONDS_PROBLEM = "A number of seconds, zero or more.";
export const WINDOW_OPACITY_PROBLEM = `A number from ${MIN_WINDOW_OPACITY} to 1, or nothing to let the theme decide.`;
export const BACKGROUND_OPACITY_PROBLEM =
  "A number from 0 to 1, or nothing to let the theme decide.";
export const BACKGROUND_BLUR_PROBLEM = `A number of pixels from 0 to ${MAX_BACKGROUND_BLUR}, or nothing to let the theme decide.`;

/** The width a box holds, or `undefined` when it is not whole pixels in range. */
export function parseWidth(text: string): number | undefined {
  if (!/^\s*\d+\s*$/.test(text)) return undefined;
  const width = Number(text);
  return width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH ? width : undefined;
}

/** The seconds a box holds, or `undefined` when it is not a number of zero or more. */
export function parseSeconds(text: string): number | undefined {
  if (!/^\s*\d+(\.\d+)?\s*$/.test(text)) return undefined;
  const seconds = Number(text);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** A decimal number in a box, with blanks around: `0.5`, `.5`, `1`. */
function parseDecimal(text: string): number | undefined {
  if (!/^\s*(\d+(\.\d+)?|\.\d+)\s*$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The opacity of the interface a box holds, from the lowest allowed to 1; `undefined` when it is not one. */
export function parseWindowOpacity(text: string): number | undefined {
  const value = parseDecimal(text);
  return value !== undefined && value >= MIN_WINDOW_OPACITY && value <= 1 ? value : undefined;
}

/** The opacity of the picture a box holds, from 0 to 1; `undefined` when it is not one. */
export function parseBackgroundOpacity(text: string): number | undefined {
  const value = parseDecimal(text);
  return value !== undefined && value <= 1 ? value : undefined;
}

/** The blur of the picture a box holds, in pixels from 0 to the widest; `undefined` when it is not one. */
export function parseBackgroundBlur(text: string): number | undefined {
  const value = parseDecimal(text);
  return value !== undefined && value <= MAX_BACKGROUND_BLUR ? value : undefined;
}

/**
 * A box of a number that a slider moves, as the window tries it out before Save: `undefined` for a
 * box nobody touched, `null` for one that was emptied (not set, so the default of the window), the
 * number otherwise. Text that is not a number yet (a person typing, "0." on the way to "0.8") keeps
 * what the window was already trying out, `kept`, so the picture does not jump while someone types.
 */
export function previewNumber(
  text: string | undefined,
  parse: (text: string) => number | undefined,
  kept?: number | null,
): number | null | undefined {
  if (text === undefined) return undefined;
  return text.trim() === "" ? null : (parse(text) ?? kept);
}

/** How the read of the picture the box holds is going (the thumbnail of the picker has the answer). */
export type PictureReading = "none" | "loading" | "ready" | "failed";

/**
 * The picture a draft tries out behind the terminals: the path of a picture the window can read, so
 * the window shows it as soon as it is chosen. A path being read keeps `kept` (the picture shown
 * until now); one that cannot be read, or that is not a usable path at all, tries out nothing (the box
 * and the thumbnail tell why). An emptied box takes away the picture the file has (`null`), and has
 * nothing to try out where the file has none. `undefined` is "not tried out".
 */
export function previewPicture(
  text: string | undefined,
  reading: PictureReading,
  config: Config,
  kept?: string | null,
): string | null | undefined {
  if (text === undefined) return undefined;
  const path = text.trim();
  if (path === "") return optionalValueOf(config, "backgroundImage") === null ? undefined : null;
  if (backgroundImageProblem(path) !== undefined) return undefined;
  if (reading === "ready") return path;
  return reading === "loading" ? kept : undefined;
}

/**
 * The layout a draft tries out in the window at once: which side the sidebar is on, how wide it is,
 * the density, compact mode, the tabs, the favorites bar, the interface style and the pane headers. A
 * width that is not whole pixels in range yet keeps `kept`. `undefined` when the draft changed none of
 * them.
 */
export function previewLayout(
  draft: SettingsDraft,
  kept?: Partial<Layout>,
): Partial<Layout> | undefined {
  const width = draft.width === undefined ? undefined : (parseWidth(draft.width) ?? kept?.width);
  const tried: Partial<Layout> = {
    ...(draft.side !== undefined ? { side: draft.side } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(draft.density !== undefined ? { density: draft.density } : {}),
    ...(draft.compact !== undefined ? { compact: draft.compact } : {}),
    ...(draft.keepOpen !== undefined ? { keepOpen: draft.keepOpen } : {}),
    ...(draft.tabs !== undefined ? { tabs: draft.tabs } : {}),
    ...(draft.favorites !== undefined ? { favorites: draft.favorites } : {}),
    ...(draft.style !== undefined ? { style: draft.style } : {}),
    ...(draft.paneHeaders !== undefined ? { paneHeaders: draft.paneHeaders } : {}),
  };
  return Object.keys(tried).length === 0 ? undefined : tried;
}

/** What `previewOf` needs to know besides the draft. */
export interface PreviewContext {
  /** The settings in force. */
  config: Config;
  /** How the read of the picture of the box is going. */
  picture: PictureReading;
}

/**
 * What a draft tries out in the window at once, before it is saved: the numbers of the sliders, the
 * picture, the layout and the look of the terminal. `previous` is what the window was trying out
 * until now, kept for a box whose text is not a usable value yet.
 */
export function previewOf(
  draft: SettingsDraft,
  previous?: AppearancePreview,
  context?: PreviewContext,
): AppearancePreview {
  const picture =
    context === undefined
      ? undefined
      : previewPicture(
          draft.backgroundImage,
          context.picture,
          context.config,
          previous?.backgroundImage,
        );
  const layout = previewLayout(draft, previous?.layout);
  const terminal = previewTerminal(draft.terminal, previous?.terminal);
  return {
    windowOpacity: previewNumber(draft.windowOpacity, parseWindowOpacity, previous?.windowOpacity),
    backgroundOpacity: previewNumber(
      draft.backgroundOpacity,
      parseBackgroundOpacity,
      previous?.backgroundOpacity,
    ),
    backgroundBlur: previewNumber(
      draft.backgroundBlur,
      parseBackgroundBlur,
      previous?.backgroundBlur,
    ),
    ...(picture !== undefined ? { backgroundImage: picture } : {}),
    ...(layout !== undefined ? { layout } : {}),
    ...(terminal !== undefined ? { terminal } : {}),
  };
}

/**
 * What a box of an optional setting holds as a value to write: `null` for an empty box (not set),
 * or the value; `{ problem }` for text that cannot be one.
 */
function optionalFromText(
  key: OptionalKey,
  text: string,
): string | number | null | { problem: string } {
  if (text.trim() === "") return null;
  switch (key) {
    case "windowOpacity":
      return parseWindowOpacity(text) ?? { problem: WINDOW_OPACITY_PROBLEM };
    case "backgroundOpacity":
      return parseBackgroundOpacity(text) ?? { problem: BACKGROUND_OPACITY_PROBLEM };
    case "backgroundBlur":
      return parseBackgroundBlur(text) ?? { problem: BACKGROUND_BLUR_PROBLEM };
    case "backgroundImage": {
      const problem = backgroundImageProblem(text);
      return problem === undefined ? text : { problem };
    }
  }
}

/** What the screen writes for a draft: the settings to write, and the boxes whose text is not a usable value. */
export interface SavePlan {
  changes: ConfigEdit[];
  problems: Partial<Record<NumberKey | OptionalKey, string>>;
  /** The id each new profile row gets when `changes` are written, by the key of the row. */
  profileIds: Record<string, string>;
  /** The path of the picture in the draft is waiting to be read, so it is not written yet. */
  pictureWaits: boolean;
  /** The problems of the Terminal section, by setting. */
  terminalProblems: TerminalProblems;
  /** The problems of the Auto-archive section, by setting. */
  archiveProblems: ArchiveProblems;
  /** The problems of the AI section, by function. */
  aiProblems: AiProblems;
  /** The problems of the Profiles section, by the key of the row and the box. */
  profileProblems: Record<string, Partial<Record<ProfileField, string>>>;
}

/** Whether any box of the draft holds a value that cannot be written. */
export function hasProblems(plan: SavePlan): boolean {
  return (
    Object.keys(plan.problems).length > 0 ||
    Object.keys(plan.terminalProblems).length > 0 ||
    Object.keys(plan.archiveProblems).length > 0 ||
    Object.keys(plan.aiProblems).length > 0 ||
    Object.keys(plan.profileProblems).length > 0
  );
}

/** What `planSave` needs to know besides the file and the draft. */
export interface PlanContext {
  /** The ids of the shells of the machine, which a new profile cannot take. */
  takenProfileIds?: Iterable<string>;
  /**
   * How the read of the picture in the draft is going. A path is written only once the window could
   * read it (a path typed on the way, or one that is not there, is not a picture the file should
   * name; the thumbnail tells why). Left out, every path the schema takes is written.
   */
  picture?: PictureReading;
  /** The new profile rows the person is still filling in: reported, but not added until they leave. */
  heldProfileRows?: ReadonlySet<string>;
}

/**
 * The changes to write for a draft: only the settings whose value is not the one in force, in the
 * order of the file, so a setting put back where it was is not written. A box with a value that
 * cannot be used is a problem and writes nothing; the settings of the other boxes are still written,
 * so one wrong box never holds the rest back.
 */
export function planSave(
  config: Config,
  draft: SettingsDraft,
  context: PlanContext = {},
): SavePlan {
  const now = settingsOf(config);
  const problems: SavePlan["problems"] = {};
  const wanted: Partial<SettingsValues> = {};
  for (const key of KEYS) {
    const value = draft[key];
    if (value === undefined) continue;
    if (key === "width") {
      const width = parseWidth(String(value));
      if (width === undefined) problems.width = WIDTH_PROBLEM;
      else wanted.width = width;
    } else if (key === "longCommandSeconds") {
      const seconds = parseSeconds(String(value));
      if (seconds === undefined) problems.longCommandSeconds = SECONDS_PROBLEM;
      else wanted.longCommandSeconds = seconds;
    } else {
      (wanted as Record<string, unknown>)[key] = value;
    }
  }
  const changes: ConfigEdit[] = [];
  let pictureWaits = false;
  for (const key of KEYS) {
    const value = wanted[key];
    if (value === undefined || value === now[key]) continue;
    changes.push({ path: SETTING_PATHS[key], value });
  }
  // The optional settings: an empty box is "not set", written as null only where the file has a value.
  for (const key of OPTIONAL_KEYS) {
    const text = draft[key];
    if (text === undefined) continue;
    const wanted = optionalFromText(key, text);
    if (typeof wanted === "object" && wanted !== null) {
      problems[key] = wanted.problem;
    } else if (wanted !== optionalValueOf(config, key)) {
      if (
        key === "backgroundImage" &&
        wanted !== null &&
        context.picture !== undefined &&
        context.picture !== "ready"
      ) {
        pictureWaits = true;
      } else {
        changes.push({ path: OPTIONAL_PATHS[key], value: wanted });
      }
    }
  }
  // The list of mods is written whole, and only when it is not the one in force.
  if (draft.mods !== undefined && !sameModList(draft.mods, config.mods ?? [])) {
    changes.push({ path: MODS_PATH, value: draft.mods });
  }
  // The sections with their own plans, in the order of the file: terminal, profiles, archive, AI.
  const terminal = planTerminal(config, draft.terminal);
  const profiles = planProfiles(
    config,
    draft.profiles,
    context.takenProfileIds,
    context.heldProfileRows,
  );
  const archive = planArchive(config, draft.archive);
  const ai = planAi(config, draft.ai);
  changes.push(...terminal.changes, ...profiles.changes, ...archive.changes, ...ai.changes);
  return {
    changes,
    problems,
    pictureWaits,
    profileIds: profiles.ids,
    terminalProblems: terminal.problems,
    archiveProblems: archive.problems,
    aiProblems: ai.problems,
    profileProblems: profiles.problems,
  };
}

/**
 * What is left of a draft once the file has taken what was written: the parts of it that the file
 * does not have yet or that are not a value it can take (a box with a reason under it, a new profile
 * still being filled in, an empty row waiting for its text). What the file has is no draft anymore,
 * so the boxes show the file again and a change another program makes to it shows through.
 *
 * Each part is judged on its own, against the file as it is now: a part with nothing left to write
 * and no problem is settled, whatever the text in its box looks like (`0.80` is the `0.8` of the file).
 */
export function settledDraft(
  config: Config,
  draft: SettingsDraft,
  context: PlanContext = {},
): SettingsDraft {
  const left = (part: SettingsDraft): boolean => {
    const plan = planSave(config, part, context);
    return plan.changes.length > 0 || hasProblems(plan) || plan.pictureWaits;
  };
  const kept: Record<string, unknown> = {};
  for (const key of [...KEYS, ...OPTIONAL_KEYS, "mods"] as const) {
    const value = draft[key];
    if (value !== undefined && left({ [key]: value } as SettingsDraft)) kept[key] = value;
  }
  const keepParts = (section: "terminal" | "archive", parts: object | undefined) => {
    const stay: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parts ?? {})) {
      if (value !== undefined && left({ [section]: { [key]: value } } as SettingsDraft)) {
        stay[key] = value;
      }
    }
    if (Object.keys(stay).length > 0) kept[section] = stay;
  };
  keepParts("terminal", draft.terminal);
  keepParts("archive", draft.archive);
  if (draft.ai !== undefined) {
    const stay: Record<string, unknown> = {};
    if (draft.ai.enabled !== undefined && left({ ai: { enabled: draft.ai.enabled } })) {
      stay["enabled"] = draft.ai.enabled;
    }
    for (const fn of AI_FUNCTIONS) {
      const target = draft.ai[fn];
      if (target !== undefined && left({ ai: { [fn]: target } })) stay[fn] = target;
    }
    if (Object.keys(stay).length > 0) kept["ai"] = stay;
  }
  // The list of profiles is one part: a row that is not in the file yet (or a blank one the person
  // added to fill in) keeps all of it.
  if (
    draft.profiles !== undefined &&
    (draft.profiles.some((row) => !row.saved) || left({ profiles: draft.profiles }))
  ) {
    kept["profiles"] = draft.profiles;
  }
  return kept as SettingsDraft;
}
