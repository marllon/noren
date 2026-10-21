import { z } from "zod";
import { isReservedModName, isValidModFileName } from "./mods";
import { THEME_ID_PATTERN } from "./theme";

// The sync through git, the pure side (NOR-F19-01a): the shape of what the app answers about the
// sync, the check of it, the list of the files that may travel and the check of the address of the
// remote. Running git, the clone and the copy of files are in `noren-core::sync`; the screen that
// drives them comes in NOR-F19-01b. No DOM, no Tauri, no network here.
//
// The list of names and the rules for an address are the same as in `noren-core` (`is_syncable` and
// `validate_remote_url`); both sides are tested with the same cases.

/** Limits of the sync, the same numbers as `noren-core`. */
export const SYNC_LIMITS = {
  /** Longest address of a remote, in characters. */
  remoteChars: 2048,
  /** The most bytes a file may hold to travel. */
  fileBytes: 1024 * 1024,
  /** The most files that travel at once. */
  files: 500,
  /** Longest name of a space file, in characters. */
  spaceFileChars: 128,
} as const;

/** The end of the name of a space file. */
const SPACE_SUFFIX = ".noren-space.json";

/** Whether the name of a space file is one plain file name on every system. */
function isSpaceFileName(name: string): boolean {
  if (!name.endsWith(SPACE_SUFFIX)) return false;
  const stem = name.slice(0, -SPACE_SUFFIX.length);
  // eslint-disable-next-line no-control-regex
  const unsafe = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/u;
  return (
    stem.length > 0 &&
    [...name].length <= SYNC_LIMITS.spaceFileChars &&
    !stem.startsWith(".") &&
    !/[. ]$/.test(stem) &&
    !unsafe.test(stem) &&
    !isReservedModName(stem)
  );
}

/**
 * Whether `path` (relative to the config folder, `/` as the separator) may travel: `config.jsonc`,
 * `themes/<id>.json`, `mods/<name>.css` and `spaces/<name>.noren-space.json`, and nothing else.
 * `state.json`, the scrollback, `gallery.json`, `plugins/` and every other name stay on this
 * computer.
 */
export function isSyncablePath(path: string): boolean {
  if (path === "config.jsonc") return true;
  const parts = path.split("/");
  if (parts.length !== 2) return false;
  const [dir, name] = parts as [string, string];
  switch (dir) {
    case "themes":
      return (
        name.endsWith(".json") &&
        THEME_ID_PATTERN.test(name.slice(0, -".json".length)) &&
        !isReservedModName(name.slice(0, -".json".length))
      );
    case "mods":
      return isValidModFileName(name);
    case "spaces":
      return isSpaceFileName(name);
    default:
      return false;
  }
}

/** A full path of this computer: `/...`, or a drive (`C:\...` or `C:/...`). */
function isLocalPath(url: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(url) || (url.startsWith("/") && !url.startsWith("//"));
}

/**
 * Why `url` cannot be the remote of a sync, or `undefined` when it can. Accepted: `https://host/path`
 * (no user name and no password: a token in the address would stay in the clone in plain text),
 * `ssh://[user@]host/path`, `file:///path`, `[user@]host:path` and a full local path. Refused: a
 * password anywhere, a value git would read as an option (starting with `-`), a helper transport
 * (`ext::`, `fd::` and every `name::`), plain `http://` and any other scheme.
 */
export function syncRemoteProblem(url: string): string | undefined {
  if (url === "") return "the address is empty";
  if ([...url].length > SYNC_LIMITS.remoteChars) return "the address is too long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(url)) return "the address has a control character";
  if (url.startsWith("-")) return "the address starts with '-' and would read as an option";
  if (isLocalPath(url)) return undefined;
  if (/\s/u.test(url)) return "the address has a space";
  const helper = /^([A-Za-z0-9+.-]+)::/.exec(url);
  if (helper !== null) return "a helper transport (name::address) is not allowed";
  const at = url.indexOf("://");
  if (at >= 0) return schemeProblem(url.slice(0, at).toLowerCase(), url.slice(at + 3));
  return scpProblem(url);
}

function schemeProblem(scheme: string, rest: string): string | undefined {
  if (scheme === "file") {
    return rest === "" || rest.startsWith("-") ? "a file address needs a path" : undefined;
  }
  if (scheme === "http") return "http is not encrypted: use https";
  if (scheme !== "https" && scheme !== "ssh") {
    return "only https, ssh and file addresses are accepted";
  }
  const authority = rest.split(/[/?#]/u)[0] ?? "";
  const atSign = authority.lastIndexOf("@");
  const userinfo = atSign >= 0 ? authority.slice(0, atSign) : undefined;
  const hostPort = atSign >= 0 ? authority.slice(atSign + 1) : authority;
  if (userinfo !== undefined) {
    if (userinfo.includes(":")) {
      return "the address has a password: use the credential manager of git instead";
    }
    if (scheme === "https") {
      return "the address has a user name: https addresses are kept in the clone in plain text";
    }
    if (userinfo === "" || userinfo.startsWith("-"))
      return "the user name of the address is not valid";
  }
  const host = hostPort.startsWith("[")
    ? (hostPort.slice(1).split("]")[0] ?? "")
    : (hostPort.split(":")[0] ?? "");
  if (host === "") return "the address has no host";
  if (host.startsWith("-")) return "the host starts with '-' and would read as an option";
  if (host.includes("\\")) return "the host has a backslash";
  return undefined;
}

function scpProblem(url: string): string | undefined {
  const notAnAddress = "not an https, ssh or file address, nor a local path";
  const colon = url.indexOf(":");
  if (colon < 0) return notAnAddress;
  const head = url.slice(0, colon);
  const path = url.slice(colon + 1);
  if (head.includes("/")) return notAnAddress;
  const atSign = head.lastIndexOf("@");
  const user = atSign >= 0 ? head.slice(0, atSign) : undefined;
  const host = atSign >= 0 ? head.slice(atSign + 1) : head;
  if (user === undefined && (path.split("/")[0] ?? "").includes("@")) {
    return "the address looks like user:password@host";
  }
  if (user !== undefined && (user === "" || user.startsWith("-"))) {
    return "the user name of the address is not valid";
  }
  if (host.length < 2 || host.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(host)) {
    return "the host of the address is not valid";
  }
  if (path === "") return "the address has no path";
  return undefined;
}

/** What the next push would do with one file. */
export const SYNC_CHANGES = ["added", "modified"] as const;
export type SyncChange = (typeof SYNC_CHANGES)[number];

const syncPath = z
  .string({ error: "a path must be text" })
  .max(200, { error: "a path is too long" })
  .refine(isSyncablePath, { error: "a path is not one that may be synced" });

export const syncStatusSchema = z.strictObject({
  connected: z.boolean({ error: "connected must be true or false" }),
  remote: z.string().max(SYNC_LIMITS.remoteChars).nullable(),
  branch: z.string().max(200).nullable(),
  pending: z
    .array(z.strictObject({ path: syncPath, change: z.enum(SYNC_CHANGES) }))
    .max(SYNC_LIMITS.files),
  ahead: z.number().int().min(0),
  behind: z.number().int().min(0),
});

/** Where the sync stands: the remote, the branch, the files a push would carry, and the distance. */
export type SyncStatus = z.infer<typeof syncStatusSchema>;

/** What a pull did: nothing came, files were written, or the merge would conflict and was aborted. */
export const syncPullSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("up_to_date") }),
  z.strictObject({ kind: z.literal("updated"), files: z.array(syncPath).max(SYNC_LIMITS.files) }),
  z.strictObject({
    kind: z.literal("conflict"),
    paths: z.array(syncPath).min(1).max(SYNC_LIMITS.files),
  }),
]);
export type SyncPullResult = z.infer<typeof syncPullSchema>;

/** What a push did: whether a commit was made, whether something was sent, and which files. */
export const syncPushSchema = z.strictObject({
  committed: z.boolean(),
  pushed: z.boolean(),
  files: z.array(syncPath).max(SYNC_LIMITS.files),
});
export type SyncPushResult = z.infer<typeof syncPushSchema>;

export type SyncParse<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, value: unknown): SyncParse<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

/** Checks what the app answered about the status of the sync. */
export function parseSyncStatus(value: unknown): SyncParse<SyncStatus> {
  return parseWith(syncStatusSchema, value);
}

/** Checks what the app answered about a pull. */
export function parseSyncPull(value: unknown): SyncParse<SyncPullResult> {
  return parseWith(syncPullSchema, value);
}

/** Checks what the app answered about a push. */
export function parseSyncPush(value: unknown): SyncParse<SyncPushResult> {
  return parseWith(syncPushSchema, value);
}
