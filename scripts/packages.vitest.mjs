// Vitest tests of the package manifest generator (NOR-F20-03). The installers are tiny fixture
// files in a temporary folder; nothing here touches the network or the real target/ folder.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, parseArgs } from "./packages.mjs";
import {
  aurFiles,
  assertInstallerName,
  checksumList,
  releaseUrl,
  scoopManifest,
  sha256Hex,
  versionFromTauriConf,
  wingetManifests,
  yamlScalar,
} from "./packages-lib.mjs";

const VERSION = "1.2.3";
const BODIES = {
  nsis: "nsis fixture",
  msi: "msi fixture",
  deb: "deb fixture",
  appimage: "appimage fixture",
};
const sha = (text) => createHash("sha256").update(text).digest("hex");
const info = (kind, version = VERSION) => ({
  fileName: {
    nsis: `Noren_${version}_x64-setup.exe`,
    msi: `Noren_${version}_x64_en-US.msi`,
    deb: `Noren_${version}_amd64.deb`,
    appimage: `Noren_${version}_amd64.AppImage`,
  }[kind],
  sha256: sha(BODIES[kind]),
});
const BASE = `https://github.com/marllon/noren/releases/download/v${VERSION}`;

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "noren-packages-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A bundle folder shaped like the one `tauri build` leaves, with fixture files. */
function bundle(name, version = VERSION, { nsis = true, msi = true } = {}) {
  const base = join(dir, name);
  mkdirSync(join(base, "nsis"), { recursive: true });
  mkdirSync(join(base, "msi"), { recursive: true });
  if (nsis) writeFileSync(join(base, "nsis", info("nsis", version).fileName), BODIES.nsis);
  if (msi) writeFileSync(join(base, "msi", info("msi", version).fileName), BODIES.msi);
  const debPath = join(base, info("deb", version).fileName);
  writeFileSync(debPath, BODIES.deb);
  const appImagePath = join(base, info("appimage", version).fileName);
  writeFileSync(appImagePath, BODIES.appimage);
  return { base, debPath, appImagePath };
}

describe("version", () => {
  it("is read from tauri.conf.json", () => {
    expect(versionFromTauriConf('{"version":"0.1.0"}')).toBe("0.1.0");
  });

  it("is the version of the real tauri.conf.json", () => {
    const real = readFileSync(
      fileURLToPath(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)),
      "utf8",
    );
    expect(versionFromTauriConf(real)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("refuses a pre-release suffix, a missing version and bad JSON", () => {
    expect(() => versionFromTauriConf('{"version":"0.1.0-dev"}')).toThrow(
      /plain major\.minor\.patch/,
    );
    expect(() => versionFromTauriConf("{}")).toThrow(/found undefined/);
    expect(() => versionFromTauriConf("{")).toThrow(/not valid JSON/);
  });
});

describe("file names and hashes", () => {
  it("hashes bytes as sha256 in lower case hex", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("builds the release address of a file", () => {
    expect(releaseUrl(VERSION, "Noren_1.2.3_x64_en-US.msi")).toBe(
      `${BASE}/Noren_1.2.3_x64_en-US.msi`,
    );
  });

  it("accepts the name Tauri gives and says which version a stale file is for", () => {
    expect(() => assertInstallerName("nsis", info("nsis").fileName, VERSION)).not.toThrow();
    expect(() => assertInstallerName("nsis", "Noren_0.9.0_x64-setup.exe", VERSION)).toThrow(
      /for version 0\.9\.0 but tauri\.conf\.json says 1\.2\.3/,
    );
    expect(() => assertInstallerName("deb", "noren.deb", VERSION)).toThrow(
      /should be called Noren_1\.2\.3_amd64\.deb/,
    );
  });

  it("quotes a YAML scalar only when it must", () => {
    expect(yamlScalar("1.2.3")).toBe('"1.2.3"');
    expect(yamlScalar("Noren contributors")).toBe("Noren contributors");
    expect(yamlScalar("a: b")).toBe('"a: b"');
    expect(yamlScalar("yes")).toBe('"yes"');
  });

  it("lists the files as sha256sum does", () => {
    expect(checksumList([info("msi"), info("deb")])).toBe(
      `${sha(BODIES.deb)}  Noren_1.2.3_amd64.deb\n${sha(BODIES.msi)}  Noren_1.2.3_x64_en-US.msi\n`,
    );
  });
});

describe("winget", () => {
  const files = wingetManifests({ version: VERSION, nsis: info("nsis"), msi: info("msi") });

  it("writes the version, installer and locale files of one package", () => {
    expect(Object.keys(files).sort()).toEqual([
      "Marllon.Noren.installer.yaml",
      "Marllon.Noren.locale.en-US.yaml",
      "Marllon.Noren.yaml",
    ]);
    for (const text of Object.values(files)) {
      expect(text).toContain("PackageIdentifier: Marllon.Noren");
      expect(text).toContain('PackageVersion: "1.2.3"');
      expect(text).toContain("ManifestVersion: 1.6.0");
    }
  });

  it("has the fields winget requires in each file", () => {
    expect(files["Marllon.Noren.yaml"]).toMatch(/DefaultLocale: en-US\nManifestType: version/);
    const locale = files["Marllon.Noren.locale.en-US.yaml"];
    for (const field of [
      "PackageLocale: en-US",
      "Publisher:",
      "PackageName: Noren",
      "License: MIT",
      "ShortDescription:",
      "ManifestType: defaultLocale",
    ]) {
      expect(locale).toContain(field);
    }
    expect(files["Marllon.Noren.installer.yaml"]).toContain("ManifestType: installer");
  });

  it("lists the per-user NSIS and the per-machine MSI with the right address and hash", () => {
    const installer = files["Marllon.Noren.installer.yaml"];
    expect(installer).toContain("InstallerType: nullsoft\n    Scope: user");
    expect(installer).toContain("InstallerType: wix\n    Scope: machine");
    expect(installer).toContain(`InstallerUrl: ${BASE}/Noren_1.2.3_x64-setup.exe`);
    expect(installer).toContain(`InstallerUrl: ${BASE}/Noren_1.2.3_x64_en-US.msi`);
    expect(installer).toContain(`InstallerSha256: ${sha(BODIES.nsis).toUpperCase()}`);
    expect(installer).toContain(`InstallerSha256: ${sha(BODIES.msi).toUpperCase()}`);
    expect(installer).toContain("Silent: /S");
  });

  it("refuses an installer of another version or without a hash", () => {
    expect(() =>
      wingetManifests({ version: VERSION, nsis: info("nsis", "9.9.9"), msi: info("msi") }),
    ).toThrow(/does not match the app/);
    expect(() => wingetManifests({ version: VERSION, nsis: info("nsis") })).toThrow(
      /MSI installer is missing/,
    );
    expect(() =>
      wingetManifests({
        version: VERSION,
        nsis: { ...info("nsis"), sha256: "xyz" },
        msi: info("msi"),
      }),
    ).toThrow(/not 64 lower case hex/);
  });
});

describe("Scoop", () => {
  const manifest = JSON.parse(scoopManifest({ version: VERSION, msi: info("msi") }));

  it("has the fields Scoop requires, with the MSI address and hash", () => {
    expect(manifest.version).toBe(VERSION);
    expect(manifest.description).toBeTruthy();
    expect(manifest.homepage).toBe("https://github.com/marllon/noren");
    expect(manifest.license).toBe("MIT");
    expect(manifest.architecture["64bit"]).toEqual({
      url: `${BASE}/Noren_1.2.3_x64_en-US.msi`,
      hash: sha(BODIES.msi),
    });
  });

  it("unpacks the MSI instead of running an installer (no administrator, no window)", () => {
    expect(manifest.extract_dir).toBe("PFiles\\Noren");
    expect(manifest.installer).toBeUndefined();
    expect(manifest.bin).toContain("noren.exe");
    expect(manifest.shortcuts).toEqual([["noren.exe", "Noren"]]);
  });

  it("follows new releases", () => {
    expect(manifest.checkver).toEqual({ github: "https://github.com/marllon/noren" });
    expect(manifest.autoupdate.architecture["64bit"].url).toBe(
      "https://github.com/marllon/noren/releases/download/v${version}/Noren_${version}_x64_en-US.msi",
    );
  });

  it("refuses a missing MSI", () => {
    expect(() => scoopManifest({ version: VERSION })).toThrow(/MSI installer is missing/);
  });
});

describe("AUR", () => {
  const { PKGBUILD, ".SRCINFO": SRCINFO } = aurFiles({ version: VERSION, deb: info("deb") });
  const srcinfoValues = (key) =>
    [...SRCINFO.matchAll(new RegExp(`^\\t${key} = (.*)$`, "gm"))].map((match) => match[1]);
  /** Words of a bash array `name=('a' "b")` in the PKGBUILD, with the quotes taken off. */
  const pkgbuildArray = (name) => {
    const body = new RegExp(`^${name}=\\((.*)\\)$`, "m").exec(PKGBUILD)?.[1] ?? "";
    return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => match[1] ?? match[2]);
  };
  const expand = (text) => text.replaceAll("${pkgver}", VERSION);

  it("is a -bin package of the deb at the release address, with its hash", () => {
    expect(PKGBUILD).toContain("pkgname=noren-bin\n");
    expect(PKGBUILD).toContain(`pkgver=${VERSION}\n`);
    expect(PKGBUILD).toContain(`sha256sums=('${sha(BODIES.deb)}')`);
    expect(pkgbuildArray("source").map(expand)).toEqual([
      `Noren_${VERSION}_amd64.deb::${BASE}/Noren_${VERSION}_amd64.deb`,
    ]);
    expect(PKGBUILD).toContain("package() {");
    expect(PKGBUILD).toContain("bsdtar");
  });

  it("has a .SRCINFO that says what the PKGBUILD says", () => {
    expect(SRCINFO).toMatch(/^pkgbase = noren-bin\n/);
    expect(SRCINFO).toMatch(/\npkgname = noren-bin\n$/);
    expect(srcinfoValues("pkgver")).toEqual([VERSION]);
    expect(srcinfoValues("pkgrel")).toEqual(["1"]);
    expect(srcinfoValues("sha256sums")).toEqual([sha(BODIES.deb)]);
    expect(srcinfoValues("source")).toEqual(pkgbuildArray("source").map(expand));
    expect(srcinfoValues("noextract")).toEqual(pkgbuildArray("noextract").map(expand));
    for (const key of [
      "arch",
      "license",
      "depends",
      "optdepends",
      "provides",
      "conflicts",
      "options",
    ]) {
      expect(srcinfoValues(key)).toEqual(pkgbuildArray(key));
    }
    expect(srcinfoValues("url")).toEqual(["https://github.com/marllon/noren"]);
  });

  it("uses tabs for the keys and nothing but spaces around the equal sign", () => {
    for (const line of SRCINFO.split("\n").filter((l) => l.startsWith("\t"))) {
      expect(line).toMatch(/^\t[a-z0-9]+ = \S/);
    }
  });

  it("refuses a deb of another version or no deb", () => {
    expect(() => aurFiles({ version: VERSION, deb: info("deb", "0.0.1") })).toThrow(
      /for version 0\.0\.1 but tauri\.conf\.json says 1\.2\.3/,
    );
    expect(() => aurFiles({ version: VERSION })).toThrow(/deb package is missing/);
  });
});

describe("command line and generate()", () => {
  it("reads the options and refuses what it does not know", () => {
    expect(parseArgs(["--deb", "a.deb", "--targets", "aur,winget"])).toEqual({
      deb: "a.deb",
      targets: ["aur", "winget"],
    });
    expect(() => parseArgs(["--publish"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--deb"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--targets", "brew"])).toThrow(/unknown target "brew"/);
  });

  it("writes the three kinds of manifest and the checksums, and nothing for Homebrew", () => {
    const { base, debPath, appImagePath } = bundle("all");
    const out = join(dir, "all-out");
    const written = generate({
      version: VERSION,
      bundleDir: base,
      deb: debPath,
      appimage: appImagePath,
      out,
    });
    expect(written.sort()).toEqual([
      "SHA256SUMS",
      "aur/.SRCINFO",
      "aur/PKGBUILD",
      "scoop/noren.json",
      "winget/Marllon.Noren.installer.yaml",
      "winget/Marllon.Noren.locale.en-US.yaml",
      "winget/Marllon.Noren.yaml",
    ]);
    expect(readdirSync(out).sort()).toEqual(["SHA256SUMS", "aur", "scoop", "winget"]);
    const everything = written.map((file) => readFileSync(join(out, file), "utf8")).join("\n");
    expect(everything).not.toMatch(/homebrew|cask/i);
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8");
    expect(sums).toContain(`${sha(BODIES.appimage)}  Noren_1.2.3_amd64.AppImage`);
    expect(sums.trim().split("\n")).toHaveLength(4);
  });

  it("makes only winget and Scoop without a deb, and is the same text on a second run", () => {
    const { base } = bundle("win");
    const first = generate({ version: VERSION, bundleDir: base, out: join(dir, "win-1") });
    const second = generate({ version: VERSION, bundleDir: base, out: join(dir, "win-2") });
    expect(first).toEqual(second);
    expect(first.some((file) => file.startsWith("aur/"))).toBe(false);
    for (const file of first) {
      expect(readFileSync(join(dir, "win-1", file), "utf8")).toBe(
        readFileSync(join(dir, "win-2", file), "utf8"),
      );
    }
  });

  it("says which installer is missing, and what the folder has instead", () => {
    const { base } = bundle("stale", "0.9.0");
    expect(() => generate({ version: VERSION, bundleDir: base, out: join(dir, "x") })).toThrow(
      /NSIS installer was not found at .*Noren_1\.2\.3_x64-setup\.exe; the folder has Noren_0\.9\.0_x64-setup\.exe/,
    );
    const { base: noMsi } = bundle("nomsi", VERSION, { msi: false });
    expect(() => generate({ version: VERSION, bundleDir: noMsi, out: join(dir, "y") })).toThrow(
      /MSI installer was not found/,
    );
  });

  it("refuses the AUR without a deb and a deb of another version", () => {
    const { base, debPath } = bundle("aur-only");
    expect(() =>
      generate({ version: VERSION, bundleDir: base, out: join(dir, "z"), targets: ["aur"] }),
    ).toThrow(/pass its path with --deb/);
    const stale = join(base, "Noren_0.0.1_amd64.deb");
    writeFileSync(stale, BODIES.deb);
    expect(() =>
      generate({
        version: VERSION,
        bundleDir: base,
        deb: stale,
        out: join(dir, "w"),
        targets: ["aur"],
      }),
    ).toThrow(/for version 0\.0\.1/);
    expect(debPath).toBeTruthy();
  });
});
