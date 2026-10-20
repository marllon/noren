import { defineConfig, devices } from "@playwright/test";

// The media script of the README (NOR-F12-03): it drives the web demo (`dist-demo/`, built by
// `pnpm demo:build`) and writes PNG screenshots and a webm video to `docs/media/`. Its own port
// (4782) keeps it apart from the e2e (4791) and the demo e2e (4781). Run it with `pnpm media`.
const port = Number(process.env["NOREN_MEDIA_PORT"] ?? 4782);
const url = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./media",
  // `*.media.ts` matches neither `*.spec.ts` (e2e) nor `*.demo.ts` (demo e2e).
  testMatch: "**/*.media.ts",
  outputDir: "../test-results",
  reporter: [["list"]],
  workers: 1,
  use: { baseURL: url, locale: "en-US", headless: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @noren/desktop exec vite preview --mode demo --outDir ../../dist-demo --host 127.0.0.1 --port ${port} --strictPort`,
    url,
    reuseExistingServer: false,
  },
});
