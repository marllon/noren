# Third-party notices

Noren is licensed under the [MIT License](LICENSE). It directly depends on the following third-party production dependencies. Licenses were read from the installed package manifests (npm) and `cargo metadata` (crates). Transitive dependencies are covered by `pnpm licenses:check`.

## npm packages

| Package                                                  | Version | License           |
| -------------------------------------------------------- | ------- | ----------------- |
| [`@tauri-apps/api`](https://github.com/tauri-apps/tauri) | 2.12.4  | Apache-2.0 OR MIT |
| [`react`](https://github.com/react/react)                | 19.3.1  | MIT               |
| [`react-dom`](https://github.com/react/react)            | 19.3.1  | MIT               |

## Rust crates

| Crate                                                                             | Version | License           | Use                                                                       |
| --------------------------------------------------------------------------------- | ------- | ----------------- | ------------------------------------------------------------------------- |
| [`tauri`](https://github.com/tauri-apps/tauri)                                    | 2.12.4  | Apache-2.0 OR MIT | Desktop shell                                                             |
| [`tauri-build`](https://github.com/tauri-apps/tauri)                              | 2.7.3   | Apache-2.0 OR MIT | Build dependency of the desktop app                                       |
| [`portable-pty`](https://github.com/wezterm/wezterm)                              | 0.9.0   | MIT               | Pseudo terminal sessions (ConPTY)                                         |
| [`tauri-plugin-deep-link`](https://github.com/tauri-apps/plugins-workspace)       | 2.6.2   | Apache-2.0 OR MIT | Declares the `noren://` scheme for the installer; delivers links on macOS |
| [`tauri-plugin-single-instance`](https://github.com/tauri-apps/plugins-workspace) | 2.5.4   | Apache-2.0 OR MIT | A second launch hands its links to the running app                        |
| [`serde_json`](https://github.com/serde-rs/json)                                  | 1.0.154 | MIT OR Apache-2.0 | Needed by the Tauri context macro for the plugin configuration            |

## Themes and fonts

No third-party themes or fonts are bundled yet. Any that are added will be listed here with their license and attribution.
