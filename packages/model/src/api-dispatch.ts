import type { Action } from "./actions";
import { keySequences } from "./api-keys";
import type { Backend, CreateSessionOptions, SessionId } from "./backend";
import { DEFAULT_PROFILE_ID } from "./factories";
import { layoutPanes } from "./sessions";
import { spaceSessionEnv } from "./session-env";
import { spaceItemIds } from "./tree";
import type { Id, Item, Pane, Space, Workspace } from "./types";
import { DEFAULT_MAX_PANES } from "./types";
import { encodeUtf8 } from "./utf8";

// What a call of the local API does to the workspace (NOR-F17-01b). The server in `noren-core`
// (`crates/noren-core/src/api/`, NOR-F17-01a) checks a request and hands the app an `ApiCall`; this
// turns that call into reducer actions and `Backend` calls and gives back the answer. `ApiCall` is
// the request as it travels (`{ method, params }`, the names and limits of `api/protocol.rs`), and
// a test holds the two to each other. No DOM, no Tauri, no wall-clock time, no randomness: the
// workspace, the `Backend` and the reader of the output come in through `ApiHost`, and nothing
// here throws.
//
// The call is checked again here (`parseApiCall`) because it crosses from Rust to the page as JSON
// and the page is not obliged to trust it; a call the server would have refused gets the same
// error code it would have.
//
// D8: a call sends what it carries and nothing else. Text is written as given, a key is the bytes
// of its name, and no Enter is ever added; a command runs only if the caller wrote the line end.

/** The limits of `api/protocol.rs`, in the same units (characters, or bytes where it says so). */
export const API_LIMITS = {
  /** Longest id of a space, an item, a split or a terminal, in characters. */
  idChars: 128,
  /** Longest name of a space, in characters. */
  nameChars: 120,
  /** Longest folder or profile text, in characters. */
  pathChars: 4096,
  /** Longest text one `terminal.send` writes, in bytes. */
  sendTextBytes: 64 * 1024,
  /** Most keys one `terminal.send` presses. */
  sendKeys: 64,
  /** Longest key name, in characters. */
  keyChars: 32,
  /** Most lines one `terminal.read` asks for. */
  readLines: 10_000,
  /** Longest title of a `notify`, in characters. */
  notifyTitleChars: 128,
  /** Longest body of a `notify`, in characters. */
  notifyBodyChars: 1024,
} as const;

/** Lines `terminal.read` answers with when `lines` is left out. */
export const API_DEFAULT_READ_LINES = 100;
/** Most text, in bytes of UTF-8, one `terminal.read` answers with (the oldest lines go first). */
export const API_MAX_READ_BYTES = 1024 * 1024;
/** The size a shell starts at when the API makes it, until its view measures the real one. */
export const API_DEFAULT_SIZE = { cols: 80, rows: 24 } as const;

/** The methods of the API: the closed list of `ApiMethod` in `api/protocol.rs`. */
export const API_METHODS = [
  "spaces.list",
  "spaces.create",
  "items.create",
  "splits.create",
  "terminal.send",
  "terminal.read",
  "notify",
] as const;
export type ApiMethodName = (typeof API_METHODS)[number];

/** The reasons of an error answer: `ApiErrorCode` of `api/protocol.rs`, by its text. */
export const API_ERROR_CODES = [
  "invalid_json",
  "invalid_request",
  "unknown_method",
  "invalid_params",
  "frame_too_large",
  "unauthenticated",
  "unauthorized",
  "unsupported_version",
  "timeout",
  "shutting_down",
  "internal",
  "not_found",
  "failed",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  code: ApiErrorCode;
  /** A sentence for a person. */
  message: string;
}

/** The answer to a call: the result, or the error. Never both. */
export type ApiOutcome = { result: ApiJson } | { error: ApiError };

/** What an answer is made of. */
export type ApiJson = null | boolean | number | string | ApiJson[] | { [key: string]: ApiJson };

/** A call that passed the checks of the server: `ApiCall` of `api/protocol.rs`, as JSON. */
export type ApiCall =
  | { method: "spaces.list"; params: Record<string, never> }
  | { method: "spaces.create"; params: { name: string } }
  | { method: "items.create"; params: { space: string; cwd?: string; profile?: string } }
  | {
      method: "splits.create";
      params: { item: string; direction: "right" | "down"; cwd?: string; profile?: string };
    }
  | { method: "terminal.send"; params: { terminal: string; text?: string; keys?: string[] } }
  | { method: "terminal.read"; params: { terminal: string; lines?: number } }
  | { method: "notify"; params: { title: string; body?: string; terminal?: string } };

/** What a `notify` asks the host to show. */
export interface ApiNotification {
  title: string;
  body?: string;
  /** The pane the notification is about, when the call named one (it exists and is a terminal). */
  paneId?: Id;
}

/** What the dispatcher needs from the app. */
export interface ApiHost {
  /** The workspace as it is now. */
  workspace(): Workspace;
  /**
   * Runs the action through the reducer and stores the result (the app's `dispatch`). Called and
   * done within one tick: `workspace()` shows the change right after.
   */
  dispatch(action: Action): void;
  /**
   * Records the session a shell started for a pane (the app's `attachSession`), so the view of the
   * pane takes that shell instead of starting one.
   */
  attachSession(paneId: Id, sessionId: Id): void;
  /** The shells. */
  readonly backend: Pick<Backend, "createSession" | "write" | "kill">;
  /**
   * The last `count` lines the session printed, as plain text, oldest first (see `TerminalTail`).
   * The reader is the app's: the dispatcher never subscribes to the output.
   */
  readLines(sessionId: SessionId, count: number): readonly string[] | Promise<readonly string[]>;
  /** The size a shell the API starts begins with; `API_DEFAULT_SIZE` when left out. */
  readonly size?: { cols: number; rows: number };
  /** Most panes one tab may hold; `DEFAULT_MAX_PANES` when left out. */
  readonly maxPanes?: number;
  /**
   * Shows a notification of the system, if the user's settings allow it, and tells whether one was
   * shown (the app's `SystemNotifier`). Never rejects. Without it, `notify` answers `shown: false`.
   */
  notify?(notification: ApiNotification): boolean | Promise<boolean>;
}

type Parsed = { ok: true; call: ApiCall } | { ok: false; error: ApiError };

const failure = (code: ApiErrorCode, message: string): { error: ApiError } => ({
  error: { code, message },
});

/** A text from the client, cut and made single line so it can sit in a message. */
function shorten(text: string): string {
  const LIMIT = 40;
  const chars = [...text];
  const out = chars
    .slice(0, LIMIT)
    .map((c) => (/\p{Cc}/u.test(c) ? "?" : c))
    .join("");
  return `"${out}${chars.length > LIMIT ? "..." : ""}"`;
}

class ParamsProblem extends Error {}

/** The parameters of a call, taken out one by one so `finish` can tell what is left over. */
class Fields {
  readonly #map = new Map<string, unknown>();

  constructor(params: unknown) {
    if (params === undefined || params === null) return;
    if (typeof params !== "object" || Array.isArray(params)) {
      throw new ParamsProblem('"params" must be an object');
    }
    for (const [key, value] of Object.entries(params)) this.#map.set(key, value);
  }

  #take(key: string): unknown {
    const value = this.#map.get(key);
    this.#map.delete(key);
    return value ?? undefined;
  }

  /** `line`: one line, counted in characters. `any`: anything, counted in bytes. */
  text(key: string, max: number, rule: "line" | "any", required: true): string;
  text(key: string, max: number, rule: "line" | "any", required: false): string | undefined;
  text(key: string, max: number, rule: "line" | "any", required: boolean): string | undefined {
    const value = this.#take(key);
    if (value === undefined) {
      if (required) throw new ParamsProblem(`"${key}" is required`);
      return undefined;
    }
    if (typeof value !== "string") throw new ParamsProblem(`"${key}" must be text`);
    if (rule === "any") {
      if (encodeUtf8(value).length > max) {
        throw new ParamsProblem(`"${key}" is longer than ${max} bytes`);
      }
      return value;
    }
    if (value === "") throw new ParamsProblem(`"${key}" must not be empty`);
    if ([...value].length > max)
      throw new ParamsProblem(`"${key}" is longer than ${max} characters`);
    if (/\p{Cc}/u.test(value)) throw new ParamsProblem(`"${key}" must not have control characters`);
    return value;
  }

  count(key: string, min: number, max: number): number | undefined {
    const value = this.#take(key);
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new ParamsProblem(`"${key}" must be a whole number from ${min} to ${max}`);
    }
    return value;
  }

  keys(key: string): string[] | undefined {
    const value = this.#take(key);
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new ParamsProblem(`"${key}" must be a list`);
    if (value.length > API_LIMITS.sendKeys) {
      throw new ParamsProblem(`"${key}" has more than ${API_LIMITS.sendKeys} keys`);
    }
    return value.map((name: unknown) => {
      if (
        typeof name !== "string" ||
        name === "" ||
        name.length > API_LIMITS.keyChars ||
        !/^[A-Za-z0-9+_-]+$/.test(name)
      ) {
        throw new ParamsProblem(
          `"${key}" holds key names of up to ${API_LIMITS.keyChars} letters, digits, '+', '-' or '_'`,
        );
      }
      return name;
    });
  }

  finish(): void {
    const [extra] = this.#map.keys();
    if (extra !== undefined) throw new ParamsProblem(`unknown parameter ${shorten(extra)}`);
  }
}

/**
 * Checks a call the way `parse_call` of `api/protocol.rs` does: a method of the list, parameters
 * that fit it, nothing extra. Never throws; a call that does not fit is an `invalid_request`,
 * `unknown_method` or `invalid_params` error.
 */
export function parseApiCall(value: unknown): Parsed {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, ...failure("invalid_request", "the call must be an object") };
  }
  const { method, params, ...rest } = value as Record<string, unknown>;
  const [extra] = Object.keys(rest);
  if (extra !== undefined) {
    return { ok: false, ...failure("invalid_request", `unknown field ${shorten(extra)}`) };
  }
  if (typeof method !== "string") {
    return { ok: false, ...failure("invalid_request", '"method" must be text') };
  }
  if (!(API_METHODS as readonly string[]).includes(method)) {
    return { ok: false, ...failure("unknown_method", `unknown method ${shorten(method)}`) };
  }
  try {
    const fields = new Fields(params);
    const call = readParams(method as ApiMethodName, fields);
    fields.finish();
    return { ok: true, call };
  } catch (e) {
    if (e instanceof ParamsProblem) return { ok: false, ...failure("invalid_params", e.message) };
    return { ok: false, ...failure("internal", `the call broke: ${reasonOf(e)}`) };
  }
}

/** The object without the fields that are `undefined` (the call carries only what it was given). */
type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

const some = <T extends object>(object: T): Compact<T> =>
  Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined)) as Compact<T>;

function readParams(method: ApiMethodName, fields: Fields): ApiCall {
  const {
    idChars,
    nameChars,
    pathChars,
    sendTextBytes,
    readLines,
    notifyTitleChars,
    notifyBodyChars,
  } = API_LIMITS;
  switch (method) {
    case "spaces.list":
      return { method, params: {} };
    case "spaces.create": {
      const name = fields.text("name", nameChars, "line", true);
      if (name.trim() === "") throw new ParamsProblem('"name" must not be blank');
      return { method, params: { name } };
    }
    case "items.create":
      return {
        method,
        params: some({
          space: fields.text("space", idChars, "line", true),
          cwd: fields.text("cwd", pathChars, "line", false),
          profile: fields.text("profile", idChars, "line", false),
        }),
      };
    case "splits.create": {
      const item = fields.text("item", idChars, "line", true);
      const named = fields.text("direction", 8, "line", true);
      if (named !== "right" && named !== "down") {
        throw new ParamsProblem('"direction" must be "right" or "down"');
      }
      const direction: "right" | "down" = named;
      return {
        method,
        params: some({
          item,
          direction,
          cwd: fields.text("cwd", pathChars, "line", false),
          profile: fields.text("profile", idChars, "line", false),
        }),
      };
    }
    case "terminal.send": {
      const terminal = fields.text("terminal", idChars, "line", true);
      const text = fields.text("text", sendTextBytes, "any", false);
      const keys = fields.keys("keys");
      if ((text === undefined || text === "") && (keys === undefined || keys.length === 0)) {
        throw new ParamsProblem('send "text", "keys" or both');
      }
      return { method, params: some({ terminal, text, keys }) };
    }
    case "terminal.read":
      return {
        method,
        params: some({
          terminal: fields.text("terminal", idChars, "line", true),
          lines: fields.count("lines", 1, readLines),
        }),
      };
    case "notify": {
      const title = fields.text("title", notifyTitleChars, "line", true);
      if (title.trim() === "") throw new ParamsProblem('"title" must not be blank');
      return {
        method,
        params: some({
          title,
          body: fields.text("body", notifyBodyChars, "line", false),
          terminal: fields.text("terminal", idChars, "line", false),
        }),
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The workspace

function findItem(ws: Workspace, itemId: Id): { space: Space; item: Item } | undefined {
  for (const space of ws.spaces) {
    if (Object.hasOwn(space.items, itemId)) {
      const item = space.items[itemId];
      if (item !== undefined) return { space, item };
    }
  }
  return undefined;
}

function findPane(ws: Workspace, paneId: Id): { space: Space; item: Item; pane: Pane } | undefined {
  for (const space of ws.spaces) {
    for (const item of Object.values(space.items)) {
      const pane = layoutPanes(item.layout).find((p) => p.id === paneId);
      if (pane !== undefined) return { space, item, pane };
    }
  }
  return undefined;
}

const itemIdsOf = (ws: Workspace): Set<Id> =>
  new Set(ws.spaces.flatMap((space) => Object.keys(space.items)));

const paneIdsOf = (item: Item | undefined): Set<Id> =>
  new Set(item === undefined ? [] : layoutPanes(item.layout).map((p) => p.id));

/** The session number of a terminal pane, when it holds one. */
function sessionOf(pane: Pane): SessionId | undefined {
  if (pane.type !== "terminal" || pane.sessionId === undefined) return undefined;
  const id = Number(pane.sessionId);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** The reason an error carries, or a stand-in, as one short line. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.replace(/\p{Cc}+/gu, " ").trim();
  return line.length > 200 ? `${line.slice(0, 200)}...` : line === "" ? "no reason given" : line;
}

function listSpaces(ws: Workspace): ApiOutcome {
  return {
    result: {
      spaces: ws.spaces.map((space) => ({
        id: space.id,
        name: space.name,
        active: space.id === ws.activeSpaceId,
        items: spaceItemIds(space).flatMap((itemId) => {
          const item = space.items[itemId];
          if (item === undefined) return [];
          return [
            {
              id: item.id,
              ...(item.title !== undefined ? { title: item.title } : {}),
              pinned: space.pinned.includes(item.id),
              active: space.activeItemId === item.id,
              focused: item.focusedPaneId,
              panes: layoutPanes(item.layout).map((pane) => ({
                id: pane.id,
                type: pane.type,
                status: pane.status,
                profile: pane.profileId,
                ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
                session: pane.sessionId ?? null,
              })),
            },
          ];
        }),
      })),
    },
  };
}

function createSpace(host: ApiHost, name: string): ApiOutcome {
  const before = host.workspace();
  // The space does not take the view from the person: it is made, not shown.
  host.dispatch({ type: "space/create", name, activate: false });
  const known = new Set(before.spaces.map((s) => s.id));
  const made = host.workspace().spaces.find((s) => !known.has(s.id));
  if (made === undefined) return failure("failed", "the space was not made");
  return { result: { space: made.id, name: made.name } };
}

type Shell = { ok: true; id: SessionId } | { ok: false; error: { error: ApiError } };

async function startShell(
  host: ApiHost,
  space: Space,
  profileId: string,
  cwd: string | undefined,
): Promise<Shell> {
  const env = spaceSessionEnv(space);
  const options: CreateSessionOptions = {
    ...(profileId !== DEFAULT_PROFILE_ID ? { profileId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(host.size ?? API_DEFAULT_SIZE),
  };
  try {
    return { ok: true, id: await host.backend.createSession(options) };
  } catch (e) {
    return { ok: false, error: failure("failed", `the shell did not start: ${reasonOf(e)}`) };
  }
}

/** Ends a shell the API started and the workspace did not take. Its failure is no news. */
async function dropShell(host: ApiHost, id: SessionId): Promise<void> {
  try {
    await host.backend.kill(id);
  } catch {
    // Already gone.
  }
}

async function createItem(
  host: ApiHost,
  params: { space: string; cwd?: string; profile?: string },
): Promise<ApiOutcome> {
  const space = host.workspace().spaces.find((s) => s.id === params.space);
  if (space === undefined)
    return failure("not_found", `no space has the id ${shorten(params.space)}`);
  const profileId = params.profile ?? space.defaults.profileId ?? DEFAULT_PROFILE_ID;
  const shell = await startShell(host, space, profileId, params.cwd ?? space.defaults.cwd);
  if (!shell.ok) return shell.error;
  return holdingShell(host, shell.id, () => placeItem(host, space.id, params, shell.id));
}

/** Runs the step that puts a new shell in the workspace; a step that breaks ends the shell. */
async function holdingShell(
  host: ApiHost,
  id: SessionId,
  step: () => Promise<ApiOutcome>,
): Promise<ApiOutcome> {
  try {
    return await step();
  } catch (e) {
    await dropShell(host, id);
    throw e;
  }
}

async function placeItem(
  host: ApiHost,
  spaceId: Id,
  params: { cwd?: string; profile?: string },
  shellId: SessionId,
): Promise<ApiOutcome> {
  const before = host.workspace();
  host.dispatch({
    type: "item/create",
    spaceId,
    ...(params.profile !== undefined ? { profileId: params.profile } : {}),
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    sessionId: String(shellId),
  });
  const known = itemIdsOf(before);
  const made = host.workspace().spaces.find((s) => s.id === spaceId);
  const item = made && Object.values(made.items).find((i) => !known.has(i.id));
  const pane = item && layoutPanes(item.layout)[0];
  if (item === undefined || pane === undefined) {
    // The space went away while the shell was starting, or the profile was refused.
    await dropShell(host, shellId);
    return failure("failed", "the tab was not made");
  }
  return {
    result: { space: spaceId, item: item.id, terminal: pane.id, session: String(shellId) },
  };
}

async function createSplit(
  host: ApiHost,
  params: { item: string; direction: "right" | "down"; cwd?: string; profile?: string },
): Promise<ApiOutcome> {
  const found = findItem(host.workspace(), params.item);
  if (found === undefined) return failure("not_found", `no tab has the id ${shorten(params.item)}`);
  const { space, item } = found;
  const panes = layoutPanes(item.layout);
  const source = panes.find((p) => p.id === item.focusedPaneId) ?? panes[0];
  if (source === undefined) return failure("failed", "the tab has no pane to split");
  const most = host.maxPanes ?? DEFAULT_MAX_PANES;
  if (panes.length + 1 > most) {
    return failure(
      "failed",
      `the tab already has ${panes.length} panes, the most it may hold is ${most}`,
    );
  }
  const profileId = params.profile ?? source.profileId;
  const cwd = params.cwd ?? source.cwd ?? space.defaults.cwd;
  const shell = await startShell(host, space, profileId, cwd);
  if (!shell.ok) return shell.error;
  return holdingShell(host, shell.id, () => placeSplit(host, item.id, params, shell.id));
}

async function placeSplit(
  host: ApiHost,
  itemId: Id,
  params: { item: string; direction: "right" | "down"; cwd?: string; profile?: string },
  shellId: SessionId,
): Promise<ApiOutcome> {
  // The tab may have changed while the shell was starting: split the pane that has focus now.
  const now = findItem(host.workspace(), itemId);
  const panes = now ? layoutPanes(now.item.layout) : [];
  const splitting = panes.find((p) => p.id === now?.item.focusedPaneId) ?? panes[0];
  if (now === undefined || splitting === undefined) {
    await dropShell(host, shellId);
    return failure("not_found", `no tab has the id ${shorten(params.item)}`);
  }
  const known = paneIdsOf(now.item);
  host.dispatch({
    type: "pane/split",
    itemId,
    paneId: splitting.id,
    dir: params.direction === "right" ? "row" : "column",
    side: "after",
    ...(params.profile !== undefined ? { profileId: params.profile } : {}),
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
  });
  const after = findItem(host.workspace(), itemId);
  const made = after && layoutPanes(after.item.layout).find((p) => !known.has(p.id));
  if (made === undefined) {
    await dropShell(host, shellId);
    return failure("failed", "the split was not made");
  }
  // Right after the split, in the same tick: the view of the pane finds its shell already there.
  host.attachSession(made.id, String(shellId));
  return { result: { item: itemId, terminal: made.id, session: String(shellId) } };
}

/** The shell behind a terminal id, or the error that says why there is none. */
function terminalOf(
  host: ApiHost,
  terminalId: string,
  mustRun: boolean,
): { ok: true; id: SessionId; paneId: Id } | { ok: false; error: { error: ApiError } } {
  const found = findPane(host.workspace(), terminalId);
  if (found === undefined) {
    return {
      ok: false,
      error: failure("not_found", `no terminal has the id ${shorten(terminalId)}`),
    };
  }
  const { pane } = found;
  if (pane.type !== "terminal") {
    return { ok: false, error: failure("failed", `${shorten(terminalId)} is not a terminal`) };
  }
  const id = sessionOf(pane);
  if (id === undefined) {
    return { ok: false, error: failure("failed", `${shorten(terminalId)} has no shell yet`) };
  }
  if (mustRun && pane.status === "exited") {
    return {
      ok: false,
      error: failure("failed", `the shell of ${shorten(terminalId)} has exited`),
    };
  }
  return { ok: true, id, paneId: pane.id };
}

async function sendToTerminal(
  host: ApiHost,
  params: { terminal: string; text?: string; keys?: string[] },
): Promise<ApiOutcome> {
  // Every key is translated before anything is written: an unknown name sends nothing at all.
  const keys = keySequences(params.keys ?? []);
  if (!keys.ok) return failure("invalid_params", `unknown key ${shorten(keys.unknown)}`);
  const terminal = terminalOf(host, params.terminal, true);
  if (!terminal.ok) return terminal.error;
  const data = `${params.text ?? ""}${keys.bytes}`;
  if (data === "") return failure("invalid_params", 'send "text", "keys" or both');
  try {
    await host.backend.write(terminal.id, data);
  } catch (e) {
    return failure("failed", `the shell did not take the input: ${reasonOf(e)}`);
  }
  return { result: { terminal: terminal.paneId, bytes: encodeUtf8(data).length } };
}

async function readTerminal(
  host: ApiHost,
  params: { terminal: string; lines?: number },
): Promise<ApiOutcome> {
  const count = params.lines ?? API_DEFAULT_READ_LINES;
  if (!Number.isInteger(count) || count < 1 || count > API_LIMITS.readLines) {
    return failure(
      "invalid_params",
      `"lines" must be a whole number from 1 to ${API_LIMITS.readLines}`,
    );
  }
  const terminal = terminalOf(host, params.terminal, false);
  if (!terminal.ok) return terminal.error;
  let lines: string[];
  try {
    lines = [...(await host.readLines(terminal.id, count))].slice(-count);
  } catch (e) {
    return failure("failed", `the output could not be read: ${reasonOf(e)}`);
  }
  // The answer has to fit a frame: the newest lines are kept and the oldest give way.
  let bytes = 0;
  let first = lines.length;
  while (first > 0) {
    const size = encodeUtf8(lines[first - 1] ?? "").length + 1;
    if (bytes + size > API_MAX_READ_BYTES) break;
    bytes += size;
    first--;
  }
  return {
    result: { terminal: terminal.paneId, lines: lines.slice(first), truncated: first > 0 },
  };
}

async function notifyHost(
  host: ApiHost,
  params: { title: string; body?: string; terminal?: string },
): Promise<ApiOutcome> {
  let paneId: Id | undefined;
  if (params.terminal !== undefined) {
    const found = findPane(host.workspace(), params.terminal);
    if (found === undefined) {
      return failure("not_found", `no terminal has the id ${shorten(params.terminal)}`);
    }
    if (found.pane.type !== "terminal") {
      return failure("failed", `${shorten(params.terminal)} is not a terminal`);
    }
    paneId = found.pane.id;
  }
  let shown = false;
  try {
    shown =
      (await host.notify?.({
        title: params.title,
        ...(params.body !== undefined ? { body: params.body } : {}),
        ...(paneId !== undefined ? { paneId } : {}),
      })) === true;
  } catch {
    // The system did not take it: the notification was not shown.
  }
  return { result: { shown, ...(paneId !== undefined ? { terminal: paneId } : {}) } };
}

/**
 * Does what the call says to the workspace and the shells and answers `{ result }` or
 * `{ error: { code, message } }`. Never throws and never rejects: a call that does not fit its
 * method, an id that is not in the workspace, a key with no name, a shell that fails, a reader that
 * fails and any bug are all an error answer (`invalid_params`, `not_found`, `failed`, `internal`).
 *
 * Methods: `spaces.list` (every space with its tabs and panes; a terminal is named by its pane
 * id), `spaces.create` (the space is made but not shown), `items.create` (a tab with a new shell),
 * `splits.create` (a new pane with a new shell beside the pane in focus), `terminal.send` (text
 * as given, then the keys), `terminal.read` (the last lines of the output), `notify` (a notification of
 * the system, when the user's settings allow it; the answer says whether it was shown). A terminal
 * is named by its pane id, and `items.create` and `splits.create` also answer `session`, the number
 * of its shell as text, which `spaces.list` gives for every terminal (`null` when it has none).
 */
export async function dispatchApiCall(call: ApiCall, host: ApiHost): Promise<ApiOutcome> {
  try {
    const parsed = parseApiCall(call);
    if (!parsed.ok) return { error: parsed.error };
    const checked = parsed.call;
    switch (checked.method) {
      case "spaces.list":
        return listSpaces(host.workspace());
      case "spaces.create":
        return createSpace(host, checked.params.name);
      case "items.create":
        return await createItem(host, checked.params);
      case "splits.create":
        return await createSplit(host, checked.params);
      case "terminal.send":
        return await sendToTerminal(host, checked.params);
      case "terminal.read":
        return await readTerminal(host, checked.params);
      case "notify":
        return await notifyHost(host, checked.params);
    }
  } catch (e) {
    return failure("internal", `the call broke: ${reasonOf(e)}`);
  }
}
