import { defineConfig, devices } from "@playwright/test";
import { playwrightWorkers } from "../scripts/game-mode.mjs";

// The e2e of the web demo (NOR-F12-02): it runs on the build in `dist-demo/` (`pnpm demo:build`),
// never on the normal build. Its port is not the one of `playwright.config.ts` (4791), so both can
// run on one machine.
const port = Number(process.env["NOREN_DEMO_PORT"] ?? 4781);
const url = `http://127.0.0.1:${port}`;

const workers = playwrightWorkers();

export default defineConfig({
  testDir: "./demo",
  testMatch: "**/*.demo.ts",
  outputDir: "../test-results",
  reporter: [["list"]],
  // Game mode (NOR-F11-04): 4 workers while the user is playing; otherwise Playwright's own default.
  ...(workers !== undefined ? { workers } : {}),
  use: { baseURL: url, locale: "en-US" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @noren/desktop exec vite preview --mode demo --outDir ../../dist-demo --host 127.0.0.1 --port ${port} --strictPort`,
    url,
    reuseExistingServer: false,
  },
});
