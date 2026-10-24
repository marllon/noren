import { availableParallelism } from "node:os";
import { defineConfig, devices } from "@playwright/test";
import { playwrightWorkers } from "../scripts/game-mode.mjs";
import { refuseLocalTests } from "../scripts/local-tests.mjs";

if (process.env["NOREN_NO_LOCAL_TESTS"] === "1") refuseLocalTests();

const port = Number(process.env["NOREN_E2E_PORT"] ?? 4791);
const url = `http://127.0.0.1:${port}`;

// The hosted CI runner has 4 vCPUs: more workers than cores starve each other and the tests time
// out, so there the ceiling is the number of cores (the ceiling of 8 still holds).
const workers =
  process.env["CI"] === undefined
    ? playwrightWorkers()
    : Math.min(playwrightWorkers(), availableParallelism());

// The 30 s of a test is sized for a developer machine. The free hosted runner is several times
// slower (software rendering, 4 shared vCPUs), so on CI the ceiling is higher; a test that waits
// for a condition still ends the moment the condition is true.
const testTimeout = process.env["CI"] === undefined ? 30_000 : 90_000;

// The throughput floor measures the machine, so it cannot share the cores with other workers. CI
// leaves it out of the main run with this variable and runs it in a step of its own, alone (as
// `scripts/perf.mjs` does); everywhere else it is part of the run.
const skipPerf = process.env["NOREN_E2E_SKIP_PERF"] === "1";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  testIgnore: skipPerf ? /perf\.spec\.ts/ : [],
  outputDir: "../test-results",
  reporter: [["list"]],
  // Fixed ceiling (NOR-F20-22): at most 8 workers, 4 while the user is playing (game mode).
  workers,
  // The tests and the visual baselines read the interface in English: with "language" on "system"
  // the browser's language decides, so it is fixed here (the language tests set their own).
  use: { baseURL: url, locale: "en-US" },
  timeout: testTimeout,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @noren/desktop exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url,
    reuseExistingServer: false,
  },
});
