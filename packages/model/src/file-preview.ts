// What a preview pane shows: a file on this computer, read as markdown, JSON, plain text or a
// picture. The path is checked before it is saved in `state.json` and again by the Rust side
// (`noren-core`, `preview.rs`), which is the side that opens the file; keep both the same. Pure: the
// bytes come from `Backend.readFilePreview`, and `previewOf` is the same classification the Rust side
// makes, for the backends that keep their files in memory.

import { decodeUtf8 } from "./utf8";

/** The largest text file (markdown, JSON or plain) a preview reads: 1 MiB. */
export const MAX_PREVIEW_TEXT_BYTES = 1024 * 1024;

/** The largest picture file a preview reads: 10 MiB. */
export const MAX_PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024;

/** The longest path a preview pane may hold, counted in UTF-16 units. */
export const MAX_PREVIEW_PATH = 4096;

/** The pictures a preview shows, told apart by their first bytes and never by their name. */
export const PREVIEW_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type PreviewImageMime = (typeof PREVIEW_IMAGE_MIMES)[number];

/** The text kinds, decided by the extension of the file. */
export type PreviewTextKind = "markdown" | "json" | "text";

/**
 * Why a file is not shown:
 * - `relative`: the path is not a full path (it names no drive or root);
 * - `network`: the path is a network or device path (`\\server\share`, `\\?\`, `//host`), which is
 *   never opened, since opening it would reach another machine;
 * - `invalid`: the path is empty, too long or holds a control character;
 * - `directory`: the path is a folder;
 * - `missing`: nothing is there;
 * - `binary`: the file holds a NUL byte, so it is not text, and is not a picture the preview knows;
 * - `too-large`: more than `MAX_PREVIEW_TEXT_BYTES` of text or `MAX_PREVIEW_IMAGE_BYTES` of picture;
 * - `unreadable`: the system refused to read it (not a regular file, no permission, ...).
 */
export const PREVIEW_REFUSALS = [
  "relative",
  "network",
  "invalid",
  "directory",
  "missing",
  "binary",
  "too-large",
  "unreadable",
] as const;

export type PreviewRefusalReason = (typeof PREVIEW_REFUSALS)[number];

/** What `Backend.readFilePreview` answers: the file as it can be shown, or why it cannot be. */
export type FilePreview =
  | { kind: PreviewTextKind; text: string }
  | { kind: "image"; mime: PreviewImageMime; bytes: Uint8Array }
  | {
      kind: "refused";
      reason: PreviewRefusalReason;
      /** `too-large`: how many bytes the file has. */
      size?: number;
      /** `unreadable`: what the system said, as English text. */
      detail?: string;
    };

export type PreviewRefusal = Extract<FilePreview, { kind: "refused" }>;

/** What the path of a preview pane is: `ok` (a full local path), or the reason it is not one. */
export type PreviewPathKind =
  "ok" | Extract<PreviewRefusalReason, "relative" | "network" | "invalid">;

// A control character in a path is never a file name; the NUL byte would end it early in C.
// eslint-disable-next-line no-control-regex -- see above
const CONTROL = /[\u0000-\u001f\u007f]/;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;

/**
 * Whether `path` is a full path to a file on this computer, and if it is not, which way it fails. A
 * full path starts at the root (`/home/me/a.md`) or at the root of a drive (`C:\Users\me\a.md`, `C:/a`).
 * A path with a drive and no root (`C:a.md`), one that starts with one backslash (`\a.md`), and
 * anything that is not a path at all (`https://example.com/a.md`) are `relative`; two slashes or
 * two backslashes at the start are `network` (a share, a device, a verbatim path).
 */
export function classifyPreviewPath(path: string): PreviewPathKind {
  if (path.trim() === "" || path.length > MAX_PREVIEW_PATH || CONTROL.test(path)) return "invalid";
  if (path.startsWith("\\\\") || path.startsWith("//")) return "network";
  if (DRIVE_ROOT.test(path) || path.startsWith("/")) return "ok";
  return "relative";
}

/** Why `path` cannot be the file of a preview pane, or `undefined` when it can. */
export function previewPathProblem(path: string): string | undefined {
  switch (classifyPreviewPath(path)) {
    case "ok":
      return undefined;
    case "relative":
      return "the path is not a full path to a file";
    case "network":
      return "the path is a network or device path";
    case "invalid":
      return "the path is empty, too long or has a control character";
  }
}

/** Whether `path` passes [`previewPathProblem`]. */
export function isPreviewPath(path: string): boolean {
  return classifyPreviewPath(path) === "ok";
}

/** The name of the file a path points to, for the title of its pane; the whole path if it has none. */
export function previewFileName(path: string): string {
  const name = path
    .split(/[\\/]+/)
    .filter((part) => part !== "")
    .pop();
  return name ?? path;
}

/** The kind of text a file is by its name: markdown and JSON have extensions, everything else is text. */
export function previewTextKind(path: string): PreviewTextKind {
  const name = previewFileName(path);
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (["md", "markdown", "mdown", "mkd"].includes(extension)) return "markdown";
  if (extension === "json") return "json";
  return "text";
}

/** How many leading bytes tell the pictures apart. */
export const PREVIEW_SIGNATURE_BYTES = 12;

/** The picture the first bytes of a file are (png, jpeg, gif or webp), or `undefined`. */
export function sniffPreviewImage(bytes: Uint8Array): PreviewImageMime | undefined {
  const startsWith = (signature: readonly number[], offset = 0): boolean =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return undefined;
}

/** What is at a path of an in-memory file system: the bytes of a file, a folder, or nothing. */
export type PreviewEntry = Uint8Array | "directory" | undefined;

function refused(
  reason: PreviewRefusalReason,
  extra: { size?: number; detail?: string } = {},
): PreviewRefusal {
  return { kind: "refused", reason, ...extra };
}

/**
 * The preview of `path` given what is there. The same rules as the Rust side, in the same order: the
 * path, then what the path is (nothing, a folder), then the size against the limit of what the first
 * bytes say the file is, then the NUL byte, then the kind by the name. A UTF-8 byte order mark is
 * dropped and bytes that are not UTF-8 become U+FFFD.
 */
export function previewOf(path: string, entry: PreviewEntry): FilePreview {
  const pathKind = classifyPreviewPath(path);
  if (pathKind !== "ok") return refused(pathKind);
  if (entry === undefined) return refused("missing");
  if (entry === "directory") return refused("directory");
  const image = sniffPreviewImage(entry.subarray(0, PREVIEW_SIGNATURE_BYTES));
  const limit = image === undefined ? MAX_PREVIEW_TEXT_BYTES : MAX_PREVIEW_IMAGE_BYTES;
  if (entry.length > limit) return refused("too-large", { size: entry.length });
  if (image !== undefined) return { kind: "image", mime: image, bytes: entry.slice() };
  if (entry.includes(0)) return refused("binary");
  return { kind: previewTextKind(path), text: stripByteOrderMark(decodeUtf8(entry)) };
}

function stripByteOrderMark(text: string): string {
  return text.startsWith("\ufeff") ? text.slice(1) : text;
}

/**
 * `text` written with two spaces of indent and one value per line, or `undefined` when it is not
 * JSON. Only the white space between the tokens is changed: numbers keep their digits (a number
 * the page cannot hold exactly is not rounded), keys keep their order, strings are copied as they
 * are, and an empty object or array stays `{}` or `[]`.
 */
export function formatJson(text: string): string | undefined {
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  const indent = (depth: number): string => "  ".repeat(depth);
  const isSpace = (c: string | undefined): boolean =>
    c === " " || c === "\t" || c === "\n" || c === "\r";
  let out = "";
  let depth = 0;
  let at = 0;
  while (at < text.length) {
    const c = text[at] ?? "";
    if (isSpace(c)) {
      at++;
    } else if (c === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(at, end + 1);
      at = end + 1;
    } else if (c === "{" || c === "[") {
      let next = at + 1;
      while (isSpace(text[next])) next++;
      const close = c === "{" ? "}" : "]";
      if (text[next] === close) {
        out += c + close;
        at = next + 1;
      } else {
        depth++;
        out += `${c}\n${indent(depth)}`;
        at++;
      }
    } else if (c === "}" || c === "]") {
      depth--;
      out += `\n${indent(depth)}${c}`;
      at++;
    } else if (c === ",") {
      out += `,\n${indent(depth)}`;
      at++;
    } else if (c === ":") {
      out += ": ";
      at++;
    } else {
      let end = at;
      while (end < text.length && !',:]} \t\n\r"'.includes(text[end] ?? "")) end++;
      out += text.slice(at, end);
      at = end;
    }
  }
  return out;
}

// The answer of the shell is one frame: four bytes (big endian) with the length of the header, the
// header (JSON in UTF-8), and the body. The header says what the body is, and the body is the text
// or the picture, so a picture of megabytes never goes through JSON.
//   {"kind":"markdown"|"json"|"text"}                 body: the text, UTF-8
//   {"kind":"image","mime":"image/png"|...}           body: the file
//   {"kind":"refused","reason":...,"size"?,"detail"?} body: empty

const MAX_DETAIL = 500;

function isReason(value: unknown): value is PreviewRefusalReason {
  return typeof value === "string" && (PREVIEW_REFUSALS as readonly string[]).includes(value);
}

/**
 * Reads the frame the shell answered with. The page does not take the shell's word for what a body
 * is: the mime of a picture must be the one its bytes say, and a header that is not what this
 * function knows is an error.
 */
export function decodeFilePreview(frame: Uint8Array): FilePreview {
  if (frame.length < 4) throw new Error("the preview answer is too short");
  const headerLength =
    ((frame[0] ?? 0) * 0x1000000 +
      ((frame[1] ?? 0) << 16) +
      ((frame[2] ?? 0) << 8) +
      (frame[3] ?? 0)) >>>
    0;
  if (4 + headerLength > frame.length) throw new Error("the preview answer is cut short");
  let header: unknown;
  try {
    header = JSON.parse(decodeUtf8(frame.subarray(4, 4 + headerLength)));
  } catch {
    throw new Error("the preview answer has no readable header");
  }
  if (typeof header !== "object" || header === null) throw new Error("the preview header is wrong");
  const fields = header as Record<string, unknown>;
  const body = frame.subarray(4 + headerLength);
  const kind = fields["kind"];
  if (kind === "markdown" || kind === "json" || kind === "text") {
    return { kind, text: decodeUtf8(body) };
  }
  if (kind === "image") {
    const mime = sniffPreviewImage(body);
    if (mime === undefined || fields["mime"] !== mime) {
      throw new Error("the preview picture is not the kind it was said to be");
    }
    return { kind, mime, bytes: body.slice() };
  }
  if (kind === "refused") {
    const reason = fields["reason"];
    if (!isReason(reason)) throw new Error("the preview was refused for a reason unknown here");
    const size = fields["size"];
    const detail = fields["detail"];
    return refused(reason, {
      ...(typeof size === "number" && Number.isFinite(size) && size >= 0 ? { size } : {}),
      ...(typeof detail === "string" ? { detail: detail.slice(0, MAX_DETAIL) } : {}),
    });
  }
  throw new Error("the preview answer is of a kind unknown here");
}
