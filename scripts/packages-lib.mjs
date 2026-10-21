// The pure part of scripts/packages.mjs (NOR-F20-03): from the version of tauri.conf.json and the
// name and sha256 of each installer, the text of the winget, Scoop and AUR (-bin) manifests.
// Nothing here reads a file, the network or the clock, so the same input always gives the same
// text and the tests (scripts/packages.vitest.mjs) need only small fixtures. Nothing here
// publishes either: the generated files are for a maintainer to review and submit by hand
// (docs/PACKAGES.md).
import { createHash } from "node:crypto";

export const REPO = "marllon/noren";
export const REPO_URL = `https://github.com/${REPO}`;
export const PRODUCT = "Noren";
/** Windows: Publisher.Package, the shape winget requires. */
export const WINGET_ID = "Marllon.Noren";
export const WINGET_MANIFEST_VERSION = "1.6.0";
export const SHORT_DESCRIPTION =
  "A terminal organized like a modern browser: spaces, groups, pinned tabs, splits, a command palette and custom themes.";
export const LICENSE = "MIT";
export const AUR_PACKAGE = "noren-bin";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** The kinds of installer the generator knows, with the name Tauri gives each one. */
export const INSTALLER_KINDS = {
  nsis: { label: "NSIS installer", name: (v) => `Noren_${v}_x64-setup.exe` },
  msi: { label: "MSI installer", name: (v) => `Noren_${v}_x64_en-US.msi` },
  deb: { label: "deb package", name: (v) => `Noren_${v}_amd64.deb` },
  appimage: { label: "AppImage", name: (v) => `Noren_${v}_amd64.AppImage` },
};

/** The `version` of tauri.conf.json (given as text), which must be a plain `major.minor.patch`. */
export function versionFromTauriConf(text) {
  let conf;
  try {
    conf = JSON.parse(text);
  } catch (error) {
    throw new Error(`tauri.conf.json is not valid JSON (${error.message})`, { cause: error });
  }
  const version = conf?.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(
      `the version in tauri.conf.json must be a plain major.minor.patch, found ${JSON.stringify(version)}`,
    );
  }
  return version;
}

/**
 * Checks that the file name is the one Tauri gives to this kind of installer for `version`, so an
 * installer left over from another build is never described as the current one.
 */
export function assertInstallerName(kind, fileName, version) {
  const known = INSTALLER_KINDS[kind];
  if (known === undefined) throw new Error(`unknown installer kind "${kind}"`);
  const expected = known.name(version);
  if (fileName === expected) return;
  const found = /_(\d+\.\d+\.\d+[^_]*)_/.exec(fileName)?.[1];
  const why =
    found !== undefined && found !== version
      ? `it is for version ${found} but tauri.conf.json says ${version}`
      : `it should be called ${expected}`;
  throw new Error(
    `the ${known.label} ${fileName} does not match the app: ${why} (build again with pnpm desktop:build)`,
  );
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The address a file of a GitHub release has once the draft of `v<version>` is published. */
export function releaseUrl(version, fileName) {
  return `${REPO_URL}/releases/download/v${version}/${encodeURIComponent(fileName)}`;
}

/** An installer as the manifests need it: `{ fileName, sha256 }` with the hash in lower case hex. */
function requireInstaller(kind, installer, version) {
  const known = INSTALLER_KINDS[kind];
  if (installer === undefined || installer === null) {
    throw new Error(`the ${known.label} is missing (expected ${known.name(version)})`);
  }
  assertInstallerName(kind, installer.fileName, version);
  if (!/^[0-9a-f]{64}$/.test(installer.sha256)) {
    throw new Error(`the sha256 of ${installer.fileName} is not 64 lower case hex digits`);
  }
  return installer;
}

/** A YAML scalar: plain when it is safe, else a double quoted string (JSON strings are YAML). */
export function yamlScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  return /^[A-Za-z0-9][A-Za-z0-9 ._/()+-]*$/.test(text) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(text) &&
    !/^[\d.]+$/.test(text) &&
    !text.endsWith(" ")
    ? text
    : JSON.stringify(text);
}

const WINGET_HEADER = (file) =>
  `# Created by scripts/packages.mjs (NOR-F20-03). Review before submitting; see docs/PACKAGES.md.\n# yaml-language-server: $schema=https://aka.ms/winget-manifest.${file}.${WINGET_MANIFEST_VERSION}.schema.json\n`;

/**
 * The three files of a multi-file winget manifest, by file name. The NSIS installer is per user
 * (no administrator rights) and the MSI is per machine, which is how Tauri builds them.
 */
export function wingetManifests({ version, nsis, msi }) {
  requireInstaller("nsis", nsis, version);
  requireInstaller("msi", msi, version);
  const base = `PackageIdentifier: ${WINGET_ID}\nPackageVersion: ${yamlScalar(version)}\n`;
  const installer = (type, scope, info, switches) =>
    [
      `  - Architecture: x64`,
      `    InstallerType: ${type}`,
      `    Scope: ${scope}`,
      `    InstallerUrl: ${releaseUrl(version, info.fileName)}`,
      `    InstallerSha256: ${info.sha256.toUpperCase()}`,
      ...(switches
        ? [
            `    InstallerSwitches:`,
            `      Silent: ${switches}`,
            `      SilentWithProgress: ${switches}`,
          ]
        : []),
    ].join("\n");

  return {
    [`${WINGET_ID}.yaml`]:
      WINGET_HEADER("version") +
      base +
      `DefaultLocale: en-US\nManifestType: version\nManifestVersion: ${WINGET_MANIFEST_VERSION}\n`,
    [`${WINGET_ID}.installer.yaml`]:
      WINGET_HEADER("installer") +
      base +
      `MinimumOSVersion: 10.0.17763.0\nInstallerLocale: en-US\nUpgradeBehavior: install\nInstallers:\n` +
      installer("nullsoft", "user", nsis, "/S") +
      "\n" +
      installer("wix", "machine", msi, "/qn") +
      `\nManifestType: installer\nManifestVersion: ${WINGET_MANIFEST_VERSION}\n`,
    [`${WINGET_ID}.locale.en-US.yaml`]:
      WINGET_HEADER("defaultLocale") +
      base +
      [
        `PackageLocale: en-US`,
        `Publisher: ${yamlScalar("Noren contributors")}`,
        `PublisherUrl: ${REPO_URL}`,
        `PublisherSupportUrl: ${REPO_URL}/issues`,
        `PackageName: ${PRODUCT}`,
        `PackageUrl: ${REPO_URL}`,
        `License: ${LICENSE}`,
        `LicenseUrl: ${REPO_URL}/blob/main/LICENSE`,
        `ShortDescription: ${yamlScalar(SHORT_DESCRIPTION)}`,
        `Moniker: noren`,
        `Tags:`,
        `  - terminal`,
        `  - shell`,
        `  - tabs`,
        `  - tauri`,
        `ReleaseNotesUrl: ${REPO_URL}/releases/tag/v${version}`,
        `ManifestType: defaultLocale`,
        `ManifestVersion: ${WINGET_MANIFEST_VERSION}`,
      ].join("\n") +
      "\n",
  };
}

/**
 * The Scoop manifest. It unpacks the MSI instead of running an installer, so it needs no
 * administrator rights and opens no window (`msiexec /a` or lessmsi, Scoop's own choice): the
 * program is under `PFiles\Noren` in the unpacked image. The installers' own registrations (the
 * `noren://` link, the uninstall entry) do not happen, and `scoop update` replaces the in-app
 * updater for this install.
 */
export function scoopManifest({ version, msi }) {
  requireInstaller("msi", msi, version);
  const url = (v, file) => releaseUrl(v, file);
  const manifest = {
    version,
    description: SHORT_DESCRIPTION,
    homepage: REPO_URL,
    license: LICENSE,
    architecture: {
      "64bit": { url: url(version, msi.fileName), hash: msi.sha256 },
    },
    extract_dir: "PFiles\\Noren",
    bin: ["noren.exe", "norend.exe"],
    shortcuts: [["noren.exe", PRODUCT]],
    checkver: { github: REPO_URL },
    autoupdate: {
      architecture: {
        // Scoop fills in ${version} itself when it finds a newer one.
        "64bit": {
          url: `${REPO_URL}/releases/download/v\${version}/Noren_\${version}_x64_en-US.msi`,
        },
      },
    },
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** Escapes a value for a bash single quoted string. */
function shellQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

/**
 * PKGBUILD and .SRCINFO of the `noren-bin` package, made from the deb of the release. The two
 * come from the same fields, so they cannot disagree. Written by hand for makepkg, not run here.
 */
export function aurFiles({ version, deb }) {
  requireInstaller("deb", deb, version);
  const fields = {
    pkgname: AUR_PACKAGE,
    pkgver: version,
    pkgrel: "1",
    pkgdesc: SHORT_DESCRIPTION,
    arch: ["x86_64"],
    url: REPO_URL,
    license: [LICENSE],
    depends: ["webkit2gtk-4.1", "gtk3"],
    optdepends: ["libayatana-appindicator: tray icon"],
    provides: ["noren"],
    conflicts: ["noren"],
    options: ["!strip", "!debug"],
    sha256sums: [deb.sha256],
  };
  // In the PKGBUILD the version is the variable, so a bump of pkgver is one edit.
  const withVariable = (text) => text.replaceAll(version, "${pkgver}");
  const fileTemplate = withVariable(deb.fileName);
  const sourceTemplate = `${fileTemplate}::${withVariable(releaseUrl(version, deb.fileName))}`;
  const single = (items) => items.map(shellQuote).join(" ");
  const double = (items) => items.map((item) => `"${item}"`).join(" ");
  const pkgbuild =
    `# Maintainer: Noren contributors\n` +
    `# Generated by scripts/packages.mjs (NOR-F20-03) from the deb of the release. Review before\n` +
    `# pushing to the AUR; see docs/PACKAGES.md.\n` +
    `pkgname=${fields.pkgname}\n` +
    `pkgver=${fields.pkgver}\n` +
    `pkgrel=${fields.pkgrel}\n` +
    `pkgdesc=${shellQuote(fields.pkgdesc)}\n` +
    `arch=(${single(fields.arch)})\n` +
    `url=${shellQuote(fields.url)}\n` +
    `license=(${single(fields.license)})\n` +
    `depends=(${single(fields.depends)})\n` +
    `optdepends=(${single(fields.optdepends)})\n` +
    `provides=(${single(fields.provides)})\n` +
    `conflicts=(${single(fields.conflicts)})\n` +
    `options=(${single(fields.options)})\n` +
    `source=(${double([sourceTemplate])})\n` +
    `noextract=(${double([fileTemplate])})\n` +
    `sha256sums=(${single(fields.sha256sums)})\n` +
    `\n` +
    `package() {\n` +
    `  # A deb is an ar archive that holds data.tar.*; bsdtar reads both layers.\n` +
    `  bsdtar -xOf "$srcdir/${fileTemplate}" 'data.tar.*' | bsdtar -xf - -C "$pkgdir"\n` +
    `}\n`;

  const srcinfo =
    [
      `pkgbase = ${fields.pkgname}`,
      `\tpkgdesc = ${fields.pkgdesc}`,
      `\tpkgver = ${fields.pkgver}`,
      `\tpkgrel = ${fields.pkgrel}`,
      `\turl = ${fields.url}`,
      ...fields.arch.map((a) => `\tarch = ${a}`),
      ...fields.license.map((l) => `\tlicense = ${l}`),
      ...fields.depends.map((d) => `\tdepends = ${d}`),
      ...fields.optdepends.map((d) => `\toptdepends = ${d}`),
      ...fields.provides.map((p) => `\tprovides = ${p}`),
      ...fields.conflicts.map((c) => `\tconflicts = ${c}`),
      ...fields.options.map((o) => `\toptions = ${o}`),
      `\tnoextract = ${deb.fileName}`,
      `\tsource = ${deb.fileName}::${releaseUrl(version, deb.fileName)}`,
      ...fields.sha256sums.map((s) => `\tsha256sums = ${s}`),
      ``,
      `pkgname = ${fields.pkgname}`,
    ].join("\n") + "\n";

  return { PKGBUILD: pkgbuild, ".SRCINFO": srcinfo };
}

/** The `sha256sum` style list of every file the generator saw, for the notes of the release. */
export function checksumList(files) {
  return (
    [...files]
      .sort((a, b) => a.fileName.localeCompare(b.fileName))
      .map((file) => `${file.sha256}  ${file.fileName}`)
      .join("\n") + "\n"
  );
}
