import { z } from "zod";

// The update of the app itself, the pure side (NOR-F20-02a): the shape of what the app answers
// about it, the check of that shape, and the order of two versions. Finding the update, checking
// its signature and running the installer are in `src-tauri/src/update.rs` and
// `noren-core::update`; the screen that drives them is NOR-F20-02b. No DOM, no Tauri, no network
// here.
//
// The order of the versions is the one of semver 2.0 (item 11), which is what the updater plugin
// decides with in the app: the build metadata (`+5`) does not count, and a release with a
// pre-release tag (`1.0.0-beta.1`) is older than the same version without one.

/** Limits of the update, the same numbers as `noren-core::update`. */
export const UPDATE_LIMITS = {
  /** The most characters of release notes kept (one more for the ellipsis of a cut). */
  notesChars: 8000,
} as const;

/** A newer version, as the person is told about it. */
export const updateInfoSchema = z.strictObject({
  /** The version that would be installed. */
  version: z.string({ error: "version must be text" }).min(1, { error: "version is empty" }),
  /** The version that is running. */
  currentVersion: z
    .string({ error: "currentVersion must be text" })
    .min(1, { error: "currentVersion is empty" }),
  /** The release notes (plain text, no control character but line breaks and tabs), if any. */
  notes: z
    .string({ error: "notes must be text" })
    .refine((text) => [...text].length <= UPDATE_LIMITS.notesChars + 1, {
      error: "notes are too long",
    })
    .nullable(),
  /** When the release was published, in seconds since 1970, when the feed says. */
  publishedAt: z.number({ error: "publishedAt must be a number" }).int().nullable(),
});

export type UpdateInfo = z.infer<typeof updateInfoSchema>;

/** Where the update stands, with no network. */
export const updateStatusSchema = z.strictObject({
  /** This build has a key and an address to update from. Without it a check is refused. */
  configured: z.boolean({ error: "configured must be true or false" }),
  /** The version that is running. */
  currentVersion: z
    .string({ error: "currentVersion must be text" })
    .min(1, { error: "currentVersion is empty" }),
  /** The update the last check found, not installed yet. */
  pending: updateInfoSchema.nullable(),
});

export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** How much of the package has been downloaded. */
export const updateProgressSchema = z.strictObject({
  downloaded: z
    .number({ error: "downloaded must be a number" })
    .int()
    .nonnegative({ error: "downloaded cannot be negative" }),
  /** What the server announced, when it did. */
  total: z
    .number({ error: "total must be a number" })
    .int()
    .nonnegative({ error: "total cannot be negative" })
    .nullable(),
});

export type UpdateProgress = z.infer<typeof updateProgressSchema>;

export type UpdateParse<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, value: unknown): UpdateParse<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

/** Checks what the app answered about the status of the update. */
export function parseUpdateStatus(value: unknown): UpdateParse<UpdateStatus> {
  return parseWith(updateStatusSchema, value);
}

/** Checks what the app answered to a check: the update found, or `null` for none. */
export function parseUpdateCheck(value: unknown): UpdateParse<UpdateInfo | null> {
  if (value === null) return { ok: true, value: null };
  return parseWith(updateInfoSchema, value);
}

/** Checks the payload of a progress event. */
export function parseUpdateProgress(value: unknown): UpdateParse<UpdateProgress> {
  return parseWith(updateProgressSchema, value);
}

// ---- the order of versions ---------------------------------------------------------------------

/** A version read as semver 2.0 reads it. */
interface ParsedVersion {
  core: [number, number, number];
  /** The dot separated identifiers after the `-`, none for a release. */
  pre: string[];
}

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Reads `text` (a leading `v`, as a tag has, is dropped); `undefined` when it is not a semver version. */
function parseVersion(text: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(text.startsWith("v") ? text.slice(1) : text);
  if (match === null) return undefined;
  const [, major, minor, patch, pre] = match;
  const numbers = [major, minor, patch].map(Number);
  if (!numbers.every(Number.isSafeInteger)) return undefined;
  return {
    core: numbers as [number, number, number],
    pre: pre === undefined ? [] : pre.split("."),
  };
}

/** Whether `text` is a version this order can place. */
export function isVersion(text: string): boolean {
  return parseVersion(text) !== undefined;
}

const NUMERIC = /^\d+$/;

/** The order of two pre-release identifiers: numbers by value and before words, words by their characters. */
function compareIdentifier(a: string, b: string): number {
  const aNumber = NUMERIC.test(a);
  const bNumber = NUMERIC.test(b);
  if (aNumber && bNumber) return Math.sign(Number(a) - Number(b));
  if (aNumber) return -1;
  if (bNumber) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order of two versions: -1 when `a` is older than `b`, 1 when newer, 0 when they are the same
 * (build metadata aside). `undefined` when either is not a version.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;
  for (const [i, value] of left.core.entries()) {
    const difference = value - (right.core[i] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  // A release is newer than any pre-release of the same version.
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const shared = Math.min(left.pre.length, right.pre.length);
  for (const [i, identifier] of left.pre.slice(0, shared).entries()) {
    const order = compareIdentifier(identifier, right.pre[i] ?? "");
    if (order !== 0) return order < 0 ? -1 : 1;
  }
  const difference = left.pre.length - right.pre.length;
  return difference === 0 ? 0 : difference < 0 ? -1 : 1;
}

/** Whether `candidate` is a newer version than `current`; false when either is not a version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}
