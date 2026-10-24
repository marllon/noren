import { expect, test } from "./test";
import type { Response } from "@playwright/test";

// The page of every spec comes from apps/desktop/dist by the context (e2e/test.ts), without a TCP
// connection to the preview server (NOR-F20-15c-d). The answers say so in `x-noren-e2e: disk`.

const MARK = "x-noren-e2e";

test("the document, every script and every stylesheet of the page come from disk", async ({
  page,
}) => {
  const seen: { kind: string; url: string; mark: string | undefined }[] = [];
  const onResponse = (response: Response): void => {
    const kind = response.request().resourceType();
    if (kind !== "document" && kind !== "script" && kind !== "stylesheet") return;
    seen.push({ kind, url: response.url(), mark: response.headers()[MARK] });
  };
  page.on("response", onResponse);

  const landing = await page.goto("/");
  expect(landing?.headers()[MARK]).toBe("disk");
  // The page is up when the app drew its first part.
  await expect(page.locator("[data-nr-part]").first()).toBeVisible();
  page.off("response", onResponse);

  const scripts = seen.filter((entry) => entry.kind === "script");
  const sheets = seen.filter((entry) => entry.kind === "stylesheet");
  expect(scripts.length).toBeGreaterThan(0);
  expect(sheets.length).toBeGreaterThan(0);
  expect(seen.filter((entry) => entry.mark !== "disk")).toEqual([]);

  // Every script and every stylesheet the document names was one of those answers.
  const named = await page.evaluate(() => [
    ...Array.from(document.scripts, (script) => script.src),
    ...Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      (link) => link.href,
    ),
  ]);
  const answered = new Set(seen.map((entry) => entry.url));
  expect(named.filter((url) => url !== "" && !answered.has(url))).toEqual([]);

  // And the stylesheet took: the page has rules, not just a link to a file.
  const rules = await page.evaluate(() =>
    Array.from(document.styleSheets, (sheet) => sheet.cssRules.length),
  );
  expect(rules.length).toBeGreaterThan(0);
  expect(rules.every((count) => count > 0)).toBe(true);
});

test("a path that is no file is the page for a document, as the preview server does", async ({
  page,
}) => {
  const response = await page.goto("/no/such/path");
  expect(response?.status()).toBe(200);
  expect(response?.headers()[MARK]).toBe("disk");
  await expect(page.locator("[data-nr-part]").first()).toBeVisible();
});
