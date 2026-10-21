import { z } from "zod";
import { validEnv } from "./env";
import { checkInvariants } from "./invariants";
import { MAX_MODS, isValidModFileName } from "./mods";
import { redactSecrets } from "./redact";
import { encodeUtf8 } from "./utf8";
import {
  MAX_USER_PROFILES,
  UserProfileSchema,
  firstProblem,
  profilesProblem,
  type UserProfile,
} from "./user-profile-schema";
import {
  DEFAULT_MAX_PANES,
  type GroupNode,
  type Id,
  type Item,
  type LayoutNode,
  type Node,
  type Pane,
  type Space,
  type Workspace,
} from "./types";

// The file of a space (`.noren-space.json`, NOR-F18-03a): the layout of a space, its groups, the
// profiles it uses and its environment, without secrets, in a form that can be sent to someone or
// kept in a repository. This is the pure side: the schema, `exportSpace`, `parseSpaceFile`,
// `spaceFromFile` (which the `space/import` action uses) and `planProfiles`. Choosing a file,
// writing it and reading it are in the interface (NOR-F18-03b). No DOM, no Tauri.
//
// What the file holds of a space: name, icon, color, theme, mods, the AI and scrollback switches,
// the defaults (profile, folder, environment, git identity), the pinned items, the tree with its
// groups (live ones included), and every item with its layout and its panes (kind, profile,
// folder, address, file) and the origin it returns to. What it leaves out is what only means
// something on this run or on this computer: sessions, the command running, the last command, the
// scrollback, when a tab was last used, the unread marks, the picture behind the terminals (a path
// of this computer), and the title a program asked for (only a title the user locked is kept).
//
// Ids in the file are its own (`i1` for an item, `g1` for a group, `p1` for a pane, numbered in the
// order they are met), never the ones of the workspace it came from, so exporting a space that was
// imported gives the same file. Importing gives every space, item, group and pane a fresh id.

/** What the file says it is. */
export const SPACE_FILE_FORMAT = "noren-space";
/** The version this build writes and reads. */
export const SPACE_FILE_VERSION = 1;
/** The ending of the name of the file. */
export const SPACE_FILE_EXTENSION = ".noren-space.json";

export const SPACE_FILE_LIMITS = {
  /** The largest file read, in bytes. */
  bytes: 1024 * 1024,
  /** Most items in a space. */
  items: 500,
  /** Deepest nesting of the JSON text; the layout and the tree are far shallower. */
  jsonDepth: 64,
} as const;

// ---------------------------------------------------------------------------------------------
// The schema

/** The id of an item, group or pane inside the file: short, no spaces or control characters. */
const fileId = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/, { error: "an id must be 1 to 64 letters, digits or _ . : -" });

const nonBlank = (text: string): boolean => text.trim() !== "";
const noNul = (text: string): boolean => !text.includes("\u0000");

const text = (max: number) =>
  z
    .string()
    .min(1, { error: "must not be empty" })
    .max(max, { error: `must be at most ${max} characters` })
    .refine(noNul, { error: "must not contain a NUL character" });

const label = (max: number) => text(max).refine(nonBlank, { error: "must not be blank" });

const envSchema = z
  .record(text(256), z.string().max(32 * 1024))
  .refine((env) => Object.keys(env).length <= 500, { error: "more than 500 variables" })
  .refine((env) => !Object.hasOwn(env, "__proto__") && validEnv(env), {
    error: "a variable has a name that cannot be one, or a NUL in its value",
  });

const liveSchema = z.union([
  z.strictObject({ source: z.literal("worktrees"), folder: text(1024) }),
  z.strictObject({ source: z.literal("ssh") }),
  z.strictObject({ source: z.literal("docker") }),
]);

const paneSchema = z.strictObject({
  id: fileId,
  type: z.enum(["terminal", "browser", "preview", "diff"]),
  profileId: text(200),
  cwd: text(1024).optional(),
  url: text(2048).optional(),
  path: text(1024).optional(),
});

const paneLeafSchema = z.strictObject({ kind: z.literal("pane"), pane: paneSchema });

const splitSchema = z.strictObject({
  kind: z.literal("split"),
  dir: z.enum(["row", "column"]),
  sizes: z.array(z.number()).max(16),
  get children() {
    return z.array(layoutSchema).max(16);
  },
});

const layoutSchema = z.union([paneLeafSchema, splitSchema]);

const itemSchema = z.strictObject({
  id: fileId,
  /** The title the user locked; absent for a tab whose title follows its program. */
  title: text(200).optional(),
  focusedPaneId: fileId,
  origin: z
    .strictObject({ cwd: text(1024), profileId: text(200), command: text(4096).optional() })
    .optional(),
  liveKey: text(1024).optional(),
  layout: layoutSchema,
});

const itemRefSchema = z.strictObject({ kind: z.literal("item"), id: fileId });

const groupSchema = z.strictObject({
  kind: z.literal("group"),
  id: fileId,
  name: label(200),
  color: label(64),
  collapsed: z.boolean(),
  live: liveSchema.optional(),
  get children() {
    return z.array(nodeSchema).max(SPACE_FILE_LIMITS.items);
  },
});

const nodeSchema = z.union([itemRefSchema, groupSchema]);

const spaceSchema = z.strictObject({
  name: label(200),
  icon: label(64),
  color: label(64),
  themeId: label(128).optional(),
  modIds: z
    .array(z.string().refine(isValidModFileName, { error: "is not the name of a mod file" }))
    .max(MAX_MODS)
    .refine((list) => new Set(list).size === list.length, { error: "a mod is listed twice" }),
  aiEnabled: z.boolean(),
  saveScrollback: z.boolean(),
  defaults: z.strictObject({
    profileId: text(200).optional(),
    cwd: text(1024).optional(),
    env: envSchema,
    gitIdentity: z
      .strictObject({
        name: z.string().max(200).refine(noNul, { error: "must not contain a NUL character" }),
        email: z.string().max(320).refine(noNul, { error: "must not contain a NUL character" }),
      })
      .optional(),
  }),
  pinned: z.array(fileId).max(SPACE_FILE_LIMITS.items),
  tree: z.array(nodeSchema).max(SPACE_FILE_LIMITS.items),
  items: z.array(itemSchema).max(SPACE_FILE_LIMITS.items),
  activeItemId: fileId.optional(),
});

export const SpaceFileSchema = z.strictObject({
  format: z.literal(SPACE_FILE_FORMAT),
  version: z.literal(SPACE_FILE_VERSION),
  space: spaceSchema,
  profiles: z.array(UserProfileSchema).max(MAX_USER_PROFILES),
});

export type SpaceFile = z.infer<typeof SpaceFileSchema>;
export type SpaceFileSpace = SpaceFile["space"];
export type SpaceFileItem = SpaceFileSpace["items"][number];
export type SpaceFileNode = SpaceFileSpace["tree"][number];

// ---------------------------------------------------------------------------------------------
// Checking a file

export type SpaceFileParse = { ok: true; file: SpaceFile } | { ok: false; error: string };

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** The id the space gets while the file is checked; no id of a file can hold a space. */
const CHECK_SPACE_ID = "(space)";

/**
 * Checks a value as the file of a space, in a short sentence when it is not one: the right
 * `format` and `version`, the schema (a field that is not in it is an error), no id used twice, the
 * profiles, and the structure of the space under the same rules as the workspace (`checkInvariants`:
 * split sizes, the focused pane, a page address, a file path, every item placed once, groups two
 * levels deep, at most `maxPanes` panes to a tab). Never throws.
 */
export function validateSpaceFile(
  value: unknown,
  maxPanes: number = DEFAULT_MAX_PANES,
): SpaceFileParse {
  try {
    const head = headProblem(value);
    if (head !== undefined) return refuse(head);
    const parsed = SpaceFileSchema.safeParse(value);
    if (!parsed.success) return refuse(firstProblem(parsed.error));
    const file = parsed.data;
    const twice = repeatedId(file.space);
    if (twice !== undefined) return refuse(`the id "${twice}" is used more than once`);
    const profiles = profilesProblem(file.profiles);
    if (profiles !== undefined) return refuse(profiles);
    const built = buildSpace(file, CHECK_SPACE_ID, (id) => id, 0);
    const violation = checkInvariants(checkWorkspace(built), { maxPanes })[0];
    if (violation !== undefined) return refuse(violation.message);
    return { ok: true, file };
  } catch {
    return refuse("the file could not be checked");
  }
}

function headProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "it is not a Noren space file";
  }
  const head = value as Record<string, unknown>;
  if (head["format"] !== SPACE_FILE_FORMAT) return "it is not a Noren space file";
  if (head["version"] !== SPACE_FILE_VERSION) {
    return `version ${JSON.stringify(head["version"])} is not one this build reads (it reads version ${SPACE_FILE_VERSION})`;
  }
  return undefined;
}

/** The first id that an item, a group or a pane of the space shares with another. */
function repeatedId(space: SpaceFileSpace): string | undefined {
  const seen = new Set<string>();
  let twice: string | undefined;
  const see = (id: string): void => {
    if (seen.has(id)) twice ??= id;
    seen.add(id);
  };
  const walkLayout = (node: z.infer<typeof layoutSchema>): void => {
    if (node.kind === "pane") see(node.pane.id);
    else node.children.forEach(walkLayout);
  };
  const walkTree = (nodes: readonly z.infer<typeof nodeSchema>[]): void => {
    for (const node of nodes) {
      if (node.kind === "group") {
        see(node.id);
        walkTree(node.children);
      }
    }
  };
  for (const item of space.items) {
    see(item.id);
    walkLayout(item.layout);
  }
  walkTree(space.tree);
  return twice;
}

function checkWorkspace(space: Space): Workspace {
  return {
    version: 2,
    spaces: [space],
    activeSpaceId: space.id,
    favorites: [],
    closed: [],
    archive: [],
  };
}

/**
 * The text of a file as the file of a space, or why it is not one. Refuses a text over
 * `SPACE_FILE_LIMITS.bytes`, one that is not JSON and one nested deeper than `jsonDepth` before
 * the schema looks at it. Never throws.
 */
export function parseSpaceFile(
  source: string,
  maxPanes: number = DEFAULT_MAX_PANES,
): SpaceFileParse {
  try {
    if (typeof source !== "string") return refuse("it is not text");
    const tooBig = `the file is larger than ${SPACE_FILE_LIMITS.bytes / 1024} KiB`;
    if (source.length > SPACE_FILE_LIMITS.bytes) return refuse(tooBig);
    if (encodeUtf8(source).length > SPACE_FILE_LIMITS.bytes) return refuse(tooBig);
    const body = source.startsWith("﻿") ? source.slice(1) : source;
    if (jsonDepth(body) > SPACE_FILE_LIMITS.jsonDepth) return refuse("the file is nested too deep");
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return refuse("it is not valid JSON");
    }
    return validateSpaceFile(value, maxPanes);
  } catch {
    return refuse("the file could not be read");
  }
}

/** How deep the brackets of a JSON text go (strings skipped); stops counting past the limit. */
function jsonDepth(source: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
      if (depth > deepest) deepest = depth;
      if (deepest > SPACE_FILE_LIMITS.jsonDepth) return deepest;
    } else if (ch === "}" || ch === "]") {
      depth--;
    }
  }
  return deepest;
}

// ---------------------------------------------------------------------------------------------
// From a file to a space

function buildLayout(node: z.infer<typeof layoutSchema>, idOf: (id: Id) => Id): LayoutNode {
  if (node.kind === "split") {
    return {
      kind: "split",
      dir: node.dir,
      sizes: [...node.sizes],
      children: node.children.map((child) => buildLayout(child, idOf)),
    };
  }
  const pane = node.pane;
  const made: Pane = {
    id: idOf(pane.id),
    type: pane.type,
    profileId: pane.profileId,
    ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
    ...(pane.url !== undefined ? { url: pane.url } : {}),
    ...(pane.path !== undefined ? { path: pane.path } : {}),
    status: "idle",
    unread: false,
    bell: false,
  };
  return { kind: "pane", pane: made };
}

function buildNode(node: z.infer<typeof nodeSchema>, idOf: (id: Id) => Id): Node {
  if (node.kind === "item") return { kind: "item", id: idOf(node.id) };
  const group: GroupNode = {
    kind: "group",
    id: idOf(node.id),
    name: node.name,
    color: node.color,
    collapsed: node.collapsed,
    children: node.children.map((child) => buildNode(child, idOf)),
    ...(node.live !== undefined ? { live: { ...node.live } } : {}),
  };
  return group;
}

/** The space a checked file describes, every id passed through `idOf` (the space's own is `id`). */
function buildSpace(file: SpaceFile, id: Id, idOf: (id: Id) => Id, now: number): Space {
  const source = file.space;
  const items: Record<Id, Item> = {};
  for (const item of source.items) {
    const made: Item = {
      id: idOf(item.id),
      ...(item.title !== undefined ? { title: item.title } : {}),
      titleLocked: item.title !== undefined,
      layout: buildLayout(item.layout, idOf),
      focusedPaneId: idOf(item.focusedPaneId),
      ...(item.origin !== undefined
        ? {
            origin: {
              cwd: item.origin.cwd,
              profileId: item.origin.profileId,
              ...(item.origin.command !== undefined ? { command: item.origin.command } : {}),
            },
          }
        : {}),
      ...(item.liveKey !== undefined ? { liveKey: item.liveKey } : {}),
      lastActivityAt: now,
    };
    items[made.id] = made;
  }
  const defaults = source.defaults;
  return {
    id,
    name: source.name,
    icon: source.icon,
    color: source.color,
    ...(source.themeId !== undefined ? { themeId: source.themeId } : {}),
    modIds: [...source.modIds],
    defaults: {
      env: { ...defaults.env },
      ...(defaults.profileId !== undefined ? { profileId: defaults.profileId } : {}),
      ...(defaults.cwd !== undefined ? { cwd: defaults.cwd } : {}),
      ...(defaults.gitIdentity !== undefined ? { gitIdentity: { ...defaults.gitIdentity } } : {}),
    },
    aiEnabled: source.aiEnabled,
    saveScrollback: source.saveScrollback,
    pinned: source.pinned.map(idOf),
    tree: source.tree.map((node) => buildNode(node, idOf)),
    items,
    ...(source.activeItemId !== undefined ? { activeItemId: idOf(source.activeItemId) } : {}),
  };
}

export type SpaceFromFile = { ok: true; space: Space } | { ok: false; error: string };

/**
 * The space a file describes, as a new space: it is checked again (`validateSpaceFile`, with
 * `maxPanes`), then the space, its items, groups and panes each get an id from `newId` (the same
 * file id always gets the same new id, so the references between them hold), every tab is dated
 * `now` and every pane starts idle with no session. This is what the `space/import` action does;
 * the profiles of the file are not here (`planProfiles`). Never throws.
 */
export function spaceFromFile(
  file: SpaceFile,
  newId: () => Id,
  now: number,
  maxPanes: number = DEFAULT_MAX_PANES,
): SpaceFromFile {
  try {
    const checked = validateSpaceFile(file, maxPanes);
    if (!checked.ok) return checked;
    const fresh = new Map<Id, Id>();
    const idOf = (id: Id): Id => {
      let made = fresh.get(id);
      if (made === undefined) {
        made = newId();
        fresh.set(id, made);
      }
      return made;
    };
    const spaceId = newId();
    return { ok: true, space: buildSpace(checked.file, spaceId, idOf, now) };
  } catch {
    return refuse("the space could not be made from the file");
  }
}

// ---------------------------------------------------------------------------------------------
// The profiles of a file

export interface ProfileConflict {
  id: string;
  name: string;
  /**
   * `different`: the profile of that id you have is not the one in the file. `taken`: the id is
   * one of the shells of this machine, so a profile cannot have it.
   */
  reason: "different" | "taken";
}

export interface ProfilePlan {
  /** Profiles of the file to add to the settings: no profile of yours has their id. */
  add: UserProfile[];
  /** Ids of profiles you already have that are the same as the one in the file. */
  reused: string[];
  /** Profiles of the file that cannot be added; the space keeps using the profile of that id. */
  conflicts: ProfileConflict[];
}

/**
 * What to do with the profiles of a file given the profiles the user has (`existing`) and the ids
 * of the shells of the machine (`takenIds`). A profile you have with the same id and the same
 * content is reused, a different one is a conflict, and nothing of yours is ever replaced. The
 * profiles in the file come without anything that looks like a secret, so a profile of yours is
 * compared without it too.
 */
export function planProfiles(
  file: SpaceFile,
  existing: readonly UserProfile[],
  takenIds: Iterable<string> = [],
): ProfilePlan {
  const taken = new Set(takenIds);
  const plan: ProfilePlan = { add: [], reused: [], conflicts: [] };
  for (const profile of file.profiles) {
    const mine = existing.find((entry) => entry.id === profile.id);
    if (mine !== undefined) {
      if (sameProfile(mine, profile)) plan.reused.push(profile.id);
      else plan.conflicts.push({ id: profile.id, name: profile.name, reason: "different" });
    } else if (taken.has(profile.id)) {
      plan.conflicts.push({ id: profile.id, name: profile.name, reason: "taken" });
    } else {
      plan.add.push(profile);
    }
  }
  return plan;
}

function sameProfile(a: UserProfile, b: UserProfile): boolean {
  return stable({ ...a, kind: a.kind ?? "shell" }) === stable({ ...b, kind: b.kind ?? "shell" });
}

/** JSON with the keys of every object in order, so two equal values give the same text. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

// ---------------------------------------------------------------------------------------------
// Secrets

/** A name that says the value is a secret: a token, a password, a key, a credential. */
const SECRET_NAME = /token|secret|passw|api[-_]?key|access[-_]?key|private[-_]?key|credential/i;

/** Whether an environment variable must stay out of a file: by its name, or by what its value is. */
export function looksSecret(name: string, value: string): boolean {
  return (
    SECRET_NAME.test(name) ||
    redactSecrets(value).count > 0 ||
    redactSecrets(`${name}=${value}`).count > 0
  );
}

/** The variables that may go in a file, and the names of the ones that may not. */
export function withoutSecretEnv(env: Readonly<Record<string, string>>): {
  env: Record<string, string>;
  removed: string[];
} {
  const kept: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (looksSecret(name, value)) removed.push(name);
    else kept[name] = value;
  }
  return { env: kept, removed };
}

/** Whether a profile has text that looks like a secret in what it runs (the program or an argument). */
function profileHoldsSecret(profile: UserProfile): boolean {
  const parts = [...(profile.kind === "ssh" ? [] : [profile.program]), ...(profile.args ?? [])];
  return [...parts, parts.join(" ")].some((part) => redactSecrets(part).count > 0);
}

// ---------------------------------------------------------------------------------------------
// Exporting a space

export interface ExportSpaceOptions {
  /**
   * The profiles of the user. Those the space uses (as its default, in a pane or in an origin) go
   * in the file; a profile that is not here (a shell of the machine) is only named by its id.
   */
  profiles?: readonly UserProfile[];
}

/** What `exportSpace` left out because it looked like a secret. */
export interface ExportRemovals {
  /** Names of the environment variables of the space. */
  env: string[];
  /** Ids (in the file) of the tabs whose origin lost the command it returns to. */
  commands: string[];
  /** Ids of the profiles that were not put in the file. */
  profiles: string[];
}

export type SpaceExport =
  | {
      ok: true;
      file: SpaceFile;
      /** The text to write: the file as JSON, two-space indent, a newline at the end. */
      text: string;
      removed: ExportRemovals;
    }
  | { ok: false; error: string };

class ExportProblem extends Error {}

/**
 * The file of a space. Nothing that looks like a secret goes in it: a variable of the environment
 * whose name says token, secret, password, API key and the like, or whose value `redactSecrets`
 * would change, is left out and named in `removed`; so is the command an origin returns to, and a
 * profile whose program or arguments hold one, when they look like a secret. A page address that
 * holds a secret makes the export fail, since a page cannot be left out of its tab. The result is
 * checked as `validateSpaceFile` would check it, so what this returns can be imported.
 */
export function exportSpace(space: Space, options: ExportSpaceOptions = {}): SpaceExport {
  try {
    return exportChecked(space, options);
  } catch (error) {
    return refuse(
      error instanceof ExportProblem ? error.message : "the space could not be exported",
    );
  }
}

function exportChecked(space: Space, options: ExportSpaceOptions): SpaceExport {
  const removed: ExportRemovals = { env: [], commands: [], profiles: [] };
  let items = 0;
  let groups = 0;
  let panes = 0;
  const fileIds = new Map<Id, string>();
  const exported: SpaceFileItem[] = [];
  const usedProfiles = new Set<string>();
  const useProfile = (id: string | undefined): void => {
    if (id !== undefined) usedProfiles.add(id);
  };

  const exportLayout = (node: LayoutNode): z.infer<typeof layoutSchema> => {
    if (node.kind === "split") {
      return {
        kind: "split",
        dir: node.dir,
        sizes: [...node.sizes],
        children: node.children.map(exportLayout),
      };
    }
    const pane = node.pane;
    const id = `p${++panes}`;
    fileIds.set(pane.id, id);
    useProfile(pane.profileId);
    if (pane.url !== undefined && redactSecrets(pane.url).count > 0) {
      throw new ExportProblem("a page address holds a secret; close that page or take it out");
    }
    return {
      kind: "pane",
      pane: {
        id,
        type: pane.type,
        profileId: pane.profileId,
        ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
        ...(pane.url !== undefined ? { url: pane.url } : {}),
        ...(pane.path !== undefined ? { path: pane.path } : {}),
      },
    };
  };

  const exportItem = (itemId: Id): string => {
    const item = Object.hasOwn(space.items, itemId) ? space.items[itemId] : undefined;
    if (item === undefined) throw new ExportProblem(`the item ${itemId} is not in the space`);
    if (fileIds.has(item.id)) throw new ExportProblem(`the item ${itemId} is placed twice`);
    const id = `i${++items}`;
    fileIds.set(item.id, id);
    const layout = exportLayout(item.layout);
    const origin = item.origin;
    let origined: SpaceFileItem["origin"];
    if (origin !== undefined) {
      useProfile(origin.profileId);
      const secret = origin.command !== undefined && redactSecrets(origin.command).count > 0;
      if (secret) removed.commands.push(id);
      origined = {
        cwd: origin.cwd,
        profileId: origin.profileId,
        ...(origin.command !== undefined && !secret ? { command: origin.command } : {}),
      };
    }
    const focused = fileIds.get(item.focusedPaneId);
    if (focused === undefined) {
      throw new ExportProblem(`the focused pane of item ${itemId} is not in the item`);
    }
    exported.push({
      id,
      ...(item.titleLocked && item.title !== undefined && item.title !== ""
        ? { title: item.title }
        : {}),
      focusedPaneId: focused,
      ...(origined !== undefined ? { origin: origined } : {}),
      ...(item.liveKey !== undefined ? { liveKey: item.liveKey } : {}),
      layout,
    });
    return id;
  };

  const exportNode = (node: Node): z.infer<typeof nodeSchema> => {
    if (node.kind === "item") return { kind: "item", id: exportItem(node.id) };
    const id = `g${++groups}`;
    return {
      kind: "group",
      id,
      name: node.name,
      color: node.color,
      collapsed: node.collapsed,
      ...(node.live !== undefined ? { live: { ...node.live } } : {}),
      children: node.children.map(exportNode),
    };
  };

  const pinned = space.pinned.map(exportItem);
  const tree = space.tree.map(exportNode);

  const defaults = space.defaults;
  useProfile(defaults.profileId);
  const stripped = withoutSecretEnv(defaults.env);
  removed.env.push(...stripped.removed);

  const profiles: UserProfile[] = [];
  for (const profile of options.profiles ?? []) {
    if (!usedProfiles.has(profile.id)) continue;
    if (profileHoldsSecret(profile)) removed.profiles.push(profile.id);
    else profiles.push(profile);
  }

  const activeItemId =
    space.activeItemId === undefined ? undefined : fileIds.get(space.activeItemId);
  const file: SpaceFile = {
    format: SPACE_FILE_FORMAT,
    version: SPACE_FILE_VERSION,
    space: {
      name: space.name,
      icon: space.icon,
      color: space.color,
      ...(space.themeId !== undefined ? { themeId: space.themeId } : {}),
      modIds: space.modIds.filter(isValidModFileName),
      aiEnabled: space.aiEnabled,
      saveScrollback: space.saveScrollback,
      defaults: {
        ...(defaults.profileId !== undefined ? { profileId: defaults.profileId } : {}),
        ...(defaults.cwd !== undefined ? { cwd: defaults.cwd } : {}),
        env: stripped.env,
        ...(defaults.gitIdentity !== undefined ? { gitIdentity: { ...defaults.gitIdentity } } : {}),
      },
      pinned,
      tree,
      items: exported,
      ...(activeItemId !== undefined ? { activeItemId } : {}),
    },
    profiles,
  };

  const checked = validateSpaceFile(file, Number.POSITIVE_INFINITY);
  if (!checked.ok) return checked;
  return {
    ok: true,
    file: checked.file,
    text: `${JSON.stringify(checked.file, null, 2)}\n`,
    removed,
  };
}
