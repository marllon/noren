import { z } from "zod";
import { THEME_ID_PATTERN } from "./theme";

// The gallery, the pure side (NOR-F18-02a): the index a gallery publishes (one JSON file in a
// public repository, `noren-gallery`), the check of it, and the comparison with what is installed.
// Downloading, the check of the hash and the installation are in `noren-core::gallery`; the screen
// that shows the index comes in NOR-F18-02b. No DOM, no Tauri, no network here.
//
// An item is a theme (a JSON file, installed as `themes/<id>.json`) or a mod (a CSS file, installed
// as `mods/<id>.css`). Its `id` is a theme id, which is also a valid mod name, so one rule makes a
// safe file name for both and the id is never a path. `sha256` is the hash of the exact bytes at
// `url`; the downloader refuses to install what does not match it.

/** The version of the index this build reads; the index carries it. */
export const GALLERY_INDEX_VERSION = 1;

/** What an item can be, the closed list. */
export const GALLERY_KINDS = ["theme", "mod"] as const;
export type GalleryKind = (typeof GALLERY_KINDS)[number];

export const GALLERY_LIMITS = {
  /** Longest id of an item, in characters (it becomes a file name). */
  idChars: 64,
  /** Longest name of an item, in characters. */
  nameChars: 60,
  /** Longest version text, in characters. */
  versionChars: 32,
  /** Longest address of an item, in characters. */
  urlChars: 512,
  /** Most items an index may hold. */
  items: 500,
  /** The most bytes an item may have (the size of a theme file and of a mod file). */
  itemBytes: 256 * 1024,
} as const;

/** `1.2.3`, optionally with a `-pre` or `+build` suffix (the same as the manifest of a plugin). */
const VERSION_PATTERN = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

/** `https://host/path`: no spaces and no user name or password before the host. */
const HTTPS_URL_PATTERN = /^https:\/\/[^\s/?#@]+([/?#]\S*)?$/;

/** 64 lower case hexadecimal digits. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const galleryItemSchema = z.strictObject({
  id: z
    .string({ error: "id must be text" })
    .regex(THEME_ID_PATTERN, { error: "id must be lower case words joined by hyphens" })
    .max(GALLERY_LIMITS.idChars, {
      error: `id is longer than ${GALLERY_LIMITS.idChars} characters`,
    }),
  kind: z.enum(GALLERY_KINDS, { error: `kind must be one of ${GALLERY_KINDS.join(", ")}` }),
  name: z
    .string({ error: "name must be text" })
    .trim()
    .min(1, { error: "name must not be empty" })
    .max(GALLERY_LIMITS.nameChars, {
      error: `name is longer than ${GALLERY_LIMITS.nameChars} characters`,
    }),
  version: z
    .string({ error: "version must be text" })
    .regex(VERSION_PATTERN, { error: "version must look like 1.2.3" })
    .max(GALLERY_LIMITS.versionChars, {
      error: `version is longer than ${GALLERY_LIMITS.versionChars} characters`,
    }),
  url: z
    .string({ error: "url must be text" })
    .regex(HTTPS_URL_PATTERN, { error: "url must be an https address with no user name" })
    .max(GALLERY_LIMITS.urlChars, {
      error: `url is longer than ${GALLERY_LIMITS.urlChars} characters`,
    }),
  sha256: z
    .string({ error: "sha256 must be text" })
    .regex(SHA256_PATTERN, { error: "sha256 must be 64 lower case hexadecimal digits" }),
  size: z
    .number({ error: "size must be a number" })
    .int({ error: "size must be a whole number of bytes" })
    .min(1, { error: "size must be at least 1 byte" })
    .max(GALLERY_LIMITS.itemBytes, {
      error: `size is over ${GALLERY_LIMITS.itemBytes} bytes`,
    }),
});

export type GalleryItem = z.infer<typeof galleryItemSchema>;

/** The index of a gallery. Fields that are not listed here are errors, not ignored. */
export const galleryIndexSchema = z
  .strictObject({
    version: z.literal(GALLERY_INDEX_VERSION, {
      error: `version must be ${GALLERY_INDEX_VERSION}, the only version of the index there is`,
    }),
    items: z
      .array(galleryItemSchema, { error: "items must be a list" })
      .max(GALLERY_LIMITS.items, { error: `an index holds at most ${GALLERY_LIMITS.items} items` }),
  })
  .superRefine((index, ctx) => {
    const seen = new Set<string>();
    index.items.forEach((item, position) => {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", position, "id"],
          message: `id "${item.id}" is listed twice`,
        });
      }
      seen.add(item.id);
    });
  });

export type GalleryIndex = z.infer<typeof galleryIndexSchema>;

export type GalleryIndexResult =
  { ok: true; index: GalleryIndex } | { ok: false; errors: string[] };

/** Checks the parsed content of an index. Never throws; the errors say which field. */
export function parseGalleryIndex(value: unknown): GalleryIndexResult {
  const parsed = galleryIndexSchema.safeParse(value);
  if (parsed.success) return { ok: true, index: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    ),
  };
}

/** What the app records about an item it installed. */
export interface InstalledGalleryItem {
  id: string;
  kind: GalleryKind;
  version: string;
  sha256: string;
}

/** Compares two versions: negative when `a` is older, 0 when equal, positive when `a` is newer. */
export function compareGalleryVersions(a: string, b: string): number {
  const split = (version: string): { core: number[]; pre: string | null } => {
    const [core = "", ...rest] = version.split(/(?=[-+])/);
    const suffix = rest.join("");
    return {
      core: core.split(".").map(Number),
      // A `-pre` suffix marks a version before the plain one; `+build` does not.
      pre: suffix.startsWith("-") ? (suffix.slice(1).split("+")[0] ?? "") : null,
    };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i += 1) {
    const difference = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** `new`: not installed. `update`: installed, and the index has a newer version. `current`: neither. */
export type GalleryStatus = "new" | "update" | "current";

export interface GalleryEntry {
  item: GalleryItem;
  status: GalleryStatus;
  /** The version installed, when there is one. */
  installedVersion?: string;
}

/**
 * Sets each item of the index against what is installed (matched by kind and id), in the order of
 * the index. An installed version that is the same as the index's, or newer, is `current`; an item
 * that is installed and no longer in the index is not listed (there is nothing to offer for it).
 */
export function compareWithInstalled(
  index: GalleryIndex,
  installed: readonly InstalledGalleryItem[],
): GalleryEntry[] {
  return index.items.map((item) => {
    const have = installed.find((entry) => entry.id === item.id && entry.kind === item.kind);
    if (have === undefined) return { item, status: "new" };
    const status = compareGalleryVersions(item.version, have.version) > 0 ? "update" : "current";
    return { item, status, installedVersion: have.version };
  });
}
