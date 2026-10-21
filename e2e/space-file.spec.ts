import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { configText, seedConfig } from "./settings-fixture";

// "Export space" and "Import space..." in the palette (NOR-F18-03b). Export hands the active space
// to the system as a `.noren-space.json` download, with the variables that look like secrets left
// out and named in the notice. Import reads such a file from the picker: a space is made with new
// ids and the same layout, the profiles the file brings that the user lacks are appended to
// `profiles` in `config.jsonc` (comments kept), the ones already there are not repeated and the ones
// in conflict are left out and named. A file that is not a space file says why and changes nothing.

interface Hook {
  configSaves(): number;
  paneIds(): string[];
  userProfileSessions(): { profileId: string; program: string; args: string[]; cwd: string }[];
}
type HookWindow = Window & { __norenTest?: Hook };

/** The shells the web build is told the machine has. */
const MACHINE = [
  { id: "fake", name: "Fake shell", default: true },
  { id: "git-bash", name: "Git Bash", default: false },
];

/** The settings file of the user: a comment, and two profiles of their own. */
const CONFIG = `// mine
{
  "profiles": [
    { "id": "dev", "name": "Dev", "program": "sh", "args": ["-l"] },
    { "id": "clash", "name": "Clash", "program": "mine.exe" },
  ],
}
`;

const SECRET_VALUE = "ghp_SeededSecretValue0123456789";

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const options = (page: Page): Locator => palette(page).getByRole("option");
const box = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const switcher = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const tabs = (page: Page): Locator =>
  page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem");

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const saves = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.configSaves() ?? 0);
/** Names of the space buttons, left to right (without "New space" and "Space options"). */
const spaceNames = (page: Page): Promise<string[]> =>
  switcher(page)
    .locator(".space-button:not(.space-add):not(.space-more)")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));

async function start(page: Page, config: string | null = CONFIG): Promise<void> {
  await page.addInitScript((profiles) => {
    window.localStorage.setItem("noren.web.profiles", JSON.stringify(profiles));
  }, MACHINE);
  if (config !== null) await seedConfig(page, config);
  await page.goto("/");
  await expect.poll(async () => (await paneIds(page)).length).toBe(1);
}

async function openPalette(page: Page): Promise<void> {
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
}

/** Runs the entry of the palette whose title is `title`, found by typing `query`. */
async function runEntry(page: Page, query: string, title: string): Promise<void> {
  await openPalette(page);
  await box(page).fill(`>${query}`);
  await expect(options(page).first().locator(".palette-title")).toHaveText(title);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
}

/** Makes the space the test exports: a secret and a plain variable, a tab of a profile, a split. */
async function buildSpace(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Work: API");
  await dialog
    .getByRole("textbox", { name: "Environment variables", exact: true })
    .fill(`EDITOR=vim\nGITHUB_TOKEN=${SECRET_VALUE}`);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
  await runEntry(page, "new dev tab", "New Dev tab");
  await expect(tabs(page)).toHaveCount(2);
  await runEntry(page, "split right", "Split right");
  // The active tab now holds two panes.
  await expect.poll(async () => (await paneIds(page)).length).toBe(2);
}

/** Runs "Export space" and returns the file the system was handed. */
async function exportSpaceFile(page: Page): Promise<{ name: string; text: string }> {
  // Heard from before the palette opens, so the download that follows the Enter is not missed.
  const download = page.waitForEvent("download");
  await runEntry(page, "export space", "Export space");
  const file = await download;
  const path = await file.path();
  return { name: file.suggestedFilename(), text: await readFile(path, "utf8") };
}

/** Runs "Import space..." and answers the file picker with `file`. */
async function importThrough(page: Page, file: { name: string; text: string }): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await runEntry(page, "import space", "Import space...");
  await (
    await chooser
  ).setFiles({
    name: file.name,
    mimeType: "application/json",
    buffer: Buffer.from(file.text, "utf8"),
  });
}

/** A file of a space that holds one tab, written by hand, with the profiles given. */
function handWritten(profiles: unknown[], paneProfile: string): { name: string; text: string } {
  const file = {
    format: "noren-space",
    version: 1,
    space: {
      name: "From file",
      icon: "terminal",
      color: "#6b8afd",
      modIds: [],
      aiEnabled: false,
      saveScrollback: false,
      defaults: { env: {} },
      pinned: [],
      tree: [{ kind: "item", id: "i1" }],
      items: [
        {
          id: "i1",
          focusedPaneId: "p1",
          layout: {
            kind: "pane",
            pane: { id: "p1", type: "terminal", profileId: paneProfile },
          },
        },
      ],
      activeItemId: "i1",
    },
    profiles,
  };
  return { name: "from-file.noren-space.json", text: `${JSON.stringify(file, null, 2)}\n` };
}

test("Export space hands the active space to the system as a file with the secrets left out", async ({
  page,
}) => {
  await start(page);
  await buildSpace(page);

  const file = await exportSpaceFile(page);
  // The name of the space, with the colon (not allowed in a file name) replaced.
  expect(file.name).toBe("Work- API.noren-space.json");
  const parsed = JSON.parse(file.text) as {
    format: string;
    version: number;
    space: {
      name: string;
      defaults: { env: Record<string, string> };
      items: { layout: { kind: string } }[];
    };
    profiles: { id: string }[];
  };
  expect(parsed.format).toBe("noren-space");
  expect(parsed.version).toBe(1);
  expect(parsed.space.name).toBe("Work: API");
  expect(parsed.space.items).toHaveLength(2);
  // The plain variable is in; the secret is out, by its name and by its value.
  expect(parsed.space.defaults.env).toEqual({ EDITOR: "vim" });
  expect(file.text).not.toContain(SECRET_VALUE);
  expect(file.text).not.toContain("GITHUB_TOKEN");
  // The profile the space uses comes along; the one it does not use does not.
  expect(parsed.profiles.map((profile) => profile.id)).toEqual(["dev"]);

  await expect(notice(page)).toHaveText(
    'Exported space "Work: API" as Work- API.noren-space.json. Left out because they look like secrets: variables GITHUB_TOKEN.',
  );
  // Exporting changes nothing: no space was made and the settings were not written.
  expect(await spaceNames(page)).toEqual(["Main", "Work: API"]);
  expect(await saves(page)).toBe(0);
});

test("Import space makes a new space with the same layout and new ids, and exporting it again gives the same file", async ({
  page,
}) => {
  await start(page);
  await buildSpace(page);
  const before = await paneIds(page);
  // The rows of the tree of tabs: two tabs, and the two panes of the one that was split.
  const rows = await tabs(page).count();
  const file = await exportSpaceFile(page);

  await importThrough(page, file);
  await expect(notice(page)).toHaveText('Imported space "Work: API".');
  expect(await spaceNames(page)).toEqual(["Main", "Work: API", "Work: API"]);
  // The new space is the active one and has the same tabs and panes.
  await expect(tabs(page)).toHaveCount(rows);

  // Same layout (the tab that was active holds two panes again), every pane with an id of its own:
  // none of the panes of the first space is reused.
  await expect.poll(async () => (await paneIds(page)).length).toBe(2);
  const after = await paneIds(page);
  expect(after.filter((id) => before.includes(id))).toEqual([]);

  // The file of the imported space is the file it came from (the ids in a file are its own).
  const again = await exportSpaceFile(page);
  expect(again.text).toBe(file.text);

  // The profile it uses was already there as it is: nothing was written to the settings.
  expect(await saves(page)).toBe(0);
  expect(await configText(page)).toBe(CONFIG);
});

test("Import space appends the new profiles to config.jsonc, reuses the same one and names the ones in conflict", async ({
  page,
}) => {
  await start(page);
  const file = handWritten(
    [
      { id: "newbie", name: "Newbie", program: "nb.exe", args: ["-x"] },
      { id: "dev", name: "Dev", program: "sh", args: ["-l"] },
      { id: "clash", name: "Clash", program: "theirs.exe" },
      { id: "git-bash", name: "Git Bash", program: "bash" },
    ],
    "newbie",
  );

  await importThrough(page, file);
  await expect(notice(page)).toHaveText(
    'Imported space "From file". Added to config.jsonc: "Newbie". ' +
      'Not added: "Clash" (you already have a different profile with the id clash); ' +
      '"Git Bash" (the id git-bash is a shell of this machine). ' +
      "The space keeps using the profile with that id.",
  );
  expect(await spaceNames(page)).toEqual(["Main", "From file"]);

  // One write, the comment where it was, the new profile after the user's own ones; none repeated.
  expect(await saves(page)).toBe(1);
  const text = (await configText(page)) ?? "";
  expect(text.startsWith("// mine\n{")).toBe(true);
  const written = JSON.parse(text.replace(/\/\/[^\n]*/g, "").replace(/,(\s*[}\]])/g, "$1")) as {
    profiles: { id: string; name: string; program: string; args?: string[] }[];
  };
  expect(written.profiles).toEqual([
    { id: "dev", name: "Dev", program: "sh", args: ["-l"] },
    { id: "clash", name: "Clash", program: "mine.exe" },
    { id: "newbie", name: "Newbie", program: "nb.exe", args: ["-x"] },
  ]);
  expect(text).not.toContain("theirs.exe");

  // The pane of the new space started the new profile: the backend knew it by then.
  await expect
    .poll(async () =>
      (
        await page.evaluate(() => (window as HookWindow).__norenTest?.userProfileSessions() ?? [])
      ).map(({ profileId, program, args }) => ({ profileId, program, args })),
    )
    .toEqual([{ profileId: "newbie", program: "nb.exe", args: ["-x"] }]);
  await openPalette(page);
  await box(page).fill(">new newbie");
  await expect(options(page).first().locator(".palette-title")).toHaveText("New Newbie tab");
  await page.keyboard.press("Escape");
});

test("a file that is not a space file says why, makes no space and writes nothing", async ({
  page,
}) => {
  await start(page);
  const valid = handWritten([], "fake");
  const changed = (change: (file: Record<string, unknown>) => void): string => {
    const file = JSON.parse(valid.text) as Record<string, unknown>;
    change(file);
    return JSON.stringify(file);
  };

  await importThrough(page, { name: "notes.txt", text: "hello" });
  await expect(notice(page)).toHaveText('Could not import "notes.txt": it is not valid JSON');

  await importThrough(page, {
    name: "other.noren-space.json",
    text: changed((file) => {
      file["version"] = 2;
    }),
  });
  await expect(notice(page)).toHaveText(
    'Could not import "other.noren-space.json": version 2 is not one this build reads (it reads version 1)',
  );

  await importThrough(page, {
    name: "extra.noren-space.json",
    text: changed((file) => {
      file["sessions"] = [];
    }),
  });
  await expect(notice(page)).toContainText('Could not import "extra.noren-space.json": ');

  await importThrough(page, { name: "list.json", text: "[]" });
  await expect(notice(page)).toHaveText(
    'Could not import "list.json": it is not a Noren space file',
  );

  expect(await spaceNames(page)).toEqual(["Main"]);
  expect(await saves(page)).toBe(0);
  expect(await configText(page)).toBe(CONFIG);
});

test("when the profiles cannot be written to config.jsonc nothing is imported", async ({
  page,
}) => {
  // A settings file with a problem of its own is not edited, so the space is not made either.
  const broken = '{ "appearance": { "tabs": 5 } }';
  await start(page, broken);
  await importThrough(
    page,
    handWritten([{ id: "newbie", name: "Newbie", program: "nb.exe" }], "newbie"),
  );
  await expect(notice(page)).toContainText(
    "The profiles could not be added to config.jsonc, so nothing was imported: ",
  );
  expect(await spaceNames(page)).toEqual(["Main"]);
  expect(await configText(page)).toBe(broken);
});
