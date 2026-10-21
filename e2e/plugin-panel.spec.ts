import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { answersTo, plugin, seedPlugins, statuses } from "./plugins-fixture";

// The panel of a plugin (NOR-F18-01d). The page is the web build with the fake backend, which lists
// the example plugin (examples/plugins/new-tab-action) unless a test seeds other folders; each plugin
// runs in a real Worker and its panel is a real iframe, neither of which jsdom has. What the panel
// is denied is checked from the page (it cannot read the frame) and from inside the frame (no script
// of the plugin runs).

const tree = (page: Page): Locator => page.getByRole("tree", { name: "Tabs", exact: true });
const tabs = (page: Page): Locator => tree(page).locator('[data-nr-part="item"]');
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const pluginEntries = (page: Page): Locator => palette(page).locator('[data-nr-kind="plugin"]');
const panel = (page: Page): Locator => page.locator('[data-nr-part="plugin-panel"]');
const frame = (page: Page): Locator => page.locator('iframe[data-nr-part="plugin-panel-frame"]');

/** Loads the app and waits until the terminal of the first tab is up and has the keyboard. */
async function start(page: Page): Promise<void> {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __norenTest?: { paneIds(): string[] } }).__norenTest?.paneIds()
            .length ?? 0,
      ),
    )
    .toBe(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

/** Opens the palette, finds one plugin action by its words and chooses it. */
async function choose(page: Page, query: string): Promise<void> {
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await palette(page).getByRole("combobox", { name: "Command palette", exact: true }).fill(query);
  await expect(pluginEntries(page)).toHaveCount(1);
  await expect(pluginEntries(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
}

const register = (id: string, label: string): string =>
  `globalThis.postMessage({ version: 1, id: "reg", method: "palette.register", params: { id: ${JSON.stringify(id)}, label: ${JSON.stringify(label)} } });`;

/** A plugin whose one action opens a panel with this content. */
const panelPlugin = (id: string, permissions: string[], title: string, html: string) =>
  plugin(
    id,
    permissions,
    `${register("show", `Show ${title}`)}
globalThis.onmessage = (event) => {
  if (event.data && event.data.event === "action") {
    globalThis.postMessage({ version: 1, id: "panel", method: "panel.open", params: ${JSON.stringify({ title, html })} });
  }
};`,
  );

test("the example plugin opens its panel: a frame with the content of the plugin and an opaque origin", async ({
  page,
}) => {
  await start(page);
  await expect(panel(page)).toHaveCount(0);

  await choose(page, "show the panel");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("heading", { name: "Example panel" })).toBeVisible();
  await expect(panel(page)).toContainText("Plugin · New tab action");

  // The content is the one the plugin sent, drawn inside the frame.
  const inside = page.frameLocator('iframe[data-nr-part="plugin-panel-frame"]');
  await expect(inside.getByRole("heading", { name: "Hello from the plugin" })).toBeVisible();
  await expect(inside.locator("#from-plugin")).toHaveText(
    "This panel is drawn from text the plugin sent.",
  );

  // The plugin was answered with a result for its request.
  const answers = await answersTo(page, "new-tab-action");
  expect(answers).toContainEqual({ event: "action", id: "open-panel" });
  expect(answers.at(-1)).toEqual({ version: 1, id: 3, result: { title: "Example panel" } });

  // The sandbox is empty: nothing is allowed back, above all not the origin of the app.
  const sandbox = await frame(page).getAttribute("sandbox");
  expect(sandbox).toBe("");
  expect(sandbox).not.toContain("allow-same-origin");
  expect(sandbox).not.toContain("allow-scripts");
  expect(await frame(page).getAttribute("src")).toBeNull();

  // The page cannot read the document of the frame (an opaque origin), by any road.
  const reach = await frame(page).evaluate((element) => {
    const iframe = element as HTMLIFrameElement;
    const tries: Record<string, string> = {};
    const attempt = (name: string, read: () => unknown) => {
      try {
        tries[name] = `read: ${String(read())}`;
      } catch (e) {
        tries[name] = `blocked: ${e instanceof Error ? e.name : "error"}`;
      }
    };
    attempt("contentDocument", () => iframe.contentDocument);
    attempt("contentWindow.document", () => iframe.contentWindow?.document.title);
    attempt("contentWindow.location", () => iframe.contentWindow?.location.href);
    attempt("contentWindow.name", () => iframe.contentWindow?.name);
    attempt("window.frames[0].document", () => window.frames[0]?.document.body);
    return tries;
  });
  expect(reach["contentDocument"]).toBe("read: null");
  expect(reach["contentWindow.document"]).toBe("blocked: SecurityError");
  expect(reach["contentWindow.location"]).toBe("blocked: SecurityError");
  expect(reach["window.frames[0].document"]).toBe("blocked: SecurityError");

  // And the frame cannot reach the page: its own origin is opaque.
  const origin = await inside.locator("body").evaluate(() => window.origin);
  expect(origin).toBe("null");
});

test("the panel closes with its button and with Escape, and the plugin can open it again", async ({
  page,
}) => {
  await start(page);
  await choose(page, "show the panel");
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "Close plugin panel" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(frame(page)).toHaveCount(0);

  await choose(page, "show the panel");
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "Close plugin panel" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  // The app is as it was: one tab, no dialog.
  await expect(tabs(page)).toHaveCount(1);
});

test("a plugin without the permission panel is refused, and no panel appears", async ({ page }) => {
  await seedPlugins(page, [
    panelPlugin("no-panel", ["palette.actions", "tabs.create"], "Sneaky", "<p>should not show</p>"),
  ]);
  await start(page);

  await choose(page, "show sneaky");
  await expect
    .poll(async () => (await answersTo(page, "no-panel")).filter((a) => "error" in a).length)
    .toBe(1);
  expect((await answersTo(page, "no-panel")).at(-1)).toMatchObject({
    id: "panel",
    error: { code: "permission_denied", permission: "panel" },
  });
  await page.waitForTimeout(200);
  await expect(panel(page)).toHaveCount(0);
  await expect(frame(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
});

test("the content of a panel cannot run a script, send a form or load anything", async ({
  page,
}) => {
  const html =
    '<p id="marker" style="color: rgb(200, 0, 0)">kept</p>' +
    "<script>document.getElementById('marker').textContent = 'script ran'</script>" +
    "<img src=\"x\" onerror=\"document.getElementById('marker').textContent = 'handler ran'\">" +
    '<a id="link" href="https://example.com/">link</a>' +
    '<form id="form" action="https://example.com/" method="post"><button id="send">send</button></form>' +
    '<iframe src="https://example.com/"></iframe>';
  await seedPlugins(page, [panelPlugin("hostile", ["palette.actions", "panel"], "Hostile", html)]);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  // Whatever the content asked for would find no network here either.
  await page.route("**://example.com/**", (route) => route.abort());
  await start(page);

  await choose(page, "show hostile");
  await expect(panel(page)).toBeVisible();
  const inside = page.frameLocator('iframe[data-nr-part="plugin-panel-frame"]');
  await expect(inside.locator("#marker")).toBeVisible();
  // Inline styles draw, scripts and handlers do not run.
  await expect(inside.locator("#marker")).toHaveCSS("color", "rgb(200, 0, 0)");
  await expect(inside.locator("#marker")).toHaveText("kept");

  // A form cannot be sent (the sandbox has no allow-forms) and a window cannot be opened (no
  // allow-popups); the picture and the nested frame the content asked for were not even requested
  // (its own policy lets nothing load). A link that moves the frame itself is stopped by the policy
  // of the app, which e2e/csp.spec.ts shows.
  const popups: string[] = [];
  page.on("popup", (popup) => popups.push(popup.url()));
  await inside.locator("#send").click({ force: true });
  await page.waitForTimeout(300);
  expect(popups).toEqual([]);
  expect(requests.filter((url) => url.includes("example.com"))).toEqual([]);
  expect(page.url()).not.toContain("example.com");
  await expect(inside.locator("#marker")).toHaveText("kept");
  await expect(panel(page)).toBeVisible();
});

test("a plugin that fails takes its panel with it, and the app and the other plugins go on", async ({
  page,
}) => {
  await seedPlugins(page, [
    plugin(
      "fragile",
      ["palette.actions", "panel"],
      `${register("show", "Show fragile")}
globalThis.onmessage = () => {
  globalThis.postMessage({ version: 1, id: "panel", method: "panel.open", params: { title: "Fragile", html: "<p id='f'>here</p>" } });
  setTimeout(() => { throw new Error("fragile broke"); }, 400);
};`,
    ),
    panelPlugin("steady", ["palette.actions", "panel"], "Steady", "<p>steady</p>"),
  ]);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => dialogs.push(dialog.message()));
  await start(page);

  await choose(page, "show fragile");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("heading", { name: "Fragile" })).toBeVisible();
  // The Worker throws: the panel goes and the status says why.
  await expect(panel(page)).toHaveCount(0);
  await expect
    .poll(async () => (await statuses(page)).find((s) => s.folder === "fragile")?.state)
    .toBe("failed");

  // The other plugin still works, and so does the palette.
  await choose(page, "show steady");
  await expect(panel(page).getByRole("heading", { name: "Steady" })).toBeVisible();
  expect(dialogs).toEqual([]);
  await expect(tabs(page)).toHaveCount(1);
});

test("a second panel replaces the first", async ({ page }) => {
  await seedPlugins(page, [
    panelPlugin("first", ["palette.actions", "panel"], "First", "<p>one</p>"),
    panelPlugin("second", ["palette.actions", "panel"], "Second", "<p>two</p>"),
  ]);
  await start(page);
  await choose(page, "show first");
  await expect(panel(page).getByRole("heading", { name: "First" })).toBeVisible();
  await choose(page, "show second");
  await expect(panel(page)).toHaveCount(1);
  await expect(panel(page).getByRole("heading", { name: "Second" })).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-nr-plugin", "second");
});

test("axe: the panel of the example plugin has no violation", async ({ page }) => {
  await start(page);
  await choose(page, "show the panel");
  await expect(panel(page)).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[data-nr-part="plugin-panel-frame"]')
      .getByRole("heading", { name: "Hello from the plugin" }),
  ).toBeVisible();
  // The frame is sandboxed with no script allowed, so axe cannot enter it: it checks the page around it.
  await expectNoAxeViolations(page, "plugin panel", { sandboxedFrame: true });
});
