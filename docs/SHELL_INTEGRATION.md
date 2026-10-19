# Shell integration

A shell that Noren starts can tell the terminal where it is and what it is doing, using escape sequences (OSC) that are written into its output. Nothing is run on behalf of the user: the script only prints these sequences, and the interface reads them.

This page describes what exists today (task NOR-F7-01a): the OSC parser and the PowerShell script. The scripts for bash, zsh and cmd come with NOR-F7-01b. Showing the information (sidebar, command marks, notifications) comes with NOR-F7-02, NOR-F7-03 and NOR-F7-04, so no part of the interface reads these events yet.

## What the shell reports

| Sequence                     | Event           | Meaning                                                        |
| ---------------------------- | --------------- | -------------------------------------------------------------- |
| `OSC 7 ; file://host/path`   | `cwd`           | The folder the shell is in (sent at every prompt).             |
| `OSC 133 ; A`                | `prompt-start`  | The prompt starts.                                             |
| `OSC 133 ; B`                | `prompt-end`    | The prompt ended; the user types the command.                  |
| `OSC 133 ; C`                | `command-start` | The command line was accepted and the command starts running.  |
| `OSC 133 ; D [; code]`       | `command-end`   | The command ended, with its exit code when the shell knows it. |
| `OSC 633 ; E ; command line` | `command-line`  | The text of the command, escaped (see below).                  |

`OSC` is `ESC ]`. A sequence ends with BEL (`0x07`) or ST (`ESC \`). The scripts use BEL.

One command gives this order: `A`, the prompt text, `B`, the user types, `E`, `C`, the output of the command, `D;code`, then `7` and `A` of the next prompt. The first prompt has no `D`, and an empty line has none either.

The command line in `OSC 633;E` is limited to its first 2000 characters, and three kinds of characters are written as escapes so that the sequence stays well formed: a backslash is `\\`, and a `;` or a control character (including a new line) is `\xNN` with the hexadecimal character code.

## The parser

`ShellIntegrationParser` in `@noren/model` (`packages/model/src/shell-integration.ts`) turns the output of a session into events. It is pure: no DOM, no Tauri, no timers.

```ts
const parser = new ShellIntegrationParser();
for (const chunk of outputChunks) {
  for (const event of parser.feed(chunk)) {
    // { kind: "cwd", path } | { kind: "prompt-start" } | { kind: "prompt-end" }
    // | { kind: "command-start" } | { kind: "command-end", exitCode } | { kind: "command-line", text }
  }
}
```

- `feed` takes bytes (`Uint8Array`) or text and returns the events that finished in that chunk, in order.
- It reads bytes, so a sequence cut anywhere between two chunks (even inside a multi-byte character) gives the same events as the same bytes in one piece. A property test checks that any way of cutting the stream gives the same events.
- The only thing it keeps between calls is the beginning of a sequence that has not ended. That is capped at `maxOscBytes` (default 8192). A longer sequence is dropped up to its end and the parser carries on with the next one.
- Any OSC that is not one of the above (window title, notifications, ...) is ignored. An ESC that is not followed by `\` inside a sequence, or a CAN or SUB byte, abandons the sequence.
- Text in a sequence comes from a program in the terminal and is not trusted: an `OSC 7` that is not a plain `file:` URL with a path (or whose path has a control character or is longer than 4096 characters) gives no event, and `133;D` takes only a plain integer as code.
- `pathFromFileUri` is the same reading of an `OSC 7` URL that `apps/desktop/src/osc7.ts` does for the recent folders of the palette. The two are kept apart for now; a later task makes the app use the shared one.

## PowerShell

`apps/desktop/src-tauri/resources/shell-integration/noren.ps1` works in PowerShell 7 (`pwsh`) and in Windows PowerShell 5.1.

- It is loaded **after** the user's profile, so the profile runs as usual. The `prompt` function that exists at that point (the user's own, or the default one) is wrapped, not replaced: the script adds the sequences around its output, and gives it the same `$?` it would have had without the wrapper.
- The exit code of `OSC 133;D` is `0` when the command succeeded, the value of `$LASTEXITCODE` when it failed and that is a non-zero number, and `1` for any other failure (a cmdlet error). `$LASTEXITCODE` is not reset by Noren, so a cmdlet error that follows a native command that failed earlier can report that older code.
- `C` and `E` are written when PSReadLine returns the accepted line, by wrapping the `PSConsoleHostReadLine` function (it needs PSReadLine, which every interactive PowerShell console loads). Without PSReadLine the shell still sends `OSC 7`, `A` and `B`, but no `C`, `D` or `E`.
- It changes no setting, writes nothing to disk and starts no process. A second load in the same session does nothing.

### How it is injected

`Profile::spawn_spec_with_integration` in `noren-core` (`crates/noren-core/src/integration.rs`, no Tauri dependency) builds the `SpawnSpec` of a profile. For `pwsh` and Windows PowerShell it appends:

```
-NoLogo -NoExit -Command ". ([scriptblock]::Create([System.IO.File]::ReadAllText('<path>\noren.ps1')))"
```

The script text is compiled by PowerShell itself, so the execution policy of the machine (which only checks script files) does not stop it and is not changed.

The spec is the plain one, without any of this, when:

- the profile has `inject_integration` set to `false` (it is `true` for every detected profile);
- the shell is not PowerShell (bash, zsh and cmd come with NOR-F7-01b);
- the folder with the scripts is not known, or `noren.ps1` is not in it;
- the arguments of the profile already choose what PowerShell runs (`-Command`, `-File`, `-EncodedCommand`).

The profile's own arguments stay first, so `-NoProfile` or `-MTA` in a profile keep their effect. There is no screen to change `inject_integration` yet; the field is what that setting will write.

The folder comes from the app: the script is a bundle resource (`bundle.resources` in `tauri.conf.json`, installed as `resources/shell-integration/noren.ps1` in the resource folder), and `bridge.rs` resolves that folder with Tauri's resource path and hands it to `noren-core`. `noren --smoke` fails when a PowerShell session does not print `OSC 133;A`, which is how a missing resource is caught in a build.

### Tests

- `cargo test -p noren-core` runs PowerShell (`pwsh`, or Windows PowerShell when that is all there is) in a PTY with the script, types `cmd /c exit 3` and checks that the output has `OSC 133;D;3`, with `E` and `C` before it. It also checks that a user prompt defined before the script is kept and sees the right `$?`. When no PowerShell is installed the test prints a warning and returns. No window is opened.
- `pnpm test` covers the parser (`packages/model/src/shell-integration.test.ts`).
