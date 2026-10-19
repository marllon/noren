import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env["NOREN_E2E_PORT"] ?? 4791);
const url = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "../test-results",
  reporter: [["list"]],
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
