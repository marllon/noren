# Shell integration

A shell that Noren starts can tell the terminal where it is and what it is doing, using escape sequences (OSC) that are written into its output. Nothing is run on behalf of the user: the script only prints these sequences, and the interface reads them.

This page describes what exists today (tasks NOR-F7-01a, NOR-F7-01b and NOR-F7-02a): the OSC parser, the scripts for PowerShell, bash, zsh and cmd, and the folder and git branch of each pane in the sidebar. The last command, its exit code and duration and the automatic tab title (NOR-F7-02b), command marks (NOR-F7-03) and notifications (NOR-F7-04) come later, so nothing else in the interface reads these events yet.

| Shell                               | Folder  | Prompt `A`/`B` | `C`, `D` with exit code | `E` command line |
| ----------------------------------- | ------- | -------------- | ----------------------- | ---------------- |
| PowerShell 7 and Windows PowerShell | OSC 7   | yes            | yes (needs PSReadLine)  | yes              |
| bash (Git Bash, Linux, macOS)       | OSC 7   | yes            | yes                     | yes              |
| zsh                                 | OSC 7   | yes            | yes                     | yes              |
| cmd                                 | OSC 9;9 | yes            | no (see below)          | no               |

## What the shell reports

| Sequence                     | Event           | Meaning                                                        |
| ---------------------------- | --------------- | -------------------------------------------------------------- |
| `OSC 7 ; file://host/path`   | `cwd`           | The folder the shell is in (sent at every prompt).             |
| `OSC 9 ; 9 ; path`           | `cwd`           | The same, in the form cmd can write (see the cmd section).     |
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
- `OSC 9` is also the notification sequence (and `9;4` a progress bar), which NOR-F7-04 will read. The parser takes only `9;9;path` as a folder, and only when the path is absolute (a drive letter, or a leading `/` or `\`), has no control character, is at most 4096 characters, and may be in double quotes. Backslashes become `/`, so `C:\Users\me` is `C:/Users/me`, like an `OSC 7` path. Any other `OSC 9` gives no event here.
- Text in a sequence comes from a program in the terminal and is not trusted: an `OSC 7` that is not a plain `file:` URL with a path (or whose path has a control character or is longer than 4096 characters) gives no event, and `133;D` takes only a plain integer as code.
- `pathFromFileUri` is the same reading of an `OSC 7` URL that `apps/desktop/src/osc7.ts` does for the recent folders of the palette. The two are kept apart for now: the recent folders still come from the OSC 7 handler of xterm.js, and the folder and branch of a pane (next section) come from the parser; a later task makes the app use the shared one.

## Folder and git branch of a pane

Each pane of the app has one `PaneLocationTracker` (`packages/model/src/pane-location.ts`), made once when the pane's view is created, and it owns the `ShellIntegrationParser` of that pane's session. `TerminalView` hands it every chunk of the session's output (the same bytes it writes to xterm.js), so the parser never lives in a React render. The tracker turns the events into the `pane/set-location` action of the reducer, which sets the pane's `cwd` and `gitBranch` together and changes nothing when the pane already has both.

- **When the branch is read.** The folder comes from `OSC 7` (or `OSC 9;9` in cmd). The branch of that folder is read again at every `OSC 133;A` (the prompt starts), every `OSC 133;D` (a command ended) and every folder report, because a command such as `git switch` changes the branch without changing the folder. A chunk with several of these, which is what a prompt sends, gives one lookup, and only one lookup is in flight at a time (requests that come meanwhile are replaced by the newest).
- **How it is read.** `Backend.gitInfo(cwd)` returns `{ branch, detached }` or `null`. The Tauri backend calls the `git_info` command, which runs `read_head` of `noren-core` (`crates/noren-core/src/git.rs`) on a blocking thread. It never runs `git`: it walks up from the folder to the first one with a `.git` that holds a usable `HEAD`.
  - `.git` is a folder: its `HEAD` is read.
  - `.git` is a file (a linked worktree, a submodule): its `gitdir:` line names the folder with the real `HEAD`, absolute or relative to the file.
  - `HEAD` is `ref: refs/heads/<name>`: the branch is `<name>` (slashes kept). `HEAD` is a 40 or 64 digit commit id: it is detached and the branch is shown as its first 7 characters.
  - A repository in the `reftable` format keeps the stub `ref: refs/heads/.invalid` in `HEAD` and its real branch in files this module does not read, so it shows no branch.
  - A `.git` that cannot be used (no `HEAD`, a `HEAD` that is neither of the above, a `gitdir:` that points nowhere) is skipped, as `git` does, so a stray `.git` does not hide the repository above it. The result is `null` outside any repository, and for a path that is not absolute.
  - The folder comes from terminal output, so nothing in it is trusted: only a `.git` entry and a `HEAD` are read, at most 4096 bytes of each, never a pipe or device, and a branch name with a control character or over 1024 characters is not used.
- **A failed lookup** (the bridge fails) counts as no branch: the folder is still recorded, and a wrong branch in the sidebar would be worse than none.
- **The folder a shell starts in.** A pane that has no folder (a new tab in a space without a start folder) starts in the default folder of its shell, which the app did not choose. The first folder the shell reports is not recorded as the pane's folder, because the pane would look the same restored without one; its branch is still read. From the moment the shell leaves that folder the folder is recorded, and it is recorded when the shell comes back to it too. A pane that has a folder (restored, or started in one) records every report.
- **Saved.** `cwd` and `gitBranch` are part of the saved state, so a restored pane starts its new shell in the last folder it reported, and its branch is read again at the first prompt (and removed when the repository is gone).
- **Shells without integration** (fish, `wsl.exe`, a profile with `inject_integration` off) report nothing, so their panes keep the folder they had.
- **Web mode and tests.** `FakeBackend` takes `gitRepos` (a folder to `{ branch, detached }`) and `setGitRepo`; a folder is in the repository of the nearest folder above it that has one. The web build reads its repositories from the browser storage key `noren.web.git`, a JSON object from the folder that holds a repository to its branch (`{ "/proj": "main" }`) or to `{ "branch": "0123abc", "detached": true }`; the key is read at every lookup, so a test can change the branch while the page runs.

## Last command, running command and tab title

The same tracker follows the commands of the shell and tells `onCommand`; the app turns that into the `pane/command-start` and `pane/command-end` actions through `store.setPaneCommand`.

- **The events.** `OSC 633;E` carries the command line and arrives before the command runs; `OSC 133;C` is the start; `OSC 133;D;<code>` is the end. The tracker keeps the line until `C` takes it, remembers when `C` came, and at `D` reports the end with the exit code and the duration (the time between the two on its clock; tests inject one, the app uses the wall clock, and web mode uses the clock of the fake shell).
- **Odd streams.** A `D` with no `E` and no `C` before it (the first prompt of some shells) is not a command and reports nothing. A prompt (`133;A`) that comes while a command is running ends it without an exit code, so a command whose `D` was lost cannot stay "running". An `E` and a `D` with no `C` is reported at the end, without a duration. Shells that send no `633;E` (cmd, which sends no `C` or `D` either) show nothing.
- **In the pane.** `Pane.runningCommand` (`{ text? }`) is set from `C` and cleared at the end or when the shell exits; `Pane.lastCommand` (`{ text?, exitCode?, durationMs? }`, which the model already had) is set at the end, from the line that was running when the end does not repeat it. `Pane.status` stays the state of the session (`running`, `idle`, `exited`). The text is trimmed and cut at 500 characters; an exit code is kept when it is a whole number and a duration when it is not negative. Both actions change nothing when the pane already has the result. `lastCommand` is saved with the tab; `runningCommand` belongs to a shell that is gone, so a restored pane starts without it.
- **In the sidebar.** A tab with one pane shows a line under the folder and branch: the command line (cut by the stylesheet, the full text in its tooltip), then `exit N` and how long it took (`<1s`, `2.5s`, `12s`, `3m 05s`, `1h 02m`), or `running` while it runs. The line of a failed command (a code other than 0) is marked. A split tab shows the line of each pane in its pane list, and on the tab itself only when that list is folded (then it is the focused pane's). A tab with a command running gets the running mark. The words for assistive technology say `Running <command>` or `Last command <command>, exit N, <time>`.
- **The automatic title.** A tab whose title the user did not choose is named after its focused pane: the program of the running command (`npm run build` is `npm`; a path, a Windows extension, quotes and leading `NAME=value` words are dropped), else the last part of the folder (`~` for the home folder), else nothing, and the tab goes back to its number. The rule is `autoTitleAction` in `apps/desktop/src/auto-title.ts`; it dispatches `item/rename` with the source `process`, which the reducer ignores while the title is locked, and the store applies it after every location or command report and right after the user clears a title. A title the user typed is locked and never changes. A fresh tab in a pane with no folder is not named after the folder the shell started in (see above), so it keeps its number until the shell leaves it.

## PowerShell

`apps/desktop/src-tauri/resources/shell-integration/noren.ps1` works in PowerShell 7 (`pwsh`) and in Windows PowerShell 5.1.

- It is loaded **after** the user's profile, so the profile runs as usual. The `prompt` function that exists at that point (the user's own, or the default one) is wrapped, not replaced: the script adds the sequences around its output, and gives it the same `$?` it would have had without the wrapper.
- The exit code of `OSC 133;D` is `0` when the command succeeded, the value of `$LASTEXITCODE` when it failed and that is a non-zero number, and `1` for any other failure (a cmdlet error). `$LASTEXITCODE` is not reset by Noren, so a cmdlet error that follows a native command that failed earlier can report that older code.
- `C` and `E` are written when PSReadLine returns the accepted line, by wrapping the `PSConsoleHostReadLine` function (it needs PSReadLine, which every interactive PowerShell console loads). Without PSReadLine the shell still sends `OSC 7`, `A` and `B`, but no `C`, `D` or `E`.
- It changes no setting, writes nothing to disk and starts no process. A second load in the same session does nothing.

## bash

`apps/desktop/src-tauri/resources/shell-integration/noren.bash` works in bash 3.2 and newer (Git for Windows ships 5.x). Keep it ASCII with LF line ends (`.gitattributes` forces LF).

- Bash reads no startup file when it is given `--rcfile`, and it ignores `--rcfile` in a login shell. So Noren starts bash as `bash --rcfile <script> <profile arguments> -i`, and the script first loads what the user would have got without it:
  - a login profile (the Git Bash profile is `--login -i`): `/etc/profile`, then the first of `~/.bash_profile`, `~/.bash_login` and `~/.profile`. Noren takes `--login` / `-l` out of the arguments and sets `NOREN_BASH_LOGIN=1` for the script (which unsets it);
  - any other profile: `/etc/bash.bashrc` when it exists, then `~/.bashrc`.
- The user's `PS1` and `PROMPT_COMMAND` stay. `PS1` is wrapped with `A` and `B` (again whenever a prompt command of the user rebuilds it). `PROMPT_COMMAND`, a string or an array (bash 5.1+), gets one function before the user's commands, which reads `$?` and writes `D` and `OSC 7`, and one after them, which wraps `PS1`. They hand `$?` on unchanged.
- `C` and `E` come from a `DEBUG` trap, which bash runs before each simple command; the first one of a line writes `E` (from `history 1`, so a line the history does not keep, with `HISTCONTROL=ignorespace` or `ignoredups`, has `C` and `D` but no `E`) and `C`. The trap does not see a line that starts with a subshell, such as `(exit 3)`. For that the function before the user's commands checks, at the next prompt, whether the history moved since the last one: if it did, it writes `E` and `C` just before `D`.
- If the files of the user already set a `DEBUG` trap (bash-preexec and some prompt frameworks do), Noren leaves it alone. Every command is then reported when it ends, with `E`, `C` and `D` together before the next prompt.
- On Windows (Git Bash) the folder is written as a Windows path: `/c/Users/me` becomes `C:/Users/me`, and other places, such as `/usr/bin`, go through `cygpath -m`. The `bash.exe` in the Windows system folder is the launcher of the Windows Subsystem for Linux, not a bash, and is never touched; WSL profiles (`wsl.exe -d ...`) are not touched either.

## zsh

`apps/desktop/src-tauri/resources/shell-integration/zsh/` holds `.zshenv`, `.zprofile`, `.zshrc` and `noren.zsh`.

- Noren starts zsh with `ZDOTDIR` pointing at that folder, and `NOREN_USER_ZDOTDIR` holding the user's own `ZDOTDIR` (empty when there is none). zsh reads the dotfiles of the folder; each one loads the user's file of the same name, with `ZDOTDIR` set to the user's folder while it runs (a `ZDOTDIR` the user sets in `.zshenv` is followed). `.zshrc` loads the user's `.zshrc`, then gives `ZDOTDIR` back to the user for good (unset when there was none, so `.zlogin`, `.zlogout` and the programs started from the shell see what they would have seen), then loads `noren.zsh`.
- `noren.zsh` wraps `PROMPT` (with `%{ %}` around `A` and `B`, again whenever a hook of the user rebuilds it) and puts one hook first and one last in `precmd_functions`: the first reads `$?` and writes `D` and `OSC 7`, the last wraps the prompt. A `preexec` hook writes `E` (the line as typed) and `C`. Every function starts with `emulate -L zsh`, so options such as `KSH_ARRAYS` do not change it.
- A `precmd` function the user defined by name (not through `precmd_functions`) runs before these hooks and may change `$?` for them.
- Nested interactive zsh shells started from inside the session read the user's files only, since `ZDOTDIR` was given back.

## cmd

cmd has no startup file and no hook, only the `PROMPT` environment variable, so that is all Noren changes. It sets `PROMPT` for the session to:

```
$E]9;9;$P$E\$E]133;A$E\<the user's PROMPT, or $P$G>$E]133;B$E\
```

`$E` is ESC and `$P` the current folder. cmd has no code for BEL, so the sequences end with ST (`ESC \`), which the parser reads. The folder travels as `OSC 9;9` (a plain path, `C:\Users\me`), which is why the parser reads that sequence; it is sent at each prompt, so `cd` is followed.

What cmd cannot give: the exit code and the command line. `%ERRORLEVEL%` in a prompt is read when the prompt is set, not when it is shown, and cmd does not tell the prompt which command ran. So cmd sends no `OSC 133;D`, `C` or `633;E`: only the folder and the prompt start and end. If the user's `PROMPT` variable already holds `$E]133;A`, Noren leaves it as it is. A `prompt` command typed in the session replaces the variable and ends the integration for that session.

## How it is injected

`Profile::spawn_spec_with_integration` in `noren-core` (`crates/noren-core/src/integration.rs`, no Tauri dependency) builds the `SpawnSpec` of a profile. The shell is recognised from the program name (`pwsh`, `powershell`, `bash`, `zsh`, `cmd`, with or without `.exe`).

| Shell                | What the spec gets                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pwsh`, `powershell` | `-NoLogo -NoExit -Command ". ([scriptblock]::Create([System.IO.File]::ReadAllText('<path>\noren.ps1')))"` appended                                |
| `bash`               | `--rcfile <path>/noren.bash`, then the profile's arguments without `--login`/`-l`, then `-i` if missing; `NOREN_BASH_LOGIN=1` for a login profile |
| `zsh`                | environment `ZDOTDIR=<folder>/zsh` and `NOREN_USER_ZDOTDIR=<the user's ZDOTDIR or empty>`; arguments unchanged                                    |
| `cmd`                | environment `PROMPT=...` as above; arguments unchanged                                                                                            |

PowerShell's script text is compiled by PowerShell itself, so the execution policy of the machine (which only checks script files) does not stop it and is not changed.

The spec is the plain one, without any of this, when:

- the profile has `inject_integration` set to `false` (it is `true` for every detected profile);
- the shell is none of the above (fish, `wsl.exe`, the `bash.exe` of the Windows system folder, ...);
- the script is not in the folder with the scripts (`noren.ps1`, `noren.bash`, `zsh/.zshrc`), or the folder is not known. cmd needs no script and does not look at the folder;
- the arguments of the profile already choose what the shell runs: for PowerShell `-Command`, `-File`, `-EncodedCommand`; for bash and zsh `-c` (also joined, as in `-lc`), a script file, `-`; for cmd `/c`, `/k`, `/r`. For bash also `--rcfile`, `--init-file`, `--norc` and `--noprofile`, and for zsh `-f` and `--no-rcs`, because the user turned the startup files off.

The profile's own arguments stay, so `-NoProfile` or `-MTA` (PowerShell), `-o vi` (bash) or `-l` (zsh) keep their effect. There is no screen to change `inject_integration` yet; the field is what that setting will write.

The folder comes from the app: the scripts are bundle resources (`bundle.resources` in `tauri.conf.json`, installed as `resources/shell-integration/` in the resource folder; the zsh dotfiles have their own pattern because `*` does not go into folders), and `bridge.rs` resolves that folder with Tauri's resource path and hands it to `noren-core`. `noren --smoke` fails when a PowerShell session does not print `OSC 133;A`, and when any of the scripts, including the zsh dotfiles, is missing from the resource folder, which is how a missing resource is caught in a build.

## Tests

- `cargo test -p noren-core` covers the spec for every shell (integration on and off, the user's profile arguments kept, login and non-login bash, the `ZDOTDIR` of the user handed over, the `PROMPT` of the user kept, profiles that choose what runs left alone) and runs real shells in a PTY with the scripts, without a window:
  - PowerShell (`pwsh`, or Windows PowerShell when that is all there is) types `cmd /c exit 3` and the output must have `OSC 133;D;3`, with `E` and `C` before it; a user prompt defined before the script is kept and sees the right `$?`;
  - bash (Git Bash on Windows, `/bin/bash` elsewhere; never the WSL launcher), once as a login shell and once as a plain one, in a scratch `HOME` (the real one is never read) and with the script copied to a folder whose name has a space: it types `(exit 3)` and the output must have `OSC 133;D;3` with `E` and `C` before it, then a successful line with a `;`, then an empty line (no `E`, `C` or `D`); a `PS1` and a `PROMPT_COMMAND` written to the user's file are kept, and the command sees the right `$?`; a `DEBUG` trap of the user is left alone;
  - cmd (Windows only) must print the folder as `OSC 9;9`, the prompt marks, follow a `cd`, and print no `133;D`.

  When a shell is not installed its test prints a warning and returns.

- zsh is only covered by the spec tests: the scripts were written against the zsh documentation but were not run, because the development machine has no zsh. Run them in a real zsh before relying on them.
- `pnpm e2e` (`e2e/command-meta.spec.ts`): a `sleep 3` shows as running, then as the last command with `exit 0` and `3.0s` once the page moves the fake clock; `false` shows `exit 1` and the next command replaces it; the title follows the command, then the folder, then the number; a title the user typed does not change; each pane of a split shows its command; the last command survives a reload.
- `pnpm test` covers the parser (`packages/model/src/shell-integration.test.ts`), including `OSC 9;9`, the tracker (`pane-location.test.ts`, also against a `FakeBackend` session), the `pane/set-location`, `pane/command-start` and `pane/command-end` actions, the title rules (`auto-title.test.ts`) and the store wiring.
- `cargo test -p noren-core` also covers `read_head` on temporary folders (a repository on a branch, nested subfolders, a worktree with a `.git` file and a `gitdir:` line, absolute and relative, a detached `HEAD`, folders outside any repository, unusable `.git` entries) and, in `tests/git_real.rs`, against repositories made by the real `git` (a worktree and a detached `HEAD` in the form git writes them; it skips with a warning when `git` is not installed).
- `pnpm e2e` (`e2e/pane-location.spec.ts`): a `cd` into a repository shows the folder and branch in the sidebar item and a `cd` out removes the branch; a branch changed under the shell shows at the next prompt; the location is saved and back after a reload; each pane of a split follows its own shell.
