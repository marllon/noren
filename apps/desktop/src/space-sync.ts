import { planProfiles, planSpacePull, planSpacePush, spacesToRead } from "@noren/model";
import type {
  Backend,
  ExportRemovals,
  Id,
  Space,
  SpaceFile,
  SpacePushSkip,
  SyncSpaceLink,
  UserProfile,
} from "@noren/model";
import { configManager } from "./config-store";
import { t } from "./i18n";
import { takenProfileIds } from "./profile-import";
import { getProfiles, syncProfiles } from "./profiles-store";
import { commitSpaceImport, importNotice, removedText } from "./space-file-io";
import { reasonOf } from "./settings-sync";
import type { WorkspaceStore } from "./workspace-store";

// The spaces in the sync (NOR-F19-01c): before a push (and, for the spaces already tied to a file,
// before a pull) every space is written as `spaces/<name>.noren-space.json` in the config folder, and
// after a pull the files that came in become spaces. The choices (which file a space gets, which file
// is a new space, a changed one or nothing) are `planSpacePush` and `planSpacePull` of
// `@noren/model`; this asks the backend for the files and the window for the spaces, and applies the
// plan. Never touches the DOM.

export type SpaceSyncBackend = Pick<
  Backend,
  "syncSpaceFiles" | "syncReadSpaceFile" | "syncWriteSpaceFiles" | "syncLinkSpaceFiles"
>;

/** What the sync needs of the window: the spaces and profiles it has, and a way to make a space. */
export interface SpaceSyncPort {
  /** The spaces of the workspace now, in order. */
  spaces(): readonly Space[];
  /** The profiles of the user (`profiles` of `config.jsonc`), as the window has them now. */
  profiles(): readonly UserProfile[];
  /** Reads `config.jsonc` again: a pull may have just written the profiles a file counts on. */
  refreshSettings(): Promise<void>;
  /**
   * Makes the space of `file` without showing it: a new one at the end, or, with `replaces`, the
   * space with that id made again in its place. Resolves to the id of the space, or why it was not made.
   */
  importFile(
    name: string,
    file: SpaceFile,
    replaces: Id | undefined,
  ): Promise<{ ok: true; spaceId: Id; note?: string } | { ok: false; reason: string }>;
}

export interface SpaceWriteResult {
  /** The files written, by name. */
  written: string[];
  /** Spaces whose file already said what they say. */
  unchanged: number;
  /** Spaces that could not be made a file. */
  skipped: SpacePushSkip[];
  /** What the export took out of the files because it looked like a secret. */
  leftOut: { name: string; removed: ExportRemovals }[];
}

/**
 * Writes the spaces as files in the config folder, each tied to its space: before a push all of
 * them, before a pull (`linkedOnly`) only the ones that already have a file, so what was changed
 * here is one side of the merge and a space with no file yet does not take a name the remote may
 * hold. A space whose file already says the same is not written again. Rejects with the backend's
 * words when the files cannot be listed or written.
 */
export async function writeSpaceFiles(
  backend: SpaceSyncBackend,
  port: SpaceSyncPort,
  options: { linkedOnly: boolean },
): Promise<SpaceWriteResult> {
  const folder = await backend.syncSpaceFiles();
  const spaceIds = new Set(port.spaces().map((space) => space.id));
  const held = new Map<string, string>();
  for (const file of folder.files) {
    if (file.linked === null || !spaceIds.has(file.linked.spaceId)) continue;
    try {
      held.set(file.name, await backend.syncReadSpaceFile(file.name));
    } catch {
      // A file that cannot be read is written again.
    }
  }
  const plan = planSpacePush(port.spaces(), folder, {
    profiles: port.profiles(),
    linkedOnly: options.linkedOnly,
    held,
  });
  if (plan.writes.length > 0) await backend.syncWriteSpaceFiles(plan.writes);
  return {
    written: plan.writes.map((write) => write.name),
    unchanged: plan.unchanged,
    skipped: plan.skipped,
    leftOut: plan.leftOut,
  };
}

export interface SpaceImportResult {
  /** New spaces: the file and the name of the space. */
  added: { file: string; name: string }[];
  /** Spaces made again from a file that changed. */
  replaced: { file: string; name: string }[];
  /** Files that changed but say what their space already says. */
  relinked: number;
  /** Files that are not a space file, with the reason. */
  ignored: { file: string; reason: string }[];
  /** Files that were a space file but could not become a space, with the reason. */
  failed: { file: string; reason: string }[];
  /** About the profiles of the files that were added or left out. */
  notes: string[];
}

/**
 * Makes spaces of the files a pull brought: a file the record does not know becomes a new space; a
 * file the record knows whose bytes changed makes its space again, in place; a file that says what
 * its space says changes nothing; a file that is not a space file is left out with the reason. Every
 * space made is tied to its file so the next pull does not make it twice. Rejects with the
 * backend's words when the files cannot be listed or tied.
 */
export async function importSpaceFiles(
  backend: SpaceSyncBackend,
  port: SpaceSyncPort,
): Promise<SpaceImportResult> {
  const folder = await backend.syncSpaceFiles();
  const wanted = spacesToRead(folder.files);
  const result: SpaceImportResult = {
    added: [],
    replaced: [],
    relinked: 0,
    ignored: [],
    failed: [],
    notes: [],
  };
  if (wanted.length === 0) return result;
  const read = new Map<string, string>();
  for (const file of wanted) {
    try {
      read.set(file.name, await backend.syncReadSpaceFile(file.name));
    } catch {
      // The plan leaves a file with no text out, saying it could not be read.
    }
  }
  await port.refreshSettings();
  const plan = planSpacePull(folder.files, read, port.spaces(), port.profiles());
  result.ignored = plan.ignored.map(({ name, reason }) => ({ file: name, reason }));
  const links: SyncSpaceLink[] = plan.relink.map(({ name, spaceId }) => ({ name, spaceId }));
  result.relinked = plan.relink.length;
  const apply = async (
    name: string,
    file: SpaceFile,
    replaces: Id | undefined,
    into: { file: string; name: string }[],
  ): Promise<void> => {
    const made = await port.importFile(name, file, replaces);
    if (!made.ok) {
      result.failed.push({ file: name, reason: made.reason });
      return;
    }
    into.push({ file: name, name: file.space.name });
    links.push({ name, spaceId: made.spaceId });
    if (made.note !== undefined) result.notes.push(made.note);
  };
  // One at a time: a file may add profiles that the next one finds already there.
  for (const entry of plan.replace) {
    await apply(entry.name, entry.file, entry.spaceId, result.replaced);
  }
  for (const entry of plan.add) await apply(entry.name, entry.file, undefined, result.added);
  if (links.length > 0) await backend.syncLinkSpaceFiles(links);
  return result;
}

/** The names of spaces in one sentence: `"Work"`, `"Work" and "Play"`, `"A", "B" and "C"`. */
function quoted(names: readonly string[]): string {
  const marked = names.map((name) => `"${name}"`);
  const last = marked.at(-1) ?? "";
  return marked.length <= 1
    ? last
    : `${marked.slice(0, -1).join(", ")} ${t("settings.syncSpaces.and")} ${last}`;
}

/**
 * What a write before a push (or a pull) has to say, if anything: the spaces that got no file and
 * what the files leave out because it looked like a secret. Empty when there is nothing to warn of.
 */
export function writeNotes(result: SpaceWriteResult): string[] {
  const notes: string[] = [];
  if (result.skipped.length > 0) {
    notes.push(
      t("settings.syncSpaces.skipped", {
        list: result.skipped.map((skip) => `"${skip.name}" (${skip.reason})`).join("; "),
      }),
    );
  }
  const left = result.leftOut
    .map((entry) => `"${entry.name}": ${removedText(entry.removed) ?? ""}`)
    .join("; ");
  if (left !== "") notes.push(t("settings.syncSpaces.leftOut", { list: left }));
  return notes;
}

/**
 * What a pull that made spaces has to say: which were added, which were made again from the remote's
 * file (and that their old tabs are in the closed ones), the files that were left out and why.
 * `changed` tells whether the pull touched any space.
 */
export function importNotes(result: SpaceImportResult): { notes: string[]; changed: boolean } {
  const notes: string[] = [];
  if (result.added.length > 0) {
    notes.push(
      result.added.length === 1
        ? t("settings.syncSpaces.added.one", { names: quoted(result.added.map((s) => s.name)) })
        : t("settings.syncSpaces.added.other", {
            n: result.added.length,
            names: quoted(result.added.map((s) => s.name)),
          }),
    );
  }
  if (result.replaced.length > 0) {
    notes.push(
      result.replaced.length === 1
        ? t("settings.syncSpaces.replaced.one", {
            names: quoted(result.replaced.map((s) => s.name)),
          })
        : t("settings.syncSpaces.replaced.other", {
            n: result.replaced.length,
            names: quoted(result.replaced.map((s) => s.name)),
          }),
    );
  }
  for (const skipped of result.ignored) {
    notes.push(t("settings.syncSpaces.ignored", { file: skipped.file, reason: skipped.reason }));
  }
  for (const failed of result.failed) {
    notes.push(t("settings.syncSpaces.failed", { file: failed.file, reason: failed.reason }));
  }
  notes.push(...result.notes);
  return { notes, changed: result.added.length + result.replaced.length > 0 };
}

/** What a step of the spaces failed with, in the words of the backend. */
export function spaceStepFailure(error: unknown): string {
  return t("settings.syncSpaces.stepFailed", { reason: reasonOf(error) });
}

/**
 * The port over the window: the spaces of the workspace store, the profiles of the settings, and
 * `space/import` (a new space, not shown) or `space/reimport` (the space made again in its place)
 * after the profiles its file counts on are written to `config.jsonc` (like Import space).
 */
export function appSpaceSyncPort(
  store: WorkspaceStore,
  backend: Pick<Backend, "loadConfig" | "setUserProfiles" | "listProfiles">,
): SpaceSyncPort {
  return {
    spaces: () => store.getState().workspace.spaces,
    profiles: () => configManager.state.config.profiles ?? [],
    refreshSettings: async () => {
      configManager.apply(await backend.loadConfig());
    },
    importFile: async (name, file, replaces) => {
      const settings = configManager.state.config;
      const profiles = planProfiles(
        file,
        settings.profiles ?? [],
        takenProfileIds(settings, getProfiles()),
      );
      const spacesBefore = store.getState().workspace.spaces;
      const before = new Set(spacesBefore.map((space) => space.id));
      const replaced = spacesBefore.find((space) => space.id === replaces);
      let made: Id | undefined;
      const notice = await commitSpaceImport(
        { fileName: name, file, profiles },
        {
          settings: configManager,
          syncProfiles: () => syncProfiles(backend, configManager.state.config.profiles ?? []),
          importSpace: (spaceFile) => {
            store
              .getState()
              .dispatch(
                replaces === undefined
                  ? { type: "space/import", file: spaceFile, activate: false }
                  : { type: "space/reimport", spaceId: replaces, file: spaceFile },
              );
            const spacesAfter = store.getState().workspace.spaces;
            if (replaces === undefined) {
              made = spacesAfter.find((space) => !before.has(space.id))?.id;
            } else {
              // A space made again is a new object; the same one means the action changed nothing.
              made =
                spacesAfter.find((space) => space.id === replaces) !== replaced
                  ? replaces
                  : undefined;
            }
          },
        },
      );
      if (made === undefined) return { ok: false, reason: notice };
      const touchedProfiles = profiles.add.length + profiles.conflicts.length > 0;
      return {
        ok: true,
        spaceId: made,
        ...(touchedProfiles ? { note: importNotice(file.space.name, profiles) } : {}),
      };
    },
  };
}
