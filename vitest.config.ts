import { defineConfig } from "vitest/config";
import { vitestWorkers } from "./scripts/game-mode.mjs";

const maxWorkers = vitestWorkers();

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.{ts,tsx}",
      "scripts/check-licenses.vitest.mjs",
      "scripts/game-mode.vitest.mjs",
      "scripts/packages.vitest.mjs",
      "scripts/shot.vitest.mjs",
    ],
    // Fixed ceiling (NOR-F20-22, D25): at most 8 workers, 4 while the user is playing (game mode).
    maxWorkers,
  },
});
