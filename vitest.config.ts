import { defineConfig } from "vitest/config";
import { vitestWorkers } from "./scripts/game-mode.mjs";

const maxWorkers = vitestWorkers();

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.{ts,tsx}",
      "scripts/game-mode.vitest.mjs",
      "scripts/packages.vitest.mjs",
    ],
    // Game mode (NOR-F11-04): at most 8 workers while the user is playing; otherwise Vitest's own default.
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
  },
});
