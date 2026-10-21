import {
  SPACE_FILE_EXTENSION,
  exportFileName,
  exportSpace,
  parseSpaceFile,
  type ExportRemovals,
  type SpaceFile,
} from "./space-file";
import { SYNC_LIMITS, isSyncSpaceFileName } from "./sync";
import type { SyncSpaceFile, SyncSpaceFolder, SyncSpaceWrite } from "./sync";
import { encodeUtf8 } from "./utf8";
import type { UserProfile } from "./user-profile-schema";
import type { Id, Space } from "./types";

// The spaces in the sync (NOR-F19-01c), the pure side: which file each space is written to before a
// push, and what a pull does with the files that are in the folder. Reading and writing the files and
// the record that ties each file to a space are in `noren-core::sync_spaces`; running this against a
// backend and the workspace is in the app (`space-sync.ts`). No DOM, no Tauri.
//
// - A space travels as `spaces/<name>.noren-space.json`, one file per space, made by `exportSpace`.
//   The first time a space is written it gets a name from its own (`exportFileName`) that no file in
//   the folder or in the clone has, with `-2`, `-3`... after it when two spaces share a name; from
//   then on the record keeps the name, so renaming the space changes the file and not its name.
// - A file the record ties to a space, whose bytes are as they were, is nothing to do. A file with
//   no link is a new space. A file whose bytes changed since the link was made is the linked space
//   made again from the file, in the same place; if that space is gone the file brings it back.
// - A file that says what the space says already, except where you were looking (the tab shown, the
//   pane focused, a folded group), changes nothing but the record: switching tabs on one computer
//   must not close the tabs of the same space on another, nor make a file two computers both edit.

/**
 * The file as a text that leaves out where you were looking: the tab a space shows, the pane an
 * item has focused and whether a group is folded. Two files with the same signature are the same
 * space for the sync.
 */
export function spaceFileSignature(file: SpaceFile): string {
  return JSON.stringify(file, (key, value: unknown) =>
    key === "activeItemId" || key === "focusedPaneId" || key === "collapsed" ? undefined : value,
  );
}

const lower = (name: string): string => name.toLowerCase();

/**
 * The name for a space's first file: `exportFileName` of its name, then `-2`, `-3`... until the
 * name is not taken (names compare without case, as the file systems of Windows and macOS do) and is
 * one the sync carries.
 */
function newFileName(spaceName: string, taken: Set<string>): string {
  const first = exportFileName(spaceName);
  const stem = first.slice(0, -SPACE_FILE_EXTENSION.length);
  for (let n = 1; n <= SYNC_LIMITS.files + 1; n++) {
    const candidate = `${n === 1 ? stem : `${stem}-${n}`}${SPACE_FILE_EXTENSION}`;
    if (!taken.has(lower(candidate)) && isSyncSpaceFileName(candidate)) return candidate;
  }
  // Only reached with more spaces than a sync carries; the backend refuses the batch then.
  return `${stem}-${taken.size + 1}${SPACE_FILE_EXTENSION}`;
}

export interface SpacePushSkip {
  spaceId: Id;
  name: string;
  /** Short sentence: why the space has no file. */
  reason: string;
}

export interface SpacePushPlan {
  /** The files to write, in the order of the spaces. */
  writes: SyncSpaceWrite[];
  /** Spaces whose file already says what they say, so nothing is written for them. */
  unchanged: number;
  /** Spaces that cannot be made a file, with the reason; the others are not held back. */
  skipped: SpacePushSkip[];
  /** What the export took out of a space because it looked like a secret (only spaces that lost something). */
  leftOut: { name: string; removed: ExportRemovals }[];
}

export interface PlanPushOptions {
  /** The profiles of the user; the ones a space uses go in its file (`exportSpace`). */
  profiles?: readonly UserProfile[];
  /** Plan only the spaces that already have a file: the first pull writes those and no others. */
  linkedOnly?: boolean;
  /**
   * The text of the files the record ties to a space, by file name. A space whose file says the
   * same (`spaceFileSignature`) is left alone; without the text the file is written.
   */
  held?: ReadonlyMap<string, string>;
}

/**
 * One file per space, to write before a push: a space with a file keeps its name, a space without
 * one gets a new name (see the top of this file). A space that cannot be exported (a page address
 * with a secret in it) or whose file would pass the ceiling is skipped with the reason. Never throws.
 */
export function planSpacePush(
  spaces: readonly Space[],
  folder: SyncSpaceFolder,
  options: PlanPushOptions = {},
): SpacePushPlan {
  const plan: SpacePushPlan = { writes: [], unchanged: 0, skipped: [], leftOut: [] };
  const nameOf = new Map<Id, string>();
  for (const file of folder.files) {
    if (file.linked !== null && !nameOf.has(file.linked.spaceId)) {
      nameOf.set(file.linked.spaceId, file.name);
    }
  }
  const taken = new Set([...folder.files.map((file) => file.name), ...folder.cloned].map(lower));
  for (const space of spaces) {
    const linked = nameOf.get(space.id);
    if (options.linkedOnly === true && linked === undefined) continue;
    const made = exportSpace(space, { profiles: options.profiles ?? [] });
    if (!made.ok) {
      plan.skipped.push({ spaceId: space.id, name: space.name, reason: made.error });
      continue;
    }
    if (encodeUtf8(made.text).length > SYNC_LIMITS.fileBytes) {
      plan.skipped.push({
        spaceId: space.id,
        name: space.name,
        reason: `its file would be larger than ${SYNC_LIMITS.fileBytes / 1024} KiB`,
      });
      continue;
    }
    if (linked !== undefined && isLeftAlone(made.file, options.held?.get(linked))) {
      plan.unchanged += 1;
      continue;
    }
    let name = linked;
    if (name === undefined) {
      name = newFileName(space.name, taken);
      taken.add(lower(name));
    }
    plan.writes.push({ name, text: made.text, spaceId: space.id });
    const { removed } = made;
    if (removed.env.length + removed.commands.length + removed.profiles.length > 0) {
      plan.leftOut.push({ name: space.name, removed });
    }
  }
  return plan;
}

/** Whether the text a file holds already says what `file` says. */
function isLeftAlone(file: SpaceFile, held: string | undefined): boolean {
  if (held === undefined) return false;
  const parsed = parseSpaceFile(held);
  return parsed.ok && spaceFileSignature(parsed.file) === spaceFileSignature(file);
}

/**
 * The files a pull has to look at: those with no link, and those whose bytes are not the ones the
 * record saw. A file the record knows with the same bytes is nothing to do and is not read.
 */
export function spacesToRead(files: readonly SyncSpaceFile[]): SyncSpaceFile[] {
  return files.filter((file) => file.linked === null || file.linked.hash !== file.hash);
}

export interface SpacePullPlan {
  /** Files that make a new space (no link, or a link to a space that is gone). */
  add: { name: string; file: SpaceFile }[];
  /** Files that make the linked space again, in its place. */
  replace: { name: string; spaceId: Id; file: SpaceFile }[];
  /** Files that changed but say what the linked space already says: only the record is renewed. */
  relink: { name: string; spaceId: Id }[];
  /** Files that cannot be used, with the reason. */
  ignored: { name: string; reason: string }[];
  /** Files the record knew with the same bytes. */
  unchanged: number;
}

/**
 * What a pull does with the space files in the folder. `read` has the text of the files
 * `spacesToRead` named (a file with no text there is ignored); `spaces` are the spaces of the
 * workspace now and `profiles` the user's profiles, to compare a changed file with the space it is
 * tied to. A file that is not a valid space file is ignored with the short reason. Never throws.
 */
export function planSpacePull(
  files: readonly SyncSpaceFile[],
  read: ReadonlyMap<string, string>,
  spaces: readonly Space[],
  profiles: readonly UserProfile[] = [],
): SpacePullPlan {
  const plan: SpacePullPlan = { add: [], replace: [], relink: [], ignored: [], unchanged: 0 };
  const toRead = new Set(spacesToRead(files).map((file) => file.name));
  for (const entry of files) {
    if (!toRead.has(entry.name)) {
      plan.unchanged += 1;
      continue;
    }
    const text = read.get(entry.name);
    if (text === undefined) {
      plan.ignored.push({ name: entry.name, reason: "the file could not be read" });
      continue;
    }
    const parsed = parseSpaceFile(text);
    if (!parsed.ok) {
      plan.ignored.push({ name: entry.name, reason: parsed.error });
      continue;
    }
    const target =
      entry.linked === null
        ? undefined
        : spaces.find((space) => space.id === entry.linked?.spaceId);
    if (target === undefined) {
      plan.add.push({ name: entry.name, file: parsed.file });
      continue;
    }
    const mine = exportSpace(target, { profiles });
    if (mine.ok && spaceFileSignature(mine.file) === spaceFileSignature(parsed.file)) {
      plan.relink.push({ name: entry.name, spaceId: target.id });
    } else {
      plan.replace.push({ name: entry.name, spaceId: target.id, file: parsed.file });
    }
  }
  return plan;
}
