// The pure parts of scripts/desktop-build.mjs (NOR-F14-02c), kept apart so they can be tested.
// Run the tests with `node --test scripts/desktop-build-lib.test.mjs` (the vitest of `pnpm verify`
// only reads packages/ and apps/ and the game-mode test).

/** The `host:` triple in the output of `rustc -vV`, e.g. `x86_64-pc-windows-msvc`. */
export function hostTriple(rustcVerbose) {
  const match = /^host:\s*(\S+)\s*$/m.exec(rustcVerbose);
  if (match === null) {
    throw new Error("could not find the host triple in the output of `rustc -vV`");
  }
  return match[1];
}

/** The file name of the daemon that `cargo build -p norend` makes. */
export function norendFileName(triple) {
  return triple.includes("windows") ? "norend.exe" : "norend";
}

/**
 * The name Tauri looks for an external binary under: `<name>-<target triple>[.exe]`, in the folder
 * the `externalBin` entry points at. The installer carries it as plain `norend[.exe]`, next to the
 * program (where `daemon_link::default_program` looks).
 */
export function sidecarFileName(triple) {
  return triple.includes("windows") ? `norend-${triple}.exe` : `norend-${triple}`;
}
