// The pure parts of `pnpm test:ssh` (scripts/test-ssh.mjs, NOR-F14-04a), kept apart so they can be
// tested without Docker. Run the tests with `node --test scripts/test-ssh-lib.test.mjs` (the vitest
// of `pnpm verify` only reads packages/ and apps/ and the game-mode test).

/** The label every Docker object of a run carries; its value is the id of the run. */
export const LABEL = "noren-ssh-test";

/**
 * The manifest of the workspace as the build context needs it: the same, without the member that
 * is not copied into the context (the Tauri app). Fails loudly when the line it expects is not
 * there, so a change to the root manifest cannot silently build the wrong thing.
 */
export function contextWorkspaceManifest(text) {
  const members = /^members = \[(.*)\]\s*$/m.exec(text);
  if (members === null) throw new Error("the root Cargo.toml has no `members = [...]` line");
  const kept = members[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry.startsWith('"crates/'));
  if (kept.length === 0) throw new Error("the root Cargo.toml lists no member under crates/");
  return text.replace(members[0], `members = [${kept.join(", ")}]`);
}

/** The text with Unix line ends, which is what a Dockerfile and sshd_config must have. */
export function unixLines(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * The images a Dockerfile starts from (`FROM name[:tag] [AS stage]`), without the stages it makes
 * itself and without `scratch`. `ARG` defaults before `FROM` are not expanded: the fixture names its
 * base images in full.
 */
export function baseImages(dockerfile) {
  const stages = new Set();
  const images = [];
  for (const line of unixLines(dockerfile).split("\n")) {
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (from === null) continue;
    const [, image, stage] = from;
    if (image !== "scratch" && !stages.has(image) && !images.includes(image)) images.push(image);
    if (stage !== undefined) stages.add(stage);
  }
  return images;
}

/** The host and port `docker port <container> 22/tcp` prints: `127.0.0.1:49153`. */
export function parsePublishedPort(output) {
  for (const line of output.split(/\r?\n/)) {
    const found = /^(\[[0-9a-f:]+\]|[0-9.]+):(\d+)\s*$/i.exec(line.trim());
    if (found !== null) return { host: found[1], port: Number(found[2]) };
  }
  throw new Error(`could not read a published port from: ${JSON.stringify(output)}`);
}

/**
 * A line of a known hosts file for a server on `host:port` from the public host key `ssh-keygen`
 * wrote (`ssh-ed25519 AAAA... comment`). A port other than 22 is written `[host]:port`.
 */
export function knownHostsLine(host, port, publicKey) {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0].startsWith("ssh-")) {
    throw new Error(`not a public key: ${JSON.stringify(publicKey.slice(0, 40))}`);
  }
  const pattern = port === 22 ? host : `[${host}]:${port}`;
  return `${pattern} ${parts[0]} ${parts[1]}\n`;
}

/** One id per line of what `docker images -aq`, `docker ps -aq` and the like print. */
export function lines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The environment the ignored cargo test reads (crates/noren-core/tests/ssh_docker.rs). */
export function testEnvironment({ host, port, user, keys, files }) {
  return {
    NOREN_SSH_TEST_HOST: host,
    NOREN_SSH_TEST_PORT: String(port),
    NOREN_SSH_TEST_USER: user,
    NOREN_SSH_TEST_KEY: keys.authorized,
    NOREN_SSH_TEST_STRANGER_KEY: keys.stranger,
    NOREN_SSH_TEST_KNOWN_HOSTS: files.knownHosts,
    NOREN_SSH_TEST_WRONG_KNOWN_HOSTS: files.wrongKnownHosts,
    NOREN_SSH_TEST_EMPTY_KNOWN_HOSTS: files.emptyKnownHosts,
    NOREN_SSH_TEST_CONFIG: files.config,
  };
}
