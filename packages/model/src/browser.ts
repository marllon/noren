// What a browser pane may show and where it sits. The page of a browser pane is a web page of
// someone else, loaded in a web view the app lays over the window, so the address is checked
// before it is saved in `state.json` and again by the Rust side (`browser_pane.rs`) before the web
// view is told to go there; keep both the same.

import { externalLinkProblem } from "./external-link";

/**
 * Why `address` cannot be the page of a browser pane, or `undefined` when it can. It must pass
 * `externalLinkProblem` (only `http://` and `https://`, no blanks, no user name, a host), and its
 * host must not be one of the app's own: the pages of the app are served from `tauri.localhost`
 * (and `ipc.localhost`, `asset.localhost`) on Windows, and a page opened there would be the app's
 * and not someone else's. Every name ending in `.localhost` is refused for that reason, as is a
 * host written with `%` escapes (the engine would read it differently from this check). `localhost`
 * itself and the numeric loopback addresses are fine: they are how a person previews what runs on
 * this machine.
 */
export function browserUrlProblem(address: string): string | undefined {
  const problem = externalLinkProblem(address);
  if (problem !== undefined) return problem;
  const host = hostOf(address);
  if (host.includes("%")) return "the address has an escaped host name";
  if (host.endsWith(".localhost")) return "the address is one of the app's own";
  return undefined;
}

/** Whether `address` passes [`browserUrlProblem`]. */
export function isBrowserUrl(address: string): boolean {
  return browserUrlProblem(address) === undefined;
}

/**
 * The host of an address that passed `externalLinkProblem`: lower case, without the port, the
 * brackets of an IPv6 address or the dot that ends a fully written name.
 */
function hostOf(address: string): string {
  const afterScheme = address.slice(address.indexOf("://") + 3);
  const authority = afterScheme.split(/[/?#]/u, 1)[0] ?? "";
  const host = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : (authority.split(":", 1)[0] ?? "");
  return host.toLowerCase().replace(/\.+$/u, "");
}

/** The longest pane id a web view is named after. */
const MAX_BROWSER_PANE_ID = 64;

/**
 * Whether `id` can name the web view of a pane: ASCII letters, digits, `-` and `_`, at most 64.
 * The id of a pane made by the app (a UUID) is one. The Rust side checks the same.
 */
export function isBrowserPaneId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_BROWSER_PANE_ID && /^[A-Za-z0-9_-]+$/u.test(id);
}

/** The most pixels, wide or high, a browser pane may be told to take. */
export const MAX_BROWSER_EXTENT = 32_768;

/**
 * Where the web view of a browser pane sits in the window: the top left corner and the size, in
 * CSS pixels, from the top left corner of the page of the window.
 */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Why `bounds` cannot be the place of a web view, or `undefined` when it can: a number that is not
 * finite, a negative width or height, or one beyond `MAX_BROWSER_EXTENT` (the position may be
 * negative, a pane scrolled partly out of view). The Rust side checks the same.
 */
export function browserBoundsProblem(bounds: BrowserBounds): string | undefined {
  for (const name of ["x", "y", "width", "height"] as const) {
    const value: unknown = bounds[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${name} is not a finite number`;
    }
  }
  if (bounds.width < 0 || bounds.height < 0) return "the size cannot be negative";
  if (bounds.width > MAX_BROWSER_EXTENT || bounds.height > MAX_BROWSER_EXTENT) {
    return "the size is too large";
  }
  if (Math.abs(bounds.x) > MAX_BROWSER_EXTENT || Math.abs(bounds.y) > MAX_BROWSER_EXTENT) {
    return "the position is too far from the window";
  }
  return undefined;
}
