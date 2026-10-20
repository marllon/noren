import {
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_PREVIEW_TEXT_BYTES,
  formatJson,
  previewFileName,
} from "@noren/model";
import type {
  Backend,
  FilePreview,
  OutputPathProblem,
  PreviewImageMime,
  PreviewRefusal,
} from "@noren/model";
import { t } from "./i18n";

// What a preview pane draws, decided apart from React: the state of the read, and for each answer of
// the backend the one thing the pane shows (formatted JSON, a warning for JSON that is not, the
// reason a file is refused, in the language in force). The pane (`PreviewPane.tsx`) only draws it.

/** What a preview pane needs of the backend. */
export type PreviewReader = Pick<Backend, "readFilePreview">;

/** Where the read of a file is: on its way, answered, or failed (the shell itself, not the file). */
export type PreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: FilePreview }
  | { status: "failed"; reason: string };

/** Reads `path`; a failure of the shell becomes a state, so the pane never throws. */
export async function loadPreview(reader: PreviewReader, path: string): Promise<PreviewState> {
  try {
    return { status: "ready", preview: await reader.readFilePreview(path) };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A size in bytes the way a person reads it: `320 B`, `1.5 KiB`, `2 MiB`. A size is rounded up, so
 * a file a byte over a limit is never written as the limit itself.
 */
export function formatBytes(size: number): string {
  const unit = (value: number, name: string): string =>
    `${(Math.ceil(value * 10) / 10).toFixed(1).replace(/\.0$/, "")} ${name}`;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return unit(size / 1024, "KiB");
  return unit(size / (1024 * 1024), "MiB");
}

/** Why a file is not shown, in the language in force. */
export function refusalText(refusal: PreviewRefusal): string {
  switch (refusal.reason) {
    case "relative":
      return t("preview.refused.relative");
    case "network":
      return t("preview.refused.network");
    case "invalid":
      return t("preview.refused.invalid");
    case "directory":
      return t("preview.refused.directory");
    case "missing":
      return t("preview.refused.missing");
    case "binary":
      return t("preview.refused.binary");
    case "too-large": {
      const limits = {
        textLimit: formatBytes(MAX_PREVIEW_TEXT_BYTES),
        imageLimit: formatBytes(MAX_PREVIEW_IMAGE_BYTES),
      };
      return refusal.size !== undefined
        ? t("preview.refused.tooLarge", { size: formatBytes(refusal.size), ...limits })
        : t("preview.refused.tooLargeBare", limits);
    }
    case "unreadable":
      return refusal.detail !== undefined && refusal.detail !== ""
        ? t("preview.refused.unreadable", { reason: refusal.detail })
        : t("preview.refused.unreadableBare");
  }
}

/** The one thing a preview pane draws. */
export type PreviewContent =
  | { type: "loading" }
  | { type: "empty" }
  | { type: "markdown"; text: string }
  /** Plain text, or JSON written out; `warning` says the file was meant to be JSON and is not. */
  | { type: "text"; text: string; warning?: string }
  | { type: "image"; mime: PreviewImageMime }
  | { type: "refused"; reason: PreviewRefusal["reason"]; message: string }
  | { type: "failed"; message: string };

/** What the pane draws for a state of the read. */
export function contentOf(state: PreviewState): PreviewContent {
  if (state.status === "loading") return { type: "loading" };
  if (state.status === "failed") {
    return { type: "failed", message: t("preview.failed", { reason: state.reason }) };
  }
  const { preview } = state;
  switch (preview.kind) {
    case "refused":
      return { type: "refused", reason: preview.reason, message: refusalText(preview) };
    case "image":
      return { type: "image", mime: preview.mime };
    case "markdown":
      return preview.text === "" ? { type: "empty" } : { type: "markdown", text: preview.text };
    case "json": {
      if (preview.text.trim() === "") return { type: "empty" };
      const formatted = formatJson(preview.text);
      return formatted !== undefined
        ? { type: "text", text: formatted }
        : { type: "text", text: preview.text, warning: t("preview.jsonInvalid") };
    }
    case "text":
      return preview.text === "" ? { type: "empty" } : { type: "text", text: preview.text };
  }
}

/** The name of the file a path points to, for the title of its pane. */
export function previewTitle(path: string | undefined): string {
  return path === undefined ? t("preview.pane") : previewFileName(path);
}

/** What the notice says when a Ctrl+clicked path of the output opens no preview, and why. */
export function openPathNotice(problem: OutputPathProblem): string {
  switch (problem) {
    case "no-folder":
      return t("preview.open.noFolder");
    case "network":
      return t("preview.open.network");
    case "invalid":
      return t("preview.open.invalid");
  }
}

/** What the notice says when a tab has no room for the preview of a path. */
export const previewLimitNotice = (max: number): string => t("preview.open.limit", { max });
