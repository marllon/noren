// The picture behind the window: where it can come from, how it is told apart from something that is
// not a picture, and how the layers that can set it (the theme, the settings file, a space) are
// merged into the one that is shown. Pure. Reading the file is the shell's job
// (`Backend.readBackgroundImage`); `noren-core` (`background.rs`) checks the same rules again,
// since it is the side that opens the file.

/** The kinds of picture a background can be, by the extension of the file. */
export const BACKGROUND_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"] as const;

/** The longest path accepted. */
export const MAX_BACKGROUND_PATH = 1024;

/** The largest picture file read (32 MiB). */
export const MAX_BACKGROUND_BYTES = 32 * 1024 * 1024;

/** The widest blur, in pixels. */
export const MAX_BACKGROUND_BLUR = 100;

/**
 * How much of the picture shows, and how blurred it is, when nothing says. The picture is drawn
 * over the solid background of the theme, with the veil (`BACKGROUND_VEIL`) over it, so even a
 * picture at full opacity leaves the text readable.
 */
export const DEFAULT_BACKGROUND_OPACITY = 0.6;
export const DEFAULT_BACKGROUND_BLUR = 0;

/**
 * The veil: the background of the theme (dark on a dark theme, light on a light one) drawn over the
 * picture at this opacity, whatever the opacity of the picture is. It keeps the text readable on a
 * bright or busy picture.
 */
export const BACKGROUND_VEIL = 0.4;

/**
 * How opaque the panels (the sidebar, the title bar, the tab bar and the terminals) are while a
 * picture shows behind them and nothing says otherwise: they are translucent, so the picture shows
 * through them, and the sidebar blurs what it lets through.
 */
export const PICTURE_PANEL_OPACITY = 0.55;

const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;
const DRIVE_ABSOLUTE = /^[a-z]:[\\/]/i;
const DRIVE_RELATIVE = /^[a-z]:/i;

/** The extension of the last part of `path`, lower case, without the dot. */
function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Why `path` cannot be the file of a background, or `undefined` when it can. A background is a file
 * on this computer: an absolute path, or a path inside the config folder of the app (`backgrounds/sky.jpg`).
 * Web addresses and any other scheme, network paths (`\\server\share`), a path that climbs out of
 * the config folder with `..`, and anything that does not end in a picture extension are refused.
 * Whether the file exists is for whoever opens it to find out.
 */
export function backgroundImageProblem(path: string): string | undefined {
  if (path.trim() === "") return "The path of the image is empty.";
  if (path !== path.trim()) return "The path of the image starts or ends with a space.";
  if (path.length > MAX_BACKGROUND_PATH) {
    return `The path of the image is longer than ${MAX_BACKGROUND_PATH} characters.`;
  }
  // eslint-disable-next-line no-control-regex -- a control character in a path is never a file name
  if (/[\u0000-\u001f\u007f]/.test(path)) return "The path of the image has a control character.";
  if (URL_SCHEME.test(path)) {
    return "The image must be a file on this computer: web addresses and other schemes are not allowed.";
  }
  if (path.startsWith("\\\\") || path.startsWith("//")) {
    return "The image must be a file on this computer: network paths are not allowed.";
  }
  if (DRIVE_RELATIVE.test(path) && !DRIVE_ABSOLUTE.test(path)) {
    return "A path with a drive letter must start from the root of the drive, such as C:\\Pictures\\sky.png.";
  }
  const absolute = DRIVE_ABSOLUTE.test(path) || path.startsWith("/") || path.startsWith("\\");
  if (!absolute && path.split(/[\\/]/).includes("..")) {
    return "A path inside the config folder cannot climb out of it with '..'.";
  }
  const extension = extensionOf(path);
  if (!(BACKGROUND_EXTENSIONS as readonly string[]).includes(extension)) {
    return `The image must be a ${BACKGROUND_EXTENSIONS.join(", ")} file.`;
  }
  return undefined;
}

/**
 * The kind of picture the first bytes of a file are (`image/png`, `image/jpeg`, `image/webp`,
 * `image/gif`, `image/bmp`), or `undefined` when they are none of them. The bytes decide, not the
 * name of the file.
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
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
  if (startsWith([0x42, 0x4d])) return "image/bmp";
  return undefined;
}

/** A picture file as the backend hands it over. */
export interface BackgroundImageFile {
  mime: string;
  bytes: Uint8Array;
}

/**
 * What one layer says about the background. A layer may say nothing about a part: it is then left
 * to the layers under it. `image: null` says there is no picture, even where a layer under it has one.
 */
export interface BackgroundLayer {
  image?: string | null | undefined;
  opacity?: number | null | undefined;
  blur?: number | null | undefined;
}

/** The background that is shown: no picture (`image` null), or the file and how it shows. */
export interface ResolvedBackground {
  image: string | null;
  /** From 0 (not seen) to 1 (solid). */
  opacity: number;
  /** In pixels. */
  blur: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Merges the layers, the first being the lowest (the theme, then the settings file, then the
 * space): for each part the last layer that says something wins. A path that is not a usable
 * background (`backgroundImageProblem`) says nothing, so a bad path never hides a good one under it
 * and never reaches the shell. Numbers are held to their range.
 */
export function resolveBackground(
  layers: readonly (BackgroundLayer | null | undefined)[],
): ResolvedBackground {
  let image: string | null = null;
  let opacity = DEFAULT_BACKGROUND_OPACITY;
  let blur = DEFAULT_BACKGROUND_BLUR;
  for (const layer of layers) {
    if (layer === null || layer === undefined) continue;
    if (layer.image === null) image = null;
    else if (typeof layer.image === "string" && backgroundImageProblem(layer.image) === undefined) {
      image = layer.image;
    }
    if (typeof layer.opacity === "number" && Number.isFinite(layer.opacity)) {
      opacity = clamp(layer.opacity, 0, 1);
    }
    if (typeof layer.blur === "number" && Number.isFinite(layer.blur)) {
      blur = clamp(layer.blur, 0, MAX_BACKGROUND_BLUR);
    }
  }
  return { image, opacity, blur };
}
