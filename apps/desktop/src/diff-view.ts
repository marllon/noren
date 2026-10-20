import { MAX_GIT_DIFF_BYTES, parseGitDiff } from "@noren/model";
import type { Backend, GitDiff, GitDiffFile, GitDiffRefusal, GitDiffStatus } from "@noren/model";
import { t } from "./i18n";
import { formatBytes } from "./preview-view";

// What a diff pane draws, decided apart from React: the state of the read, and for each answer of the
// backend the one thing the pane shows (the files of the diff, "nothing changed", the reason there is
// no diff, in the language in force). The pane (`DiffPane.tsx`) only draws it.

/** What a diff pane needs of the backend. */
export type DiffReader = Pick<Backend, "readGitDiff">;

/** Where the read of a diff is: on its way, answered, or failed (the shell itself, not the folder). */
export type DiffState =
  { status: "loading" } | { status: "ready"; diff: GitDiff } | { status: "failed"; reason: string };

/** Reads the diff of `cwd`; a failure of the shell becomes a state, so the pane never throws. */
export async function loadDiff(reader: DiffReader, cwd: string): Promise<DiffState> {
  try {
    return { status: "ready", diff: await reader.readGitDiff(cwd) };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The most rows of one file a pane draws before it asks to draw them all. */
export const MAX_DIFF_ROWS_SHOWN = 2000;

/** Why a diff is not shown, in the language in force. */
export function refusalText(refusal: GitDiffRefusal): string {
  switch (refusal.reason) {
    case "relative":
      return t("diff.refused.relative");
    case "network":
      return t("diff.refused.network");
    case "invalid":
      return t("diff.refused.invalid");
    case "missing":
      return t("diff.refused.missing");
    case "not-a-repository":
      return t("diff.refused.notARepository");
    case "git-missing":
      return t("diff.refused.gitMissing");
    case "too-large":
      return t("diff.refused.tooLarge", { limit: formatBytes(MAX_GIT_DIFF_BYTES) });
    case "failed":
      return refusal.detail !== undefined && refusal.detail !== ""
        ? t("diff.refused.failed", { reason: refusal.detail })
        : t("diff.refused.failedBare");
  }
}

/** The one thing a diff pane draws. */
export type DiffContent =
  | { type: "loading" }
  /** Git ran and found nothing changed. */
  | { type: "clean" }
  | { type: "files"; files: GitDiffFile[] }
  | { type: "refused"; reason: GitDiffRefusal["reason"]; message: string }
  | { type: "failed"; message: string };

/** What the pane draws for a state of the read. */
export function contentOf(state: DiffState): DiffContent {
  if (state.status === "loading") return { type: "loading" };
  if (state.status === "failed") {
    return { type: "failed", message: t("diff.failed", { reason: state.reason }) };
  }
  const { diff } = state;
  if (diff.kind === "refused") {
    return { type: "refused", reason: diff.reason, message: refusalText(diff) };
  }
  if (diff.text.trim() === "") return { type: "clean" };
  const files = parseGitDiff(diff.text);
  // Text that holds no file is not a diff the pane can draw.
  if (files.length === 0) return { type: "failed", message: t("diff.unreadable") };
  return { type: "files", files };
}

/** The letter in front of a file in the list, and the word a screen reader says for it. */
export function statusLetter(status: GitDiffStatus): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
  }
}

export function statusText(status: GitDiffStatus): string {
  switch (status) {
    case "modified":
      return t("diff.status.modified");
    case "added":
      return t("diff.status.added");
    case "deleted":
      return t("diff.status.deleted");
    case "renamed":
      return t("diff.status.renamed");
    case "copied":
      return t("diff.status.copied");
  }
}

/** What a file of the diff says about itself under its name, when there is more than lines to show. */
export function fileNote(file: GitDiffFile): string | undefined {
  if (file.binary) return t("diff.note.binary");
  if (file.hunks.length > 0) return undefined;
  if (file.oldMode !== undefined && file.newMode !== undefined) {
    return t("diff.note.mode", { from: file.oldMode, to: file.newMode });
  }
  if (file.status === "renamed" || file.status === "copied") return t("diff.note.noChange");
  return t("diff.note.empty");
}

/** The key of a file in the list: its path (a path appears once in a diff). */
export function fileKey(file: GitDiffFile): string {
  return file.path;
}

/** The name of the folder, for the title of its pane: the last part of the path. */
export function diffTitle(cwd: string | undefined): string {
  if (cwd === undefined) return t("diff.pane");
  const last = cwd
    .split(/[\\/]+/)
    .filter((part) => part !== "")
    .pop();
  return t("diff.title", { folder: last ?? cwd });
}

/** What the notice says when the palette opens no diff because the pane has no folder. */
export const noFolderNotice = (): string => t("diff.open.noFolder");

/** What the notice says when the folder of the pane is not one a diff can be read in. */
export const badFolderNotice = (): string => t("diff.open.badFolder");

/** What the notice says when a tab has no room for a diff pane. */
export const diffLimitNotice = (max: number): string => t("diff.open.limit", { max });
