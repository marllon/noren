// The opt-out of local test runs. A machine that sets NOREN_NO_LOCAL_TESTS=1 does not run the test
// suites: every entry point of them (the Vitest and Playwright configs, the smoke, perf and SSH
// scripts, and `cargo test` through game-run) calls `refuseLocalTests` before it compiles anything or
// opens a browser. Without the variable nothing changes; CI does not set it.
export const LOCAL_TESTS_MESSAGE =
  "Tests are disabled on this machine (NOREN_NO_LOCAL_TESTS=1). They run in CI.";

/** Prints why and ends the process with 1. */
export function refuseLocalTests() {
  process.stderr.write(`${LOCAL_TESTS_MESSAGE}\n`);
  process.exit(1);
}
