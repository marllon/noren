// Run with `node --test scripts/test-ssh-lib.test.mjs` (the vitest of `pnpm verify` only reads
// packages/ and apps/ and the game-mode test).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LABEL,
  baseImages,
  contextWorkspaceManifest,
  knownHostsLine,
  lines,
  parsePublishedPort,
  testEnvironment,
  unixLines,
} from "./test-ssh-lib.mjs";

const ROOT_MANIFEST = `[workspace]
members = ["crates/*", "apps/desktop/src-tauri"]
resolver = "3"

[workspace.package]
version = "0.1.0"
`;

test("the build context keeps the crates and leaves the app out", () => {
  const text = contextWorkspaceManifest(ROOT_MANIFEST);
  assert.match(text, /^members = \["crates\/\*"\]$/m);
  assert.doesNotMatch(text, /src-tauri/);
  // Everything else is the root manifest as it was.
  assert.match(text, /resolver = "3"/);
  assert.match(text, /\[workspace\.package\]\nversion = "0\.1\.0"/);
});

test("the build context refuses a manifest it does not understand", () => {
  assert.throws(() => contextWorkspaceManifest('[workspace]\nresolver = "3"\n'), /members/);
  assert.throws(
    () => contextWorkspaceManifest('[workspace]\nmembers = ["apps/desktop/src-tauri"]\n'),
    /under crates/,
  );
});

test("a Dockerfile written with Windows line ends is read with Unix ones", () => {
  assert.equal(unixLines("a\r\nb\r\n"), "a\nb\n");
  assert.equal(unixLines("a\nb\n"), "a\nb\n");
});

test("the base images are the FROM lines that are not stages of the file", () => {
  const dockerfile = `ARG RUN_ID=unset
FROM rust:1-bookworm AS build
RUN cargo build
FROM debian:bookworm-slim
COPY --from=build /a /b
FROM build AS again
FROM scratch
`;
  assert.deepEqual(baseImages(dockerfile), ["rust:1-bookworm", "debian:bookworm-slim"]);
  assert.deepEqual(baseImages(dockerfile.replace(/\n/g, "\r\n")), [
    "rust:1-bookworm",
    "debian:bookworm-slim",
  ]);
  assert.deepEqual(baseImages("FROM --platform=linux/amd64 alpine:3 AS a\n"), ["alpine:3"]);
  assert.deepEqual(baseImages("FROM debian\nFROM debian\n"), ["debian"]);
});

test("every stage of the Dockerfile of the fixture carries the label the cleanup looks for", () => {
  const dockerfile = unixLines(
    readFileSync(new URL("./ssh-test/Dockerfile", import.meta.url), "utf8"),
  );
  // The cleanup removes exactly these when the run pulled them; a new FROM must be a conscious
  // change here, not a base image that is left behind.
  assert.deepEqual(baseImages(dockerfile), ["rust:1-bookworm", "debian:bookworm-slim"]);
  const stages = dockerfile.split(/^FROM /m).slice(1);
  assert.equal(stages.length, 2);
  for (const stage of stages) {
    assert.match(stage, /^LABEL noren-ssh-test=\$\{RUN_ID\}$/m, stage.split("\n")[0]);
  }
  assert.equal(LABEL, "noren-ssh-test");
});

test("the published port is read from what docker prints", () => {
  assert.deepEqual(parsePublishedPort("127.0.0.1:49153\n"), { host: "127.0.0.1", port: 49153 });
  assert.deepEqual(parsePublishedPort("127.0.0.1:32768\r\n"), { host: "127.0.0.1", port: 32768 });
  assert.deepEqual(parsePublishedPort("[::1]:5000\n"), { host: "[::1]", port: 5000 });
  assert.deepEqual(parsePublishedPort("\n0.0.0.0:7000\n[::]:7000\n"), {
    host: "0.0.0.0",
    port: 7000,
  });
  assert.throws(() => parsePublishedPort(""), /could not read/);
  assert.throws(() => parsePublishedPort("Error: No public port"), /could not read/);
});

test("a known hosts line names the port the way ssh looks it up", () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@4f2a\n";
  assert.equal(
    knownHostsLine("127.0.0.1", 49153, key),
    "[127.0.0.1]:49153 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n",
  );
  assert.equal(
    knownHostsLine("127.0.0.1", 22, key),
    "127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n",
  );
  assert.throws(() => knownHostsLine("h", 22, "not a key"), /not a public key/);
  assert.throws(() => knownHostsLine("h", 22, ""), /not a public key/);
});

test("lines drops the blanks and the line ends", () => {
  assert.deepEqual(lines("a\r\n\n b \n"), ["a", "b"]);
  assert.deepEqual(lines(""), []);
});

test("the test environment carries every path the cargo test reads", () => {
  const env = testEnvironment({
    host: "127.0.0.1",
    port: 49153,
    user: "noren",
    keys: { authorized: "/k/a", stranger: "/k/s" },
    files: {
      knownHosts: "/k/kh",
      wrongKnownHosts: "/k/kw",
      emptyKnownHosts: "/k/ke",
      config: "/k/c",
    },
  });
  assert.deepEqual(env, {
    NOREN_SSH_TEST_HOST: "127.0.0.1",
    NOREN_SSH_TEST_PORT: "49153",
    NOREN_SSH_TEST_USER: "noren",
    NOREN_SSH_TEST_KEY: "/k/a",
    NOREN_SSH_TEST_STRANGER_KEY: "/k/s",
    NOREN_SSH_TEST_KNOWN_HOSTS: "/k/kh",
    NOREN_SSH_TEST_WRONG_KNOWN_HOSTS: "/k/kw",
    NOREN_SSH_TEST_EMPTY_KNOWN_HOSTS: "/k/ke",
    NOREN_SSH_TEST_CONFIG: "/k/c",
  });
});
