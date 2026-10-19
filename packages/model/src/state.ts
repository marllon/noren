import { DEFAULT_SPACE_COLOR, DEFAULT_SPACE_ICON } from "./factories";
import { checkInvariants } from "./invariants";
import type { InvariantOptions } from "./invariants";
import { withoutSessions } from "./sessions";
import type { Workspace } from "./types";

/** Version written to `state.json` today. Bump it together with a new entry in `MIGRATIONS`. */
export const STATE_VERSION = 2;

/** Turns the parsed content of version N into the content of version N + 1. May throw. */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations by the version they start from. A file of version N goes through `MIGRATIONS[N]`,
 * `MIGRATIONS[N + 1]`, ... until it reaches `STATE_VERSION`. Each one must set `version`.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  0: migrateV0ToV1,
  1: migrateV1ToV2,
};

/**
 * Example migration. Version 0 named the active space `activeSpace`, had no favorites, closed or
 * archived lists, and its spaces had no icon, color, defaults, mods, AI or scrollback settings.
 */
function migrateV0ToV1(data: Record<string, unknown>): Record<string, unknown> {
  const { activeSpace, spaces, ...rest } = data;
  return {
    ...rest,
    version: 1,
    activeSpaceId: activeSpace,
    favorites: [],
    closed: [],
    archive: [],
    spaces: Array.isArray(spaces)
      ? spaces.map((space: unknown) =>
          isRecord(space)
            ? {
                icon: DEFAULT_SPACE_ICON,
                color: DEFAULT_SPACE_COLOR,
                modIds: [],
                defaults: { env: {} },
                aiEnabled: true,
                saveScrollback: true,
                ...space,
              }
            : space,
        )
      : spaces,
  };
}

/**
 * Version 1 kept no active item per space (the interface held it outside `state.json`). Each space
 * with items gets its first one in sidebar order, pinned first, then the tree depth-first, which is
 * what the interface showed when nothing was chosen. An empty space stays without one.
 */
function migrateV1ToV2(data: Record<string, unknown>): Record<string, unknown> {
  const { spaces, ...rest } = data;
  return {
    ...rest,
    version: 2,
    spaces: Array.isArray(spaces)
      ? spaces.map((space: unknown) => {
          if (!isRecord(space) || "activeItemId" in space) return space;
          const first = firstItemId(space);
          return first === undefined ? space : { ...space, activeItemId: first };
        })
      : spaces,
  };
}

/** The first item of a version 1 space in sidebar order that exists in `items`. */
function firstItemId(space: Obj): string | undefined {
  const items = space["items"];
  if (!isRecord(items)) return undefined;
  const exists = (id: unknown): id is string => typeof id === "string" && Object.hasOwn(items, id);
  const pinned = Array.isArray(space["pinned"]) ? space["pinned"].find(exists) : undefined;
  if (typeof pinned === "string") return pinned;
  return firstInTree(space["tree"], exists, 0);
}

function firstInTree(
  nodes: unknown,
  exists: (id: unknown) => id is string,
  depth: number,
): string | undefined {
  if (!Array.isArray(nodes) || depth > MAX_WALK_DEPTH) return undefined;
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const found =
      node["kind"] === "item"
        ? exists(node["id"])
          ? node["id"]
          : undefined
        : firstInTree(node["children"], exists, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export type ParseStateResult =
  /** `migratedFrom` is the version found in the file when it was older than `STATE_VERSION`. */
  { ok: true; workspace: Workspace; migratedFrom?: number } | { ok: false; reason: string };

/** A copy of the workspace without sessions: they belong to the running process and die with it. */
export function workspaceWithoutSessions(ws: Workspace): Workspace {
  return {
    ...ws,
    spaces: ws.spaces.map((space) => ({
      ...space,
      items: Object.fromEntries(
        Object.entries(space.items).map(([id, item]) => [id, withoutSessions(item)]),
      ),
    })),
    closed: ws.closed.map((entry) => ({ ...entry, item: withoutSessions(entry.item) })),
    archive: ws.archive.map((entry) => ({ ...entry, item: withoutSessions(entry.item) })),
  };
}

/** The text of `state.json` for the workspace, sessions left out. */
export function serializeWorkspace(ws: Workspace): string {
  return JSON.stringify(workspaceWithoutSessions(ws));
}

/**
 * Reads the text of `state.json`: JSON, version and migrations, shape, then `checkInvariants`.
 * Never throws; anything unusable (including a version from the future) is `{ ok: false }`.
 */
export function parseState(text: string, options: InvariantOptions = {}): ParseStateResult {
  try {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return fail(`not valid JSON: ${message(error)}`);
    }
    if (!isRecord(data)) return fail("the content is not an object");
    const found = data["version"];
    if (typeof found !== "number" || !Number.isInteger(found) || found < 0) {
      return fail("version is missing or not a whole number");
    }
    if (found > STATE_VERSION) {
      return fail(`version ${found} is newer than the supported version ${STATE_VERSION}`);
    }
    let current: Record<string, unknown> = data;
    for (let version = found; version < STATE_VERSION; version++) {
      const migrate = MIGRATIONS[version];
      if (!migrate) return fail(`no migration from version ${version}`);
      current = migrate(current);
      if (current["version"] !== version + 1) {
        return fail(`migration from version ${version} did not produce version ${version + 1}`);
      }
    }
    const workspace = checkShape(current);
    const violations = checkInvariants(workspace, options);
    if (violations.length > 0) {
      const shown = violations.slice(0, 3).map((v) => `${v.code} at ${v.path || "(root)"}`);
      const more =
        violations.length > shown.length ? ` (+${violations.length - shown.length})` : "";
      return fail(`invariants broken: ${shown.join("; ")}${more}`);
    }
    return { ok: true, workspace, ...(found < STATE_VERSION ? { migratedFrom: found } : {}) };
  } catch (error) {
    return fail(message(error));
  }
}

function fail(reason: string): ParseStateResult {
  return { ok: false, reason };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Shape check. It only proves the content can be read as a `Workspace` (right types in the right
// places) so `checkInvariants` and the rest of the app never trip over it; structure rules such as
// ids, split sizes and group depth stay in `checkInvariants`.

type Obj = Record<string, unknown>;

/** Deepest nesting walked before giving up, a guard against a stack overflow on hostile input. */
const MAX_WALK_DEPTH = 32;

class ShapeError extends Error {
  constructor(path: string, expected: string) {
    super(`${path || "(root)"}: expected ${expected}`);
  }
}

function isRecord(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown, path: string): Obj {
  if (!isRecord(value)) throw new ShapeError(path, "an object");
  return value;
}

function str(value: unknown, path: string): void {
  if (typeof value !== "string") throw new ShapeError(path, "a string");
}

function bool(value: unknown, path: string): void {
  if (typeof value !== "boolean") throw new ShapeError(path, "a boolean");
}

function num(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ShapeError(path, "a finite number");
  }
}

function list(value: unknown, path: string, each: (item: unknown, path: string) => void): void {
  if (!Array.isArray(value)) throw new ShapeError(path, "an array");
  value.forEach((item: unknown, index) => each(item, `${path}[${index}]`));
}

/** Checks `record[key]` only when the key is present (a JSON file never holds `undefined`). */
function optional(record: Obj, key: string, path: string, check: (v: unknown, p: string) => void) {
  if (key in record) check(record[key], `${path}.${key}`);
}

function checkShape(data: Obj): Workspace {
  str(data["activeSpaceId"], "activeSpaceId");
  list(data["spaces"], "spaces", checkSpace);
  list(data["favorites"], "favorites", str);
  list(data["closed"], "closed", (v, p) => checkEntry(v, p, "closedAt"));
  list(data["archive"], "archive", (v, p) => checkEntry(v, p, "archivedAt"));
  return data as unknown as Workspace;
}

function checkSpace(value: unknown, path: string): void {
  const space = obj(value, path);
  for (const key of ["id", "name", "icon", "color"]) str(space[key], `${path}.${key}`);
  optional(space, "themeId", path, str);
  optional(space, "background", path, (v, p) => {
    const background = obj(v, p);
    str(background["image"], `${p}.image`);
    optional(background, "opacity", p, num);
    optional(background, "blur", p, num);
  });
  list(space["modIds"], `${path}.modIds`, str);
  bool(space["aiEnabled"], `${path}.aiEnabled`);
  bool(space["saveScrollback"], `${path}.saveScrollback`);
  list(space["pinned"], `${path}.pinned`, str);
  optional(space, "activeItemId", path, str);

  const defaultsPath = `${path}.defaults`;
  const defaults = obj(space["defaults"], defaultsPath);
  optional(defaults, "profileId", defaultsPath, str);
  optional(defaults, "cwd", defaultsPath, str);
  const env = obj(defaults["env"], `${defaultsPath}.env`);
  for (const [name, entry] of Object.entries(env)) str(entry, `${defaultsPath}.env.${name}`);
  optional(defaults, "gitIdentity", defaultsPath, (v, p) => {
    const identity = obj(v, p);
    str(identity["name"], `${p}.name`);
    str(identity["email"], `${p}.email`);
  });

  list(space["tree"], `${path}.tree`, (v, p) => checkNode(v, p, 0));
  const items = obj(space["items"], `${path}.items`);
  for (const [id, item] of Object.entries(items)) checkItem(item, `${path}.items.${id}`);
}

function checkNode(value: unknown, path: string, depth: number): void {
  if (depth > MAX_WALK_DEPTH) throw new ShapeError(path, "groups nested less deeply");
  const node = obj(value, path);
  str(node["id"], `${path}.id`);
  if (node["kind"] === "item") return;
  if (node["kind"] !== "group") throw new ShapeError(`${path}.kind`, '"item" or "group"');
  str(node["name"], `${path}.name`);
  str(node["color"], `${path}.color`);
  bool(node["collapsed"], `${path}.collapsed`);
  list(node["children"], `${path}.children`, (v, p) => checkNode(v, p, depth + 1));
}

function checkEntry(value: unknown, path: string, timeKey: string): void {
  const entry = obj(value, path);
  checkItem(entry["item"], `${path}.item`);
  str(entry["spaceId"], `${path}.spaceId`);
  num(entry[timeKey], `${path}.${timeKey}`);
}

function checkItem(value: unknown, path: string): void {
  const item = obj(value, path);
  str(item["id"], `${path}.id`);
  optional(item, "title", path, str);
  bool(item["titleLocked"], `${path}.titleLocked`);
  checkLayout(item["layout"], `${path}.layout`, 0);
  str(item["focusedPaneId"], `${path}.focusedPaneId`);
  optional(item, "zoomedPaneId", path, str);
  optional(item, "origin", path, (v, p) => {
    const origin = obj(v, p);
    str(origin["cwd"], `${p}.cwd`);
    str(origin["profileId"], `${p}.profileId`);
    optional(origin, "command", p, str);
  });
  num(item["lastActivityAt"], `${path}.lastActivityAt`);
}

function checkLayout(value: unknown, path: string, depth: number): void {
  if (depth > MAX_WALK_DEPTH) throw new ShapeError(path, "a layout nested less deeply");
  const node = obj(value, path);
  if (node["kind"] === "pane") {
    checkPane(node["pane"], `${path}.pane`);
    return;
  }
  if (node["kind"] !== "split") throw new ShapeError(`${path}.kind`, '"pane" or "split"');
  if (node["dir"] !== "row" && node["dir"] !== "column") {
    throw new ShapeError(`${path}.dir`, '"row" or "column"');
  }
  list(node["sizes"], `${path}.sizes`, num);
  list(node["children"], `${path}.children`, (v, p) => checkLayout(v, p, depth + 1));
}

function checkPane(value: unknown, path: string): void {
  const pane = obj(value, path);
  str(pane["id"], `${path}.id`);
  if (pane["type"] !== "terminal") throw new ShapeError(`${path}.type`, '"terminal"');
  optional(pane, "sessionId", path, str);
  str(pane["profileId"], `${path}.profileId`);
  optional(pane, "cwd", path, str);
  optional(pane, "gitBranch", path, str);
  const status = pane["status"];
  if (status !== "running" && status !== "idle" && status !== "exited") {
    throw new ShapeError(`${path}.status`, '"running", "idle" or "exited"');
  }
  optional(pane, "exitCode", path, num);
  optional(pane, "runningCommand", path, (v, p) => {
    optional(obj(v, p), "text", p, str);
  });
  optional(pane, "lastCommand", path, (v, p) => {
    const last = obj(v, p);
    optional(last, "text", p, str);
    optional(last, "exitCode", p, num);
    optional(last, "durationMs", p, num);
  });
  bool(pane["unread"], `${path}.unread`);
  bool(pane["bell"], `${path}.bell`);
  optional(pane, "unreadAt", path, num);
  optional(pane, "scrollbackRef", path, str);
}
