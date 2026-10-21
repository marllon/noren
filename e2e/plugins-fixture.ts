import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

// Plugin folders for the e2e tests (NOR-F18-01c): what `listPlugins` of the web backend answers,
// seeded in the browser storage before the page loads. The example is read from the files of
// examples/plugins, so the test runs what the repository ships.

export const WEB_PLUGINS_KEY = "noren.web.plugins";

export interface PluginSeed {
  folder: string;
  manifest?: string;
  main?: string;
  error?: string;
}

const exampleFile = (name: string): string =>
  readFileSync(
    new URL(`../examples/plugins/new-tab-action/${name}`, import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");

/** The example plugin, exactly as the files in examples/plugins hold it. */
export const EXAMPLE: PluginSeed = {
  folder: "new-tab-action",
  manifest: exampleFile("plugin.json"),
  main: exampleFile("main.js"),
};

/** A folder with a valid manifest for `id`, asking for `permissions`, running `main`. */
export function plugin(id: string, permissions: string[], main: string): PluginSeed {
  return {
    folder: id,
    manifest: JSON.stringify({
      id,
      name: `Fixture ${id}`,
      version: "1.0.0",
      apiVersion: 1,
      main: "main.js",
      permissions,
    }),
    main,
  };
}

/** Makes the web backend list these folders instead of the example plugin. */
export async function seedPlugins(page: Page, folders: PluginSeed[]): Promise<void> {
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: WEB_PLUGINS_KEY,
    value: JSON.stringify(folders),
  });
}

export interface Traffic {
  pluginId: string;
  direction: "from-plugin" | "to-plugin";
  message: Record<string, unknown>;
}

type PluginHook = {
  pluginTraffic(): Traffic[];
  pluginStatus(): { folder: string; state: string; reason?: string }[];
};
type PluginWindow = Window & { __norenTest?: PluginHook };

/** What the plugins and the app said to each other so far (the test hook). */
export const traffic = (page: Page): Promise<Traffic[]> =>
  page.evaluate(() => (window as PluginWindow).__norenTest?.pluginTraffic() ?? []);

/** The messages the app posted to one plugin: the answers to its requests and the actions chosen. */
export async function answersTo(page: Page, pluginId: string): Promise<Record<string, unknown>[]> {
  return (await traffic(page))
    .filter((entry) => entry.pluginId === pluginId && entry.direction === "to-plugin")
    .map((entry) => entry.message);
}

export const statuses = (page: Page) =>
  page.evaluate(() => (window as PluginWindow).__norenTest?.pluginStatus() ?? []);
