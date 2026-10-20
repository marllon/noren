// `pnpm test:ssh` (NOR-F14-04a): runs the tests of the SSH transport against a real OpenSSH server in
// a Docker container on this machine, and leaves nothing of it behind.
//
//   1. Builds a Docker image (scripts/ssh-test/Dockerfile) with a Debian machine, an sshd that lets
//      one user in with one key, and a `norend` compiled for Linux from this workspace.
//   2. Makes the keys and files the test needs in a temporary folder (a throwaway client key, a key
//      the server does not know, the known hosts file with the key of the server, a wrong one and an
//      empty one, an empty ssh configuration). Nothing is written to ~/.ssh.
//   3. Starts the container with its ssh port published on 127.0.0.1 only, and runs the ignored
//      cargo test `crates/noren-core/tests/ssh_docker.rs` against it with the `ssh` of the system:
//      a session is created, written to and read, the `ssh` process is killed, the client connects
//      again and the same session (same id, same pid) answers.
//   4. Always, on success, on failure and on Ctrl+C: removes the container (and its volumes), every
//      image the run made (all carry the label `noren-ssh-test=<run id>`), the base images it had to
//      pull (only those that were not on the machine before) and the temporary folder, and then
//      checks that `docker ps -a` and `docker images` show nothing of the run.
//
// Network: only the build of the image reaches out (the base images from the registry, the Debian
// package of sshd, the Rust crates), the way `pnpm install` does; the test itself talks to
// 127.0.0.1. Docker must be running. Exit code: 0 passed and clean, 1 the test failed or something
// was left behind, 2 Docker or ssh-keygen is not usable, 3 the image could not be built.
//
// Options: --keep-base-images (do not remove the base images this run pulled; for repeated runs
// while developing), --sweep (remove what a run that was killed hard left behind, then stop).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoEnv } from "./game-mode.mjs";
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "scripts", "ssh-test");
const keepBaseImages = process.argv.includes("--keep-base-images");
const sweepOnly = process.argv.includes("--sweep");

const runId = `${process.pid}-${Date.now().toString(36)}`;
const imageTag = `noren-ssh-test:${runId}`;
const containerName = `noren-ssh-test-${runId}`;
const USER_NAME = "noren";

function log(message) {
  console.log(`test-ssh: ${message}`);
}

/** Runs docker with its output captured. */
function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, ...options });
  return {
    ok: result.error === undefined && result.status === 0,
    out: result.stdout ?? "",
    err: result.stderr ?? (result.error ? result.error.message : ""),
  };
}

function dockerLines(args) {
  const result = docker(args);
  return result.ok ? lines(result.out) : [];
}

/** The `ssh-keygen` of the system; on Windows the one Windows ships, not the first in PATH. */
function sshKeygen() {
  if (process.platform === "win32" && process.env.SystemRoot !== undefined) {
    const system = join(process.env.SystemRoot, "System32", "OpenSSH", "ssh-keygen.exe");
    if (existsSync(system)) return system;
  }
  return "ssh-keygen";
}

/** Removes every Docker object labelled by a run (`runId` of "" means every run). */
function removeLabelled(value, report) {
  const filter = value === "" ? `label=${LABEL}` : `label=${LABEL}=${value}`;
  for (const id of dockerLines(["ps", "-aq", "--filter", filter])) {
    const mounts = dockerLines(["inspect", "-f", "{{range .Mounts}}{{.Name}}\n{{end}}", id]);
    docker(["rm", "-f", "-v", id]);
    for (const volume of mounts) docker(["volume", "rm", "-f", volume]);
    report.containers += 1;
  }
  // Children first: an image with a dependent child cannot be removed, so repeat until none is left
  // or a round removes nothing.
  for (let round = 0; round < 30; round += 1) {
    const ids = dockerLines(["images", "-aq", "--filter", filter]);
    if (ids.length === 0) break;
    let removed = 0;
    for (const id of ids) {
      if (docker(["rmi", "-f", id]).ok) removed += 1;
    }
    report.images += removed;
    if (removed === 0) break;
  }
}

if (sweepOnly) {
  const report = { containers: 0, images: 0 };
  removeLabelled("", report);
  log(
    `swept ${report.containers} container(s) and ${report.images} image layer(s) of earlier runs`,
  );
  process.exit(0);
}

if (!docker(["info", "--format", "{{.OSType}}"]).out.trim().startsWith("linux")) {
  console.error(
    "test-ssh: Docker is not running (or is not serving Linux containers). Start Docker and run this again.",
  );
  process.exit(2);
}
const keygen = sshKeygen();
if (spawnSync(keygen, ["-?"], { encoding: "utf8", windowsHide: true }).error !== undefined) {
  console.error(`test-ssh: ${keygen} cannot be run; install the OpenSSH client.`);
  process.exit(2);
}
const leftovers = dockerLines(["ps", "-aq", "--filter", `label=${LABEL}`]);
if (leftovers.length > 0) {
  log(
    `warning: ${leftovers.length} container(s) of an earlier run are still there; \`node scripts/test-ssh.mjs --sweep\` removes them`,
  );
}

const dockerfile = unixLines(readFileSync(join(fixture, "Dockerfile"), "utf8"));
const bases = baseImages(dockerfile);
const basesAbsentBefore = bases.filter((ref) => !docker(["image", "inspect", ref]).ok);
const tmp = mkdtempSync(join(tmpdir(), "noren-ssh-test-"));
let containerStarted = false;

/** Removes what the run made and checks that none of it is left. Returns the problems found. */
function cleanup() {
  const report = { containers: 0, images: 0, bases: [] };
  removeLabelled(runId, report);
  if (!keepBaseImages) {
    for (const ref of basesAbsentBefore) {
      if (docker(["image", "inspect", ref]).ok && docker(["rmi", ref]).ok) report.bases.push(ref);
    }
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch (error) {
    log(`could not remove ${tmp}: ${error.message}`);
  }

  const problems = [];
  if (dockerLines(["ps", "-aq", "--filter", `label=${LABEL}=${runId}`]).length > 0) {
    problems.push("a container of this run is still listed by `docker ps -a`");
  }
  if (dockerLines(["images", "-aq", "--filter", `label=${LABEL}=${runId}`]).length > 0) {
    problems.push("an image of this run is still listed by `docker images -a`");
  }
  if (docker(["image", "inspect", imageTag]).ok) problems.push(`${imageTag} still exists`);
  if (!keepBaseImages) {
    for (const ref of basesAbsentBefore) {
      if (docker(["image", "inspect", ref]).ok)
        problems.push(`the base image ${ref} is still there`);
    }
  }
  if (existsSync(tmp)) problems.push(`${tmp} is still there`);
  log(
    `cleanup: removed ${report.containers} container(s), ${report.images} image layer(s)` +
      (report.bases.length > 0 ? `, base images ${report.bases.join(", ")}` : "") +
      (keepBaseImages ? " (base images kept: --keep-base-images)" : ""),
  );
  return problems;
}

/** `docker pull`, a few times: the registry is the one part of this that is not on this machine. */
function pull(ref) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (docker(["pull", "--quiet", ref]).ok) return true;
    log(`pulling ${ref} failed (attempt ${attempt} of 4)`);
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 4000)"], { windowsHide: true });
  }
  return false;
}

/** Generates a key pair without a passphrase; returns the paths. */
function makeKey(name, comment) {
  const path = join(tmp, name);
  const made = spawnSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", path], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (made.status !== 0) throw new Error(`ssh-keygen failed: ${made.stderr ?? made.error}`);
  return { private: path, public: readFileSync(`${path}.pub`, "utf8") };
}

/** Waits until something answers with an SSH banner on host:port. */
function waitForBanner(host, port, limitMs) {
  const deadline = Date.now() + limitMs;
  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      const socket = net.connect({ host: host.replace(/^\[|\]$/g, ""), port });
      let seen = "";
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline) rejectWait(new Error(`no ssh banner from ${host}:${port}`));
        else setTimeout(attempt, 300);
      };
      socket.setTimeout(2000, retry);
      socket.on("error", retry);
      socket.on("data", (chunk) => {
        seen += chunk.toString("latin1");
        if (seen.startsWith("SSH-")) {
          socket.destroy();
          resolveWait();
        } else if (seen.length > 4) retry();
      });
    };
    attempt();
  });
}

let exitCode = 1;
try {
  // -- the images the Dockerfile starts from, pulled with retries
  for (const ref of bases) {
    if (!basesAbsentBefore.includes(ref)) continue;
    log(`pulling ${ref} (not on this machine yet)`);
    if (!pull(ref)) {
      console.error(`test-ssh: could not pull ${ref}; is the registry reachable from Docker?`);
      exitCode = 3;
      throw new Error("pull failed");
    }
  }

  // -- keys and files
  const authorized = makeKey("id_ed25519", "noren-ssh-test");
  const stranger = makeKey("id_stranger", "noren-ssh-test-stranger");
  const impostor = makeKey("host_impostor", "impostor");
  const emptyKnownHosts = join(tmp, "known_hosts_empty");
  const config = join(tmp, "ssh_config");
  writeFileSync(emptyKnownHosts, "");
  writeFileSync(config, "# empty on purpose: the test must not depend on ~/.ssh/config\n");

  // -- the build context: the two crates, the lock file, the fixture
  const context = join(tmp, "context");
  mkdirSync(join(context, "crates"), { recursive: true });
  writeFileSync(
    join(context, "Cargo.toml"),
    contextWorkspaceManifest(unixLines(readFileSync(join(root, "Cargo.toml"), "utf8"))),
  );
  cpSync(join(root, "Cargo.lock"), join(context, "Cargo.lock"));
  for (const crate of ["noren-core", "norend"]) {
    mkdirSync(join(context, "crates", crate), { recursive: true });
    cpSync(join(root, "crates", crate, "Cargo.toml"), join(context, "crates", crate, "Cargo.toml"));
    cpSync(join(root, "crates", crate, "src"), join(context, "crates", crate, "src"), {
      recursive: true,
    });
  }
  writeFileSync(join(context, "Dockerfile"), dockerfile);
  writeFileSync(
    join(context, "sshd_config"),
    unixLines(readFileSync(join(fixture, "sshd_config"), "utf8")),
  );
  writeFileSync(join(context, "authorized_keys"), authorized.public);

  // -- the image
  log(`building ${imageTag} (norend for Linux and an sshd; the first build takes a few minutes)`);
  const build = spawnSync(
    "docker",
    [
      "build",
      "--no-cache",
      "--force-rm",
      "--build-arg",
      `RUN_ID=${runId}`,
      "-t",
      imageTag,
      context,
    ],
    { stdio: "inherit", env: { ...process.env, DOCKER_BUILDKIT: "0" }, windowsHide: true },
  );
  if (build.status !== 0) {
    console.error("test-ssh: the image could not be built (see the output above).");
    exitCode = 3;
    throw new Error("build failed");
  }

  // -- the container, its port on 127.0.0.1 only
  const started = docker([
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `${LABEL}=${runId}`,
    "-p",
    "127.0.0.1::22",
    imageTag,
  ]);
  containerStarted = true;
  if (!started.ok) throw new Error(`docker run failed: ${started.err}`);
  const published = docker(["port", containerName, "22/tcp"]);
  if (!published.ok) throw new Error(`docker port failed: ${published.err}`);
  const { host, port } = parsePublishedPort(published.out);
  log(`sshd of ${containerName} listens on ${host}:${port}`);
  await waitForBanner(host, port, 60_000);

  // -- known hosts: the real key of the server, an impostor's, and none
  const hostKey = docker(["exec", containerName, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"]);
  if (!hostKey.ok) throw new Error(`could not read the host key: ${hostKey.err}`);
  const knownHosts = join(tmp, "known_hosts");
  const wrongKnownHosts = join(tmp, "known_hosts_wrong");
  writeFileSync(knownHosts, knownHostsLine(host, port, hostKey.out));
  writeFileSync(wrongKnownHosts, knownHostsLine(host, port, impostor.public));

  // -- the tests
  log(
    "running the ignored cargo tests: ssh_docker (the transport) and remote_docker (the profile)",
  );
  const env = {
    ...cargoEnv(),
    ...testEnvironment({
      host,
      port,
      user: USER_NAME,
      keys: { authorized: authorized.private, stranger: stranger.private },
      files: { knownHosts, wrongKnownHosts, emptyKnownHosts, config },
    }),
  };
  const test = spawnSync(
    "cargo",
    [
      "test",
      "-p",
      "noren-core",
      "--test",
      "ssh_docker",
      "--",
      "--ignored",
      "--nocapture",
      "--test-threads=1",
    ],
    { cwd: root, stdio: "inherit", env, windowsHide: true },
  );
  let failure = test.status === 0 ? null : test;
  if (failure === null) {
    // The same container, the same keys: now through the profile of the app (a tab of kind ssh).
    const viaProfile = spawnSync(
      "cargo",
      [
        "test",
        "-p",
        "noren",
        "--bin",
        "noren",
        "remote_docker::",
        "--",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
      ],
      { cwd: root, stdio: "inherit", env, windowsHide: true },
    );
    failure = viaProfile.status === 0 ? null : viaProfile;
  }
  exitCode = failure === null ? 0 : 1;
  if (failure !== null) {
    log(
      `the test failed (${failure.error ? failure.error.message : `exit ${failure.status}`}); the log of sshd:`,
    );
    const logs = docker(["logs", "--tail", "60", containerName]);
    console.log(`${logs.out}${logs.err}`);
  }
} catch (error) {
  console.error(`test-ssh: ${error.message}`);
  if (containerStarted) {
    const logs = docker(["logs", "--tail", "60", containerName]);
    console.log(`${logs.out}${logs.err}`);
  }
  if (exitCode === 0) exitCode = 1;
} finally {
  const problems = cleanup();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`test-ssh: LEFT BEHIND: ${problem}`);
    exitCode = 1;
  } else {
    log("docker ps -a and docker images show nothing of this run");
  }
}
process.exit(exitCode);
