import { defineConfig, devices } from "@playwright/test";
import { playwrightWorkers } from "../scripts/game-mode.mjs";

const port = Number(process.env["NOREN_E2E_PORT"] ?? 4791);
const url = `http://127.0.0.1:${port}`;

const workers = playwrightWorkers();

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "../test-results",
  reporter: [["list"]],
  // Fixed ceiling (NOR-F20-22, D25): at most 8 workers, 4 while the user is playing (game mode).
  workers,
  // The tests and the visual baselines read the interface in English: with "language" on "system"
  // the browser's language decides, so it is fixed here (the language tests set their own).
  use: { baseURL: url, locale: "en-US" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @noren/desktop exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url,
    reuseExistingServer: false,
  },
});
