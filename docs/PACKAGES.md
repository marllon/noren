# Package manifests

`pnpm packages:generate` writes the manifests that let people install Noren from winget, Scoop and the AUR. It only writes files: it never uploads, submits or pushes anything. Submitting is a step a maintainer takes by hand, after the release is public (steps below).

There is no Homebrew cask: the release workflow builds no macOS package, and whether macOS is supported is still undecided.

## Generating

1. Bump the version everywhere, build the Windows installers with `pnpm desktop:build` (see [DEV.md](DEV.md#building-installers-windows)) and let the release workflow build the Linux packages for the same tag.
2. Download the `.deb` from the draft release (or take it from the runner), then from the repository root:

```sh
pnpm packages:generate --deb <path to Noren_<version>_amd64.deb>
```

Options (all optional):

| Option               | Meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `--bundle-dir <dir>` | Where `nsis/` and `msi/` are. Default: `release/bundle` of the Cargo target directory.      |
| `--deb <file>`       | The deb of the release. Without it only winget and Scoop are made.                          |
| `--appimage <file>`  | The AppImage of the release. It only gets a line in `SHA256SUMS`.                           |
| `--out <dir>`        | Where to write. Default: `packages/<version>` in the Cargo target directory.                |
| `--targets a,b`      | Any of `winget`, `scoop`, `aur`. Default: `winget,scoop`, plus `aur` when `--deb` is given. |

The version comes from `apps/desktop/src-tauri/tauri.conf.json`. The generator looks for the installers by the exact names Tauri gives them for that version (`Noren_<v>_x64-setup.exe`, `Noren_<v>_x64_en-US.msi`, `Noren_<v>_amd64.deb`); a file left over from another version is refused with a sentence that says so, and a missing one says which build step makes it. Every address is `https://github.com/marllon/noren/releases/download/v<version>/<file>` and every hash is the sha256 of the file it read, so build, generate and upload the very same files.

The output goes under `target/packages/<version>/`, which git ignores (like `target/` as a whole). **Never commit it**: the hashes belong to one build, and the next build of the same version has other hashes. The same input gives the same text, so generating twice changes nothing.

```
target/packages/<version>/
  winget/Marllon.Noren.yaml  Marllon.Noren.installer.yaml  Marllon.Noren.locale.en-US.yaml
  scoop/noren.json
  aur/PKGBUILD  .SRCINFO
  SHA256SUMS
```

The tests (`scripts/packages.vitest.mjs`) run with `pnpm test` and use small fixture files in a temporary folder, with no network.

## What each manifest does

- **winget** (manifest version 1.6.0, three files). Two installers for x64: the NSIS `.exe` (`nullsoft`, per user, silent switch `/S`, no administrator rights) and the MSI (`wix`, per machine, `/qn`). `winget validate --manifest target/packages/<version>/winget` checks the schema locally. The package identifier is `Marllon.Noren`; winget identifiers are `Publisher.Package`, so change it in `scripts/packages-lib.mjs` (`WINGET_ID`) if the publisher name should be another.
- **Scoop** (`scoop/noren.json`). It unpacks the MSI instead of running an installer (`extract_dir` is `PFiles\Noren`, the layout of the unpacked image), so it needs no administrator rights and opens no window. Because no installer runs, the `noren://` link and the uninstall entry of Settings > Apps are not registered, and `scoop update noren` replaces the in-app updater for that install. `checkver` and `autoupdate` follow the new releases of the repository.
- **AUR** (`aur/PKGBUILD` and `.SRCINFO` of `noren-bin`). It downloads the deb of the release and unpacks its `data.tar.*` with `bsdtar` into the package; it depends on `webkit2gtk-4.1` and `gtk3`, and suggests `libayatana-appindicator` for the tray icon. The two files are made from the same fields, so they agree. The package declares the MIT license but installs no `LICENSE` file, because the deb carries none; an AUR maintainer may add the file of the tagged source as a second `source`.

## What the maintainer does to publish

None of this happens before the release is public and the code is signed or the unsigned build is accepted on purpose (NOR-F21-05, NOR-F21-06, NOR-F21-07). Each step below is done by hand, with the maintainer's own accounts.

1. Publish the draft release on GitHub with the NSIS, the MSI, the deb and the AppImage attached (the same files the manifests were made from; check them with `SHA256SUMS`).
2. **winget.** Fork `microsoft/winget-pkgs`, copy the three files to `manifests/m/Marllon/Noren/<version>/`, run `winget validate --manifest <that folder>` and `winget install --manifest <that folder>` on a test machine, then open the pull request. `wingetcreate` or `komac` can fill the `ProductCode` of the MSI, which this generator does not read. Windows may warn about the unsigned installers.
3. **Scoop.** Put `noren.json` in a bucket (a repository of the maintainer, or `ScoopInstaller/Extras` through a pull request) under `bucket/`, then `scoop install <bucket>/noren` on a test machine.
4. **AUR.** On an Arch machine, in an empty folder, copy `PKGBUILD`, run `makepkg --printsrcinfo > .SRCINFO` (it must equal the generated one), `makepkg -si` to build and install, and `namcap PKGBUILD`; then `git push` to `ssh://aur@aur.archlinux.org/noren-bin.git` as the AUR account holder.

Every later version repeats the generation with the new files. The generator was checked here with `winget validate` and with tests; the Scoop install and the `makepkg` build need Scoop and Arch and were not run (see the report of NOR-F20-03).
