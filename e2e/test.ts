import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";
import type { Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";

// Every spec imports `test` and `expect` from here instead of "@playwright/test". The page under
// test is a static build, so the context hands it its own files straight from `apps/desktop/dist`
// (NOR-F20-15c-d) instead of asking the `vite preview` server for each one over TCP. A run of the
// suite opened about 12000 connections to that server in six minutes, and Windows refused some of
// them (`net::ERR_ADDRESS_IN_USE`): the page then had no stylesheet or no script and the test fell
// for a reason that has nothing to do with what it checks. Nothing a test asserts changes; every
// answer carries `x-noren-e2e: disk`, so a spec can tell that the page came from here.
// What no file answers (a missing asset, a request that is not a plain GET) and what a spec routes
// itself (`route.continue()`, `route.fetch()`) still goes to the server of the config.

const DIST = resolve(fileURLToPath(new URL("../apps/desktop/dist", import.meta.url)));

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
};

/** The file of `dist` that a path names, or undefined when it is not one (or leaves the folder). */
async function fileOf(pathname: string): Promise<{ body: Buffer; type: string } | undefined> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const target = resolve(DIST, `.${relative.endsWith("/") ? `${relative}index.html` : relative}`);
  if (target !== DIST && !target.startsWith(DIST + sep)) return undefined;
  try {
    const type = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    return { body: await readFile(target), type };
  } catch {
    return undefined;
  }
}

/** Makes the context answer the requests for the origin of `baseURL` from `apps/desktop/dist`. */
export async function serveFromDisk(
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<BrowserContext> {
  if (baseURL === undefined) return context;
  const origin = new URL(baseURL).origin;
  await context.route(
    (url) => url.origin === origin,
    async (route) => {
      const request = route.request();
      if (request.method() !== "GET") return route.continue();
      const found =
        (await fileOf(new URL(request.url()).pathname)) ??
        // As `vite preview` does: a path that is no file is the page itself, for a document.
        (request.resourceType() === "document" ? await fileOf("/index.html") : undefined);
      if (found === undefined) return route.continue();
      return route.fulfill({
        status: 200,
        body: found.body,
        headers: { "content-type": found.type, "x-noren-e2e": "disk" },
      });
    },
  );
  return context;
}

/** A context of a spec's own (`browser.newContext`), served from disk like the one of `page`. */
export async function newServedContext(
  browser: Browser,
  baseURL: string | undefined,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...options,
  });
  return serveFromDisk(context, baseURL);
}

export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    await serveFromDisk(context, baseURL);
    await use(context);
  },
});

export { expect };
