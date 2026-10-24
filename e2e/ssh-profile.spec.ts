import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import {
  closeSettings,
  configSaveCount,
  configText,
  openSettings,
  quiet,
  seedConfig,
} from "./settings-fixture";
import { numberTheTabs } from "./numbered-tabs";
import { openCommandPalette } from "./palette-fixture";

test.beforeEach(numberTheTabs);

// Profiles of kind ssh (a shell in a norend on another machine), on the fake backend: the profiles
// screen creates, edits and removes them, a tab of one shows the state of its connection (nothing
// while it is up, the attempt while it reconnects, the reason and Try again once it gave up), and
// the same states reach the bar of the top tabs. The connection is broken and mended by the test
// through the hook (`setProfileLink`), the way the real backend tells it with `session-link`.

interface SshSession {
  id: number;
  profileId: string;
  ssh: {
    host: string;
    user?: string;
    port?: number;
    identityFile?: string;
    knownHostsFile?: string;
  };
  link: string;
}
interface Hook {
  paneIds(): string[];
  sshSessions(): SshSession[];
  setProfileLink(
    profileId: string,
    link: {
      state: "connected" | "reconnecting" | "failed";
      attempt?: number;
      maxAttempts?: number;
      retryInMs?: number;
      reason?: string;
    },
  ): void;
  retriedSessions(): number[];
  sessionStarts(): { profileId?: string; cwd?: string; env?: Record<string, string> }[];
}
type HookWindow = Window & { __norenTest?: Hook };

const BOX = {
  kind: "ssh",
  id: "build-box",
  name: "Build box",
  host: "build.example.org",
  user: "deploy",
  port: 2222,
};
const CONFIG = JSON.stringify({ profiles: [BOX] });
const TOP_TABS = JSON.stringify({ profiles: [BOX], appearance: { tabs: "top" } });

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const options = (page: Page): Locator => palette(page).getByRole("option");
const paletteBox = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });
const tree = (page: Page): Locator => page.getByRole("tree", { name: "Tabs", exact: true });
const bar = (page: Page): Locator => page.locator('[data-nr-part="tabbar"]');
const links = (page: Page): Locator => page.locator('[data-nr-part="item-link"]');
const sshSessions = (page: Page): Promise<SshSession[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sshSessions() ?? []);
const retried = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.retriedSessions() ?? []);

type Link = Parameters<Hook["setProfileLink"]>[1];
const setLink = (page: Page, link: Link): Promise<void> =>
  page.evaluate(
    (next) => (window as HookWindow).__norenTest?.setProfileLink("build-box", next),
    link,
  );

async function start(page: Page, config: string = CONFIG): Promise<void> {
  await seedConfig(page, config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

/** Opens a tab of the profile "Build box" from the command palette. */
async function openBuildBox(page: Page): Promise<void> {
  const before = (await sshSessions(page)).length;
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await openCommandPalette(page);
  await expect(palette(page)).toBeVisible();
  await paletteBox(page).fill(">new build box");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveText(/New Build box tab/);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect.poll(async () => (await sshSessions(page)).length).toBe(before + 1);
}

test.describe("the connection of a tab of an ssh profile in the sidebar", () => {
  test("shows nothing while it is up, the attempt while it reconnects and nothing again once it is back", async ({
    page,
  }) => {
    await start(page);
    await openBuildBox(page);
    const tab = tree(page).getByRole("treeitem", { name: "Tab 2", exact: true });
    const row = page
      .locator("li")
      .filter({ has: page.getByRole("treeitem", { name: "Tab 2", exact: true }) });
    await expect(tab).toBeVisible();
    await expect(links(page)).toHaveCount(0);

    await setLink(page, {
      state: "reconnecting",
      attempt: 3,
      maxAttempts: 10,
      retryInMs: 5000,
    });
    await expect(row.locator('[data-nr-part="item-link"]')).toHaveText(
      "Reconnecting, attempt 3 of 10. What you type is not sent.",
    );
    await expect(row.locator('[data-nr-part="item-link"]')).toHaveAttribute(
      "data-nr-link-state",
      "reconnecting",
    );
    // It is the ssh tab alone: the local tab has no line and nothing else on the page does.
    await expect(links(page)).toHaveCount(1);
    await expect(
      page
        .locator("li")
        .filter({ has: page.getByRole("treeitem", { name: "Tab 1", exact: true }) })
        .locator('[data-nr-part="item-link"]'),
    ).toHaveCount(0);
    // Assistive technology gets the same sentence as the description of the tab.
    await expect(tab).toHaveAccessibleDescription(
      /Reconnecting, attempt 3 of 10\. What you type is not sent\./,
    );
    // No button to press while it still tries on its own.
    await expect(row.getByRole("button", { name: /Try again/ })).toHaveCount(0);

    // The next attempt replaces the sentence.
    await setLink(page, { state: "reconnecting", attempt: 4, maxAttempts: 10, retryInMs: 5000 });
    await expect(links(page)).toHaveText(
      "Reconnecting, attempt 4 of 10. What you type is not sent.",
    );

    await setLink(page, { state: "connected" });
    await expect(links(page)).toHaveCount(0);
    await expect(tab).toHaveAccessibleDescription("");
  });

  test("tells the reason once it failed, and Try again asks the backend, shows the new attempt and clears when it is back", async ({
    page,
  }) => {
    await start(page);
    await openBuildBox(page);
    const [session] = await sshSessions(page);
    expect(session?.link).toBe("connected");

    await setLink(page, { state: "failed", reason: "Permission denied (publickey)." });
    await expect(links(page)).toHaveText(/Connection failed: Permission denied \(publickey\)\./);
    await expect(links(page)).toHaveAttribute("data-nr-link-state", "failed");
    expect((await sshSessions(page))[0]?.link).toBe("failed");
    expect(await retried(page)).toEqual([]);

    const retry = page.getByRole("button", { name: "Try again: Tab 2", exact: true });
    await expect(retry).toBeVisible();
    await expect(retry).toHaveText("Try again");
    await retry.click();

    // The call went to the backend for this session, and the state that follows is its own.
    await expect.poll(() => retried(page)).toEqual([session?.id]);
    await expect(links(page)).toHaveText(
      /Reconnecting, attempt 1 of 20\. What you type is not sent\./,
    );
    await expect(links(page)).toHaveAttribute("data-nr-link-state", "reconnecting");
    await expect(retry).toHaveCount(0);

    await setLink(page, { state: "connected" });
    await expect(links(page)).toHaveCount(0);
    expect((await sshSessions(page))[0]?.link).toBe("connected");
    // One press, one call.
    expect(await retried(page)).toEqual([session?.id]);
  });

  test("breaks every tab of the profile at once, each with its own button", async ({ page }) => {
    await start(page);
    await openBuildBox(page);
    await openBuildBox(page);
    await setLink(page, { state: "failed", reason: "Connection timed out" });
    await expect(links(page)).toHaveCount(2);
    await expect(page.getByRole("button", { name: /^Try again: / })).toHaveCount(2);

    const sessions = await sshSessions(page);
    await page.getByRole("button", { name: "Try again: Tab 3", exact: true }).click();
    await expect.poll(() => retried(page)).toEqual([sessions[1]?.id]);
    await expect(links(page)).toHaveCount(2);
    await expect(page.getByRole("button", { name: /^Try again: / })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Try again: Tab 2", exact: true })).toBeVisible();

    await setLink(page, { state: "connected" });
    await expect(links(page)).toHaveCount(0);
  });

  test("keeps the line of a tab when another tab opens", async ({ page }) => {
    await start(page);
    await openBuildBox(page);
    await setLink(page, { state: "reconnecting", attempt: 2, maxAttempts: 10 });
    await expect(links(page)).toHaveCount(1);
    // Another tab opening or closing does not touch it.
    await page.getByRole("button", { name: "New tab", exact: true }).first().click();
    await expect(tree(page).getByRole("treeitem")).toHaveCount(3);
    await expect(links(page)).toHaveCount(1);
    await expect(links(page)).toContainText("attempt 2 of 10");
  });
});

test.describe("the connection of a tab of an ssh profile in the bar of the top tabs", () => {
  test("shows a few words in the tab, the full sentence as its description, and Try again after a failure", async ({
    page,
  }) => {
    await start(page, TOP_TABS);
    await openBuildBox(page);
    await expect(bar(page).getByRole("tab", { name: "Tab 2", exact: true })).toBeVisible();
    const tab = bar(page).getByRole("tab", { name: "Tab 2", exact: true });
    await expect(links(page)).toHaveCount(0);

    await setLink(page, { state: "reconnecting", attempt: 3, maxAttempts: 10 });
    await expect(tab.locator('[data-nr-part="item-link"]')).toHaveText("Reconnecting 3/10");
    await expect(tab).toHaveAccessibleDescription(
      /Reconnecting, attempt 3 of 10\. What you type is not sent\./,
    );
    await expect(links(page)).toHaveCount(1);
    await expect(
      bar(page)
        .getByRole("tab", { name: "Tab 1", exact: true })
        .locator('[data-nr-part="item-link"]'),
    ).toHaveCount(0);

    await setLink(page, { state: "failed", reason: "Host key verification failed." });
    await expect(tab.locator('[data-nr-part="item-link"]')).toHaveText("Failed");
    await expect(tab).toHaveAccessibleDescription(
      /Connection failed: Host key verification failed\./,
    );
    const retry = bar(page).getByRole("button", { name: "Try again: Tab 2", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(tab.locator('[data-nr-part="item-link"]')).toHaveText("Reconnecting 1/20");
    await expect(retry).toHaveCount(0);

    await setLink(page, { state: "connected" });
    await expect(links(page)).toHaveCount(0);
  });
});

const field = (fieldset: Locator, name: string): Locator =>
  fieldset.getByRole("textbox", { name, exact: true });
const profileBox = (screen: Locator, name: string): Locator =>
  screen.getByRole("group", { name, exact: true });

test.describe("the profiles screen with ssh profiles", () => {
  test("creates a profile of kind ssh that is listed and opens a tab of kind ssh", async ({
    page,
  }) => {
    await start(page, "{}");
    const screen = await openSettings(page);
    await screen.getByRole("button", { name: "Add SSH profile", exact: true }).click();
    const box = profileBox(screen, "New profile 1");
    await expect(box).toBeVisible();
    // The boxes of the machine, and of the shell there; no box for a password or the text of a key.
    await expect(box.getByRole("textbox")).toHaveCount(9);
    await expect(box.getByLabel(/password|passphrase|private key/i)).toHaveCount(0);

    await field(box, "Name").fill("Staging");
    await field(box, "Host").fill("staging.example.org");
    await field(box, "User (optional)").fill("deploy");
    await field(box, "Port (optional)").fill("2222");
    await field(box, "Key file (optional)").fill("C:\\keys\\id_ed25519");
    await field(box, "Known hosts file (optional)").fill("C:\\keys\\known_hosts");
    // The row is complete but the person is still in it: a new profile is written when they leave it,
    // because its id is made from its name.
    await quiet(page);
    expect(await configSaveCount(page)).toBe(0);
    await closeSettings(page);
    expect(await configSaveCount(page)).toBe(1);

    const text = (await configText(page)) ?? "";
    const written = JSON.parse(text) as { profiles: Record<string, unknown>[] };
    expect(written.profiles).toEqual([
      {
        kind: "ssh",
        id: "staging",
        name: "Staging",
        host: "staging.example.org",
        user: "deploy",
        port: 2222,
        identityFile: "C:\\keys\\id_ed25519",
        knownHostsFile: "C:\\keys\\known_hosts",
      },
    ]);
    expect(text).not.toMatch(/password|passphrase/i);

    // It is in the list of the palette and opens a tab whose session is the ssh kind, on that machine.
    await page.locator('[data-nr-part="pane"]:visible').first().click();
    await openCommandPalette(page);
    await paletteBox(page).fill(">new staging");
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toHaveText(/New Staging tab/);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeHidden();
    await expect.poll(async () => (await sshSessions(page)).length).toBe(1);
    const [session] = await sshSessions(page);
    expect(session).toMatchObject({
      profileId: "staging",
      link: "connected",
      ssh: {
        host: "staging.example.org",
        user: "deploy",
        port: 2222,
        identityFile: "C:\\keys\\id_ed25519",
        knownHostsFile: "C:\\keys\\known_hosts",
      },
    });
  });

  test("lists a profile of the file with its boxes, changes one box and writes only that", async ({
    page,
  }) => {
    await start(page, `// keep me\n${JSON.stringify({ profiles: [BOX] }, null, 2)}\n`);
    const screen = await openSettings(page);
    const box = profileBox(screen, "Build box");
    await expect(field(box, "Host")).toHaveValue("build.example.org");
    await expect(field(box, "User (optional)")).toHaveValue("deploy");
    await expect(field(box, "Port (optional)")).toHaveValue("2222");
    await expect(field(box, "Key file (optional)")).toHaveValue("");
    // Nothing changed yet: nothing is written.
    await quiet(page);
    expect(await configSaveCount(page)).toBe(0);

    await field(box, "Port (optional)").fill("22");
    await expect.poll(() => configSaveCount(page)).toBe(1);
    await field(box, "Key file (optional)").fill("C:\\keys\\id_ed25519");
    await expect.poll(() => configSaveCount(page)).toBe(2);
    await closeSettings(page);
    const text = (await configText(page)) ?? "";
    expect(text).toContain("// keep me");
    const written = JSON.parse(text.replace("// keep me\n", "")) as {
      profiles: Record<string, unknown>[];
    };
    expect(written.profiles).toEqual([{ ...BOX, port: 22, identityFile: "C:\\keys\\id_ed25519" }]);
  });

  test("refuses an invalid edit, says which box and why, writes nothing for it and goes on when it is fixed", async ({
    page,
  }) => {
    await start(page);
    const screen = await openSettings(page);
    const box = profileBox(screen, "Build box");

    await field(box, "Port (optional)").fill("abc");
    await expect(box.getByRole("alert")).toHaveText("Must be a whole number");
    await expect(field(box, "Port (optional)")).toHaveAttribute("aria-invalid", "true");

    await field(box, "Port (optional)").fill("70000");
    await expect(box.getByRole("alert")).toHaveText("Must be at most 65535");

    await field(box, "Port (optional)").fill("2222");
    await field(box, "Host").fill("");
    await expect(box.getByRole("alert")).toHaveText("The host is empty");

    await field(box, "Host").fill("-oProxyCommand=evil");
    await expect(box.getByRole("alert")).toContainText("not starting with");
    // Not one of the wrong values was written, and the port put back where the file has it is no change.
    await quiet(page);
    expect(await configSaveCount(page)).toBe(0);
    expect(JSON.parse((await configText(page)) ?? "{}")).toEqual({ profiles: [BOX] });

    await field(box, "Host").fill("build2.example.org");
    await expect(box.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => configSaveCount(page)).toBe(1);
    await closeSettings(page);
    expect(JSON.parse((await configText(page)) ?? "{}")).toEqual({
      profiles: [{ ...BOX, host: "build2.example.org" }],
    });
  });

  test("a new ssh profile with a box wrong is not written, and an empty one is left out", async ({
    page,
  }) => {
    await start(page, "{}");
    const screen = await openSettings(page);
    await screen.getByRole("button", { name: "Add SSH profile", exact: true }).click();
    // Empty: nothing to write.
    await quiet(page);
    expect(await configSaveCount(page)).toBe(0);
    const box = profileBox(screen, "New profile 1");
    await field(box, "Name").fill("Half");
    // A name and no host.
    await expect(box.getByRole("alert")).toHaveText("The host is empty");
    await quiet(page);
    expect(await configSaveCount(page)).toBe(0);
    await closeSettings(page);
    expect(await configText(page)).toBe("{}");
    expect(await configSaveCount(page)).toBe(0);
  });

  test("removes a profile of kind ssh, and it leaves the palette", async ({ page }) => {
    await start(page);
    const screen = await openSettings(page);
    await profileBox(screen, "Build box")
      .getByRole("button", { name: "Remove profile", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Remove this profile?", exact: true })
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(profileBox(screen, "Build box")).toHaveCount(0);
    await expect.poll(() => configSaveCount(page)).toBe(1);
    await closeSettings(page);
    expect(JSON.parse((await configText(page)) ?? "{}")).toEqual({ profiles: [] });

    await page.locator('[data-nr-part="pane"]:visible').first().click();
    await openCommandPalette(page);
    await paletteBox(page).fill(">new build box");
    await expect(options(page)).toHaveCount(0);
  });

  test("keeps a profile of kind ssh in the file when only a shell profile is edited next to it", async ({
    page,
  }) => {
    const shell = { id: "dev", name: "Dev", program: "pwsh.exe" };
    await start(page, JSON.stringify({ profiles: [shell, BOX] }));
    const screen = await openSettings(page);
    await field(profileBox(screen, "Dev"), "Program").fill("bash");
    // The shell row has no box of the machine.
    await expect(profileBox(screen, "Dev").getByRole("textbox", { name: "Host" })).toHaveCount(0);
    await closeSettings(page);
    expect(JSON.parse((await configText(page)) ?? "{}")).toEqual({
      profiles: [{ ...shell, program: "bash" }, BOX],
    });
  });
});
