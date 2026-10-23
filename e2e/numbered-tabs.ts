import type { Page } from "@playwright/test";

/**
 * Makes the fake shells of the page keep quiet about their folder (NOR-F20-12). A tab with no title is
 * named after the folder its shell reports, and every fresh fake shell starts in the same one, so the
 * tabs of a test would all read `~` and could not be told apart by name. The tests that are about
 * something else than the name of a tab call this in `test.beforeEach`: their tabs then keep their
 * numbers (`Tab 1`, `Tab 2`), as the tabs of a shell with no integration do. The tests of the name
 * itself (`tab-names.spec.ts`, `command-meta.spec.ts`) do not call it.
 */
export async function numberTheTabs({ page }: { page: Page }): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("noren.web.folder-report", "off");
  });
}
