// Writes the package manifests of a release (NOR-F20-03): winget (several files), Scoop (JSON) and
// the AUR (PKGBUILD and .SRCINFO of a -bin package made from the deb), from the installers that
// `pnpm desktop:build` made and the version in tauri.conf.json. It reads the installers, hashes
// them and writes text files under target/packages/<version>/ (ignored by git). It never uploads,
// submits or pushes anything: see docs/PACKAGES.md for the steps a maintainer takes by hand.
//
//   pnpm packages:generate [--bundle-dir <dir>] [--deb <file>] [--appimage <file>]
//                          [--out <dir>] [--targets winget,scoop,aur]
//
// The Windows installers are found under <bundle-dir> (default: release/bundle of the Cargo target
// directory). The Linux packages come from the release workflow, so their paths are passed. The
// default targets are winget and Scoop, plus the AUR when --deb is given.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  INSTALLER_KINDS,
  aurFiles,
  checksumList,
  scoopManifest,
  sha256Hex,
  versionFromTauriConf,
  wingetManifests,
} from "./packages-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["winget", "scoop", "aur"];

/** Reads the command line into options; throws a sentence on anything it does not know. */
export function parseArgs(argv) {
  const options = { targets: undefined };
  const takesValue = {
    "--bundle-dir": "bundleDir",
    "--deb": "deb",
    "--appimage": "appimage",
    "--out": "out",
    "--targets": "targets",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = takesValue[argv[index]];
    if (key === undefined) throw new Error(`unknown argument "${argv[index]}"`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argv[index]} needs a value`);
    }
    options[key] = value;
    index += 1;
  }
  if (options.targets !== undefined) {
    options.targets = options.targets.split(",").map((name) => name.trim());
    const bad = options.targets.find((name) => !TARGETS.includes(name));
    if (bad !== undefined) throw new Error(`unknown target "${bad}" (use ${TARGETS.join(", ")})`);
  }
  return options;
}

function readInstaller(kind, path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    let others = [];
    try {
      others = readdirSync(dirname(path)).filter((name) => name.startsWith("Noren_"));
    } catch {
      // The folder itself is missing: nothing to suggest.
    }
    const hint = others.length > 0 ? `; the folder has ${others.join(", ")}` : "";
    throw new Error(
      `the ${INSTALLER_KINDS[kind].label} was not found at ${path}${hint} (build it with pnpm desktop:build, or pass its path)`,
    );
  }
  return { fileName: basename(path), sha256: sha256Hex(bytes), path };
}

/**
 * Makes the manifests and returns the list of files written (relative to `out`). `version` is the
 * one of tauri.conf.json; `bundleDir` holds nsis/ and msi/ as `tauri build` leaves them.
 */
export function generate({ version, bundleDir, deb, appimage, out, targets }) {
  const wanted = targets ?? (deb === undefined ? ["winget", "scoop"] : TARGETS);
  const names = (kind) => INSTALLER_KINDS[kind].name(version);
  const nsis = wanted.includes("winget")
    ? readInstaller("nsis", join(bundleDir, "nsis", names("nsis")))
    : undefined;
  const msi =
    wanted.includes("winget") || wanted.includes("scoop")
      ? readInstaller("msi", join(bundleDir, "msi", names("msi")))
      : undefined;
  if (wanted.includes("aur") && deb === undefined) {
    throw new Error("the AUR package is made from the deb: pass its path with --deb <file>");
  }
  const debInfo = deb === undefined ? undefined : readInstaller("deb", deb);
  const appImageInfo = appimage === undefined ? undefined : readInstaller("appimage", appimage);

  const files = {};
  if (wanted.includes("winget")) {
    for (const [name, text] of Object.entries(wingetManifests({ version, nsis, msi }))) {
      files[`winget/${name}`] = text;
    }
  }
  if (wanted.includes("scoop")) files["scoop/noren.json"] = scoopManifest({ version, msi });
  if (wanted.includes("aur")) {
    for (const [name, text] of Object.entries(aurFiles({ version, deb: debInfo }))) {
      files[`aur/${name}`] = text;
    }
  }
  const seen = [nsis, msi, debInfo, appImageInfo].filter((info) => info !== undefined);
  files["SHA256SUMS"] = checksumList(seen);

  for (const [relative, text] of Object.entries(files)) {
    const target = join(out, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
  return Object.keys(files);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = versionFromTauriConf(
    readFileSync(join(root, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const targetDir = resolve(process.env.CARGO_TARGET_DIR ?? join(root, "target"));
  const written = generate({
    version,
    bundleDir: resolve(options.bundleDir ?? join(targetDir, "release", "bundle")),
    deb: options.deb === undefined ? undefined : resolve(options.deb),
    appimage: options.appimage === undefined ? undefined : resolve(options.appimage),
    out: resolve(options.out ?? join(targetDir, "packages", version)),
    targets: options.targets,
  });
  const out = resolve(options.out ?? join(targetDir, "packages", version));
  console.log(`packages: manifests for ${version} written to ${out}`);
  for (const file of written) console.log(`  ${file}`);
  console.log("Nothing was submitted or uploaded. See docs/PACKAGES.md for the next steps.");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`packages: ${error.message}`);
    process.exit(1);
  }
}
