# Contributing to Noren

Thanks for your interest. Noren is pre-alpha, so things move fast. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Requirements

- Node.js 24 or newer, with pnpm through corepack
- Rust stable (MSVC toolchain on Windows)
- git

Step-by-step setup for Windows, macOS and Linux is in [docs/DEV.md](docs/DEV.md).

Then install dependencies from the repository root:

```sh
pnpm install
```

## Commands

Run everything from the repository root.

| Command                    | What it does                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`              | Full check: typecheck, lint (ESLint and Prettier), Vitest, and `rust:check` (`cargo fmt`, `clippy`, `cargo test`) |
| `pnpm format`              | Format everything with Prettier (it covers Markdown too)                                                          |
| `pnpm e2e`                 | Functional end-to-end tests (Playwright in web mode)                                                              |
| `pnpm smoke`               | Builds the desktop app and runs `noren --smoke`, which must exit with 0                                           |
| `pnpm licenses:check`      | Checks that dependency licenses are on the allowed list                                                           |
| `cargo test -p noren-core` | Fast loop for the Rust core only                                                                                  |

Run `pnpm verify` before every commit. Tests never access the external network.

## Commits

Messages are in English and follow `<scope or task ID>: <what changed>`, for example:

```
NOR-F2-01: PTY session manager with batched reads
```

Keep each commit focused, and include tests with behavior changes.

## Dependency licenses

Production dependencies (npm packages and crates) must use one of: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, CC0-1.0, Unicode-3.0, Unicode-DFS-2016, BlueOak-1.0.0, or MPL-2.0 (crates used unmodified only).

Development-only dependencies (tests, lint, build) may also use MPL-2.0. Fonts must be OFL-1.1. Third-party themes need a permissive license and an entry in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Explain the reason for every new dependency in your pull request.

## Language

Code, identifiers, comments, commit messages, documentation and user interface text are written in English.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
