// Run with `node --test scripts/desktop-build-lib.test.mjs` (the vitest of `pnpm verify` only reads
// packages/ and apps/ and the game-mode test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostTriple, norendFileName, sidecarFileName } from "./desktop-build-lib.mjs";

const RUSTC = `rustc 1.99.1 (58cf8f9c3 2026-10-13)
binary: rustc
commit-hash: 58cf8f9c3b1e5f2a0a1b1c9d7d1d6a04d1f5a3ff
commit-date: 2026-10-13
host: x86_64-pc-windows-msvc
release: 1.99.1
LLVM version: 22.1.0
`;

test("the host triple is the one `rustc -vV` names", () => {
  assert.equal(hostTriple(RUSTC), "x86_64-pc-windows-msvc");
  assert.equal(hostTriple(RUSTC.replace(/\n/g, "\r\n")), "x86_64-pc-windows-msvc");
  assert.equal(hostTriple("host: aarch64-apple-darwin\n"), "aarch64-apple-darwin");
});

test("a rustc output with no host line is an error, not a guess", () => {
  assert.throws(() => hostTriple("rustc 1.99.1\nrelease: 1.99.1\n"), /host triple/);
  assert.throws(() => hostTriple(""), /host triple/);
});

test("the daemon file has the extension of the system and the sidecar carries the triple", () => {
  assert.equal(norendFileName("x86_64-pc-windows-msvc"), "norend.exe");
  assert.equal(norendFileName("x86_64-unknown-linux-gnu"), "norend");
  assert.equal(sidecarFileName("x86_64-pc-windows-msvc"), "norend-x86_64-pc-windows-msvc.exe");
  assert.equal(sidecarFileName("x86_64-unknown-linux-gnu"), "norend-x86_64-unknown-linux-gnu");
  assert.equal(sidecarFileName("aarch64-apple-darwin"), "norend-aarch64-apple-darwin");
});
