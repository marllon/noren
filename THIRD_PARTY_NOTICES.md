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
| [`tauri-plugin-dialog`](https://github.com/tauri-apps/plugins-workspace)          | 2.8.3   | Apache-2.0 OR MIT | The file chooser of the system for the background picture                 |
| [`serde_json`](https://github.com/serde-rs/json)                                  | 1.0.154 | MIT OR Apache-2.0 | Needed by the Tauri context macro for the plugin configuration            |
| [`fontdb`](https://github.com/RazrFalcon/fontdb)                                  | 0.24.0  | MIT               | Lists the monospaced fonts installed on the machine                       |

## Themes

Noren Dusk and Noren Paper are Noren's own. The other six built-in themes are ports of color schemes published under the MIT license. The names in Noren are Noren's own; the scheme each one comes from is named only here. A port keeps the colors of its source. The few colors that were changed, and why, are listed below the table. The licenses were read from the `LICENSE` file of each source repository, and the full text of each is reproduced after the table, as the licenses require.

| Theme in Noren   | Based on                           | Source repository                                         | License file                                                                      | License | Copyright holder         |
| ---------------- | ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- | ------- | ------------------------ |
| Noren Nightshade | Dracula                            | <https://github.com/dracula/dracula-theme>                | <https://github.com/dracula/dracula-theme/blob/main/LICENSE>                      | MIT     | Dracula Theme (2023)     |
| Noren Fjord      | Nord                               | <https://github.com/nordtheme/nord>                       | <https://github.com/nordtheme/nord/blob/develop/license>                          | MIT     | Sven Greb (2016-present) |
| Noren Midnight   | Tokyo Night                        | <https://github.com/tokyo-night/tokyo-night-vscode-theme> | <https://github.com/tokyo-night/tokyo-night-vscode-theme/blob/master/LICENSE.txt> | MIT     | Enkia (2018-present)     |
| Noren Meadow     | Everforest (dark, medium contrast) | <https://github.com/sainnhe/everforest>                   | <https://github.com/sainnhe/everforest/blob/master/LICENSE>                       | MIT     | sainnhe (2019)           |
| Noren Dune       | Solarized (light)                  | <https://github.com/altercation/solarized>                | <https://github.com/altercation/solarized/blob/master/LICENSE>                    | MIT     | Ethan Schoonover (2011)  |
| Noren Oat        | Catppuccin (Latte)                 | <https://github.com/catppuccin/catppuccin>                | <https://github.com/catppuccin/catppuccin/blob/main/LICENSE>                      | MIT     | Catppuccin (2021)        |

The Noren Oat colors were checked against the palette repository of the same project, <https://github.com/catppuccin/palette> (MIT, Copyright (c) 2021 Catppuccin).

### What was changed from the sources

Only for contrast, so that text on the background reaches 4.5:1 (WCAG 2.x level AA), which a test checks for all eight themes:

- Noren Dune: the text of the interface and the foreground of the terminal are the source's emphasized text color `#586e75` (5.0:1 on the background) instead of its body text color `#657b83` (4.1:1). The body text color stays as the muted color.
- Noren Fjord: the muted text color of the interface is the source's blue-gray `#81a1c1` (4.6:1) instead of its comment gray `#616e88` (2.4:1).

Where a source has no color for a part of Noren's format, one was derived and nothing else was touched: the selection of Noren Dune (the source's `#93a1a1` with an alpha of 0.3) and its border (a tint between the source's `#eee8d5` and `#93a1a1`), and the choice of which palette colors serve as surface, border, muted text and accent in the interface of each port.

### License texts

#### Dracula

```text
The MIT License (MIT)

Copyright (c) 2023 Dracula Theme

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### Nord

```text
MIT License (MIT)

Copyright (c) 2016-present Sven Greb <development@svengreb.de> (https://www.svengreb.de)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### Tokyo Night

```text
The MIT License (MIT)

Copyright (c) 2018-present Enkia

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### Everforest (dark, medium contrast)

```text
MIT License

Copyright (c) 2019 sainnhe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### Solarized (light)

```text
Copyright (c) 2011 Ethan Schoonover

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### Catppuccin (Latte)

```text
MIT License

Copyright (c) 2021 Catppuccin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts

No third-party fonts are bundled yet. Any that are added will be listed here with their license and attribution.
