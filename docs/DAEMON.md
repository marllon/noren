# The session daemon

`norend` keeps terminal sessions alive in a process of its own, so a window can close and open again without ending the shells in it. This page describes the program, the endpoint it listens on, the protocol its clients speak and what it keeps.

Status: the server and the client live in `noren-core` (`crates/noren-core/src/daemon/`), the program is `crates/norend`, and the app keeps its sessions in the daemon (see [The app as a client](#the-app-as-a-client)). The app leaves the shells of its panes running when its window closes and takes them back when it opens (see [Shells that outlive the app](#shells-that-outlive-the-app)); a tray icon with a real quit, and an installer that carries `norend`, are the next step of the roadmap. Nothing here installs a system service: `norend` runs when somebody starts it, and the app starts it when none answers.

## The program

```
norend [--endpoint <name>] [--buffer-bytes <n>]
```

| Option               | Meaning                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--endpoint <name>`  | The daemon to run. 1 to 64 ASCII letters, digits, `-`, `_` or `.`, not starting with a dot. Default `default`. Two names are two daemons, each with its own sessions. |
| `--buffer-bytes <n>` | Bytes of output each session keeps for a client that attaches later. Default and maximum 1048576 (1 MiB).                                                             |
| `-h`, `--help`       | Print the usage and exit 0.                                                                                                                                           |
| `-V`, `--version`    | Print the version of the program and of the protocol and exit 0.                                                                                                      |

On start it prints one line on stdout, `norend <version> listening on <endpoint> (protocol version <n>); stop it with Ctrl+C`, flushed at once: a program that started it can wait for that line instead of polling the endpoint. Errors go to stderr.

**Stopping.** Ctrl+C, `SIGTERM` (Unix), Ctrl+Break and the closing of the console (Windows) and the `Shutdown` request of the protocol all do the same: the daemon stops accepting, closes the connections, kills every session, joins the threads of the sessions and its own, removes the socket file (Unix), prints `norend: stopped` and exits 0. The endpoint is free when the process is gone.

**Exit codes.**

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 0    | Stopped cleanly (or `--help`, `--version`).                                  |
| 1    | Could not run: the endpoint could not be bound, the runtime could not start. |
| 2    | The command line is wrong (an unknown option, a bad name, a bad number).     |
| 3    | Another `norend` already listens on that endpoint; nothing was changed.      |

A second `norend` on the same name prints `norend: another norend already listens on <endpoint>; stop it first, or pick another name with --endpoint` and exits 3. The first one is not disturbed.

## The app as a client

The sessions of the app go through the daemon. The code is `apps/desktop/src-tauri/src/daemon_link.rs` (no Tauri in it) and the rest of the app does not know where its sessions live: `AppState.sessions` is a `Sessions` that has the calls of the `SessionManager` the app always used (`spawn` with a callback for the output and the end, `write`, `resize`, `kill`, `session_count`, `shutdown`) and sends them to the daemon or to a `SessionManager` inside the app.

**Finding or starting the daemon.** From the start of the program, on a thread of its own (so the first session does not wait for a daemon that was started long before it asked), the app connects to the endpoint `default` (`DaemonSettings::normal`). If nothing listens there (the pipe or the socket does not exist, or a socket file is left behind by a dead daemon), it starts the `norend` that sits next to its own executable (`noren.exe` and `norend.exe` in the same folder) and polls the endpoint, every 20 ms for up to 8 seconds, until it answers. A `norend` that was started and exits with code 3 means another one won the endpoint a moment earlier: the app goes on polling and uses that one. Any other early exit, a `norend` that never listens (it is ended) or one that cannot be started is a reason to fall back.

**Started as a program of its own.** The app starts `norend` with no stdin, stdout or stderr (a pipe held by the app would break the daemon the day the app is gone), in the temporary folder (so the daemon never keeps a folder of the user from being deleted), and detached:

- Windows: `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`. A console program started by a program with a window opens a console window unless told not to, so no console window appears (this closes finding 173), and a Ctrl+C or Ctrl+Break aimed at the console of the app does not reach the daemon. The daemon is not a child that dies with its parent: Windows does not end children with the parent.
- Unix: a process group of its own (`process_group(0)`), so the signals of the terminal the app was started from do not reach it.

The app keeps no handle that could end it: a thread waits for it (so a `norend` that ends while the app runs is collected, and the smoke can wait for its end). A normal run leaves the daemon running when the app quits. There is no way to stop it from the app yet (a later step adds the tray icon with the real quit); today a stray `norend` is stopped with the task manager, `kill`, or a `Shutdown` request of the protocol.

**Two connections.** The daemon answers the requests of one connection in turn, and creating or ending a session can take a while (the system tears a pseudo console down at its own pace). The app therefore holds one connection for `Create`, `Attach`, `Kill`, `List` and `Shutdown`, which also carries the events (the output and the end of every session), and one for `Write` and `Resize` only, so what is typed never waits behind a session that is starting or ending. A test with a daemon that never answers a `Create` holds that to it.

**A session.** `spawn` sends `Create`, then `Attach`, and the output comes back as events of the first connection. The task that reads them does the attach too, so the replay that the attach answers with is handed over before any event after it, with nothing missing and nothing repeated, and the callback of a session is only ever called from that task, never from the thread that asked for the session (that thread may hold a lock the callback needs). The end of a session is the `Exit` event, and an ended session stays in the daemon until the app kills it, exactly as in the `SessionManager`. The pid of a session for the agent scan comes from `List` (`SessionInfo.pid`, `None` once the session ended). The shell started ahead of the page (prespawn), the quick window (its shell is a normal `session_create`, and promoting it moves only the route of the output inside the app) and the agent scan all use this path.

**The environment and the folder.** A process of the daemon would start with the environment and the folder of `norend`, which may be days older than the app, so every `Create` carries the whole environment of the app (the entries of the profile last, so they win) and, when the profile names no folder, the current folder of the app. A shell opens the way it would have inside the app.

**Without a daemon.** When there is no `norend` next to the app (an installed app until the installer carries it, a development build before `cargo build -p norend`), it cannot be started, it ends before it listens, or the daemon on the endpoint speaks another protocol version (the handshake says which), the app writes one warning to its log (`warning: the session daemon is not available (<reason>); the sessions of this run live inside the app and end with it`) and runs its sessions in a `SessionManager` inside the app, as it did before the daemon. That choice lasts for the run.

**A daemon that goes away.** When the connection ends (the daemon was stopped, or died) every session of the app is reported as ended (exit code 1), the calls on them fail with a sentence, and the next session looks for the daemon again, starting one if none answers; a daemon that cannot be reached is not tried again for 3 seconds (the next tabs fail at once with the same reason instead of waiting each).

**Ending.** When the app quits, `AppState::end_sessions_on_exit` decides: with the shells kept (see [Shells that outlive the app](#shells-that-outlive-the-app)) it lets go of the ones that belong to a pane and kills the rest (`Sessions::detach`); otherwise it kills its own sessions in the daemon (`Sessions::shutdown`). Either way it lets go of the daemon. A run that owns its daemon (`DaemonSettings::for_run`, used by the smoke runs) sends `Shutdown` instead, waits for the process to end and checks its exit code.

**The smoke runs.** `noren --smoke`, `--smoke-deeplink` and `--smoke-quick` use a daemon of their own, named `smoke-<pid>-<time>` so they never meet the daemon of the user, and stop it when they end. Each prints `SMOKE DAEMON norend pid <n> on <endpoint>: session <id> runs in it (shell pid <m>, the app is pid <k>)` after checking that the shell of the session is a child of that `norend` and not of the app, and `SMOKE DAEMON stopped norend pid <n> with exit code 0, endpoint closed` after asking it to stop and checking that the process ended with code 0 and nothing listens on the endpoint. A run whose sessions fell back to the app fails: the smoke cannot pass on the weaker path. `scripts/smoke.mjs` builds `norend` first (`cargo build -p norend`, so it sits next to `noren.exe`), requires both lines, and ends and reports any `norend` of a run that is still alive afterwards. The perf run (`--perf`) keeps its sessions inside the app, since the numbers it produces are the ones the start of a shell in the app is compared with.

**The persistence smoke run.** `noren --smoke-persist <first|second> <endpoint> <folder>` is two runs of the app on one daemon name and one folder of their own (made and removed by `scripts/smoke.mjs`; the files of the user are never touched), window hidden as in the others. The script puts a saved workspace of one pane (`scripts/smoke-persist-state.json`) in the folder, so the interface of each run restores a pane of its own, through the commands of the app over the real IPC of the window. The first run waits for the interface to start the shell of that pane (written down because the interface named the pane), starts a shell for a pane of its own through the same code as the `session_create` command, makes it print a line, starts one more for a pane no workspace has, writes down the pids and exits through the normal way out (the same `RunEvent::Exit` as closing the last window), with the shells still running. The script checks from outside that the app is gone and that the `norend` and the shell are not. The second run starts on the same endpoint, finds the daemon instead of starting one, and checks that the interface took back the shell of its pane (same session, same process), asks for the shell of its own pane the way the interface does and checks that it is the same session and the same process, that the line printed before the first run ended came back with the buffer, and that it still answers; then it ends the shells no pane came back for (exactly the one of the pane nobody has, and nothing else), asks the daemon to stop, and checks that the endpoint is closed and the `norend` is gone. It prints `SMOKE PERSIST same shell pid <n> before closing the app and <n> after opening it again, session <id>, in norend pid <m> (apps <a> and <b>) ...`, and the script requires the two pids to be the same and the processes of the pair (`norend`, the shell, both apps) to be gone at the end. Its output goes to files, not pipes: on Windows the `norend` the app starts inherits the inheritable handles of the app, among them the pipe of a program that reads the app's output, and the first run leaves the daemon alive on purpose, so a program reading a pipe would wait until the daemon ended (measured: `spawnSync` with pipes waited for its whole timeout).

## Shells that outlive the app

With `sessions.keepOnClose` on (the default, see [CONFIG.md](CONFIG.md#sessions)) and the sessions in the daemon, closing the app does not end the shells of the panes. The code is `apps/desktop/src-tauri/src/persist.rs` (the policy), `pane_sessions.rs` (the book) and the calls `list`, `reattach`, `owns` and `detach` of `Sessions` (`daemon_link.rs`). Nothing in the daemon or the protocol changed for this: a session of the daemon still knows nothing about panes.

**Which shell is which pane's.** The page passes the id of the pane to `session_create` (`CreateSessionOptions.paneId`), and the app writes down, in `sessions.json` next to `state.json`, the pane id, the id of the session in the daemon and the pid of its process (`PaneBook`; written whenever it changes, atomically, and tied to the endpoint: a book for another daemon is an empty one). The pid is what makes a match safe: a daemon that was started again numbers its sessions from the start, and a session with the same id but another process is not the pane's shell. A shell with no pane (the quick window's, or one promoted from it to a tab) is not written down.

**On the way out** (`end_sessions_on_exit`), with the setting on: the sessions that are written down and still running stay in the daemon, and every other session of the app is killed; the pane book keeps its entries. With the setting off, or with the sessions in the app's own process, every session is killed and the book is cleared. The app asks nothing of the daemon to keep a session: letting go of the connection is enough (the daemon keeps filling the buffer of a session nobody is attached to, 1 MiB at most).

**On the way in**, `restoreWorkspace` asks `session_reattach` for each pane before it creates a shell. The app lists the sessions of the daemon (`List`) and takes over the one the book names for the pane when it has the same id and the same pid and has not ended (`Attach`: the buffer reaches the page first, then everything after it, then the end of the session, exactly as for a new one, through the same route and `session-exit`). A session that ended while the app was away is released (`Kill`) and the pane gets a new shell. With the setting off nothing is taken over.

**Shells nobody came back for** (finding 179). When the page says it is up (`app-ready`, which comes after every pane has had its shell), the app ends the sessions of the daemon that it did not start or take over and that nobody is attached to (`reap_orphans`): the shell of a pane that no longer exists, of a crash, of a book that was lost. A session some other client is attached to is left alone, and so is everything when the sessions live in the app's own process.

**Limits.** A shell promoted from the quick window to a tab has no pane when it is promoted, so it ends with the app. A pane that gets its shell back is resized by its terminal to the size it has now, which makes the shell redraw its prompt; what is on screen is the replay of the buffer, which is bytes, not the state of a terminal (see [What the daemon keeps](#what-the-daemon-keeps)): a program on the alternate screen is not redrawn by it. The daemon is left running after the window closes and nothing in the app stops it yet.

## The endpoint

The address is built by `Endpoint::named(name)` (`daemon/ipc.rs`) and is closed to every user but the current one.

- **Windows.** A named pipe `\\.\pipe\noren-<SID of the user>-<name>`. It is created with a security descriptor that has one entry, full access for the SID of the user running the daemon and no other entry, with `PIPE_REJECT_REMOTE_CLIENTS` on. The first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a second daemon, or a program that took the name first, makes the start fail with "address in use" instead of sharing the name.
- **Unix.** A socket `<folder>/<name>.sock`. The folder is `$XDG_RUNTIME_DIR/noren` when that variable is set, else `<temporary folder>/noren-<uid>`. The daemon creates the folder with mode 0700, or checks an existing one: another owner, a symbolic link, or any access for group or others makes the start fail. The socket file is mode 0600, and every accepted connection must come from the same user id (the peer credentials of the socket). The socket of a dead daemon is replaced; a file that is not a socket is never deleted; a live socket is "address in use".

## Security

- Only the user who runs the daemon can open the endpoint (above). The daemon does not authenticate beyond that: **any process of the same user can create sessions, write to them, read their output and stop the daemon.** That is the same power such a process already has to start a shell, and the reason the endpoint is never opened to the network.
- A client is never trusted to be well formed. A frame longer than the limit is refused before any of it is read, a message must use exactly its bytes, a list is checked against the bytes left before it allocates, and a connection that breaks the rules is told why and closed while the daemon goes on (`crates/noren-core/src/daemon/protocol.rs`, `frame.rs`; tested with random and mutated input).
- A connection must say `Hello` within 5 seconds; a silent one is closed.
- The daemon never talks to the network and never runs anything on its own: it runs what a client asks for with `Create`, exactly as given (a program and its arguments, never through a shell).
- The app sends its whole environment with every `Create` (see [The app as a client](#the-app-as-a-client)), so the shell gets what it would get inside the app. It goes over the endpoint above, which only the same user can open, and it is what any process the user starts would inherit; the daemon does not list it, log it or write it anywhere.
- Not checked: on Windows the client does not verify who owns the pipe it opens (the server protects itself with the first-instance flag; a program that took the name before the daemon could be spoken to as if it were the daemon).

## The protocol

Version **2**. Everything is in `daemon/protocol.rs` (pure, no I/O) with the frame reading and writing in `daemon/frame.rs`.

### Frames

Everything on the wire is a frame: a 4-byte big-endian length, then that many bytes of payload.

| Part    | Size                | Notes                                                                                                              |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Length  | 4 bytes, big-endian | Counts the payload only. Never zero. Never above 2 MiB (2097152); a bigger one is refused before anything is read. |
| Payload | 1 to 2097152 bytes  | The first byte is the tag of the message; the fields follow in the order below.                                    |

Field encodings: integers big-endian; a byte string or a text is a 4-byte length and the bytes (a text is UTF-8); an optional value is a 0 or 1 byte and then the value; a list is a 4-byte count and the items; a flag is 0 or 1 (any other byte is an error). A message must use its whole payload: bytes left over are an error, and so is a payload that ends early.

### The handshake

1. The client sends `Hello { version }` (tag `0x01`, a `u32`) as its first frame.
2. If the version is the one the daemon speaks, it answers `Welcome { version }`. Otherwise it answers `Error` with code `VersionMismatch` and the sentence "the client speaks protocol version N and this daemon speaks version M; use a client built for the same version", and closes the connection.
3. Any other first message is an `Error` (`Protocol`) and the connection is closed.

`Hello` is the one layout that never changes, whatever the version: the tag and the version, and a reader ignores anything after them, so a later version can add fields to it and an older daemon still refuses it by name.

### Messages from the client

Every request after the handshake has a `u32` id of the client's choosing, right after the tag, and is answered with a response carrying the same id.

| Tag    | Message                | Fields after the id                                                                                            | Answer                                           |
| ------ | ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `0x01` | `Hello`                | `version: u32` (no id)                                                                                         | `Welcome` or `Error`                             |
| `0x10` | `Create`               | `program: text`, `args: list<text>`, `cwd: optional text`, `env: list<(text, text)>`, `cols: u16`, `rows: u16` | `Created`                                        |
| `0x11` | `Write`                | `session: u64`, `data: bytes`                                                                                  | `Ok`                                             |
| `0x12` | `Resize`               | `session: u64`, `cols: u16`, `rows: u16`                                                                       | `Ok`                                             |
| `0x13` | `Attach`               | `session: u64`                                                                                                 | `Attached`                                       |
| `0x14` | `Detach`               | `session: u64`                                                                                                 | `Ok` (also when the connection was not attached) |
| `0x15` | `Kill`                 | `session: u64`                                                                                                 | `Ok`                                             |
| `0x16` | `List`                 | none                                                                                                           | `Sessions`                                       |
| `0x17` | `Shutdown` (version 2) | none                                                                                                           | `Ok`, then the connection closes                 |

### Messages from the daemon

| Tag    | Message        | Fields                                                                                                                                            |
| ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x81` | `Welcome`      | `version: u32`                                                                                                                                    |
| `0x82` | `Error`        | `code: u8`, `message: text`. Ends the conversation; the daemon closes the connection after it.                                                    |
| `0x90` | `Ok`           | `id: u32`                                                                                                                                         |
| `0x91` | `Created`      | `id: u32`, `session: u64`, `pid: optional u32`                                                                                                    |
| `0x92` | `Attached`     | `id: u32`, `replay: bytes`, `exit: optional (code: u32, signal: optional text)`                                                                   |
| `0x93` | `Sessions`     | `id: u32`, then a list of `session: u64`, `pid: optional u32`, `cols: u16`, `rows: u16`, `attached: u32`, `buffered: u32`, `exit: optional (...)` |
| `0x94` | `RequestError` | `id: u32`, `code: u8`, `message: text`. The request failed; the connection goes on.                                                               |
| `0xA0` | `Output`       | `session: u64`, `data: bytes`. An event, no id; only for sessions the connection is attached to.                                                  |
| `0xA1` | `Exit`         | `session: u64`, `code: u32`, `signal: optional text`. The last event of a session.                                                                |

### Error codes

| Code | Name              | When                                                            |
| ---- | ----------------- | --------------------------------------------------------------- |
| 1    | `Protocol`        | A frame or message that could not be read, or one out of turn.  |
| 2    | `VersionMismatch` | The client speaks another protocol version.                     |
| 3    | `UnknownSession`  | No session has this id (never created, or already killed).      |
| 4    | `SessionClosed`   | The process of the session ended; there is nothing to write to. |
| 5    | `InvalidSize`     | A terminal size with a zero side.                               |
| 6    | `Spawn`           | The pseudo terminal or the process could not be started.        |
| 7    | `Io`              | Writing, resizing or killing failed in the system.              |
| 8    | `TooManySessions` | The daemon holds as many sessions as it allows.                 |
| 9    | `ShuttingDown`    | The daemon is going down.                                       |
| 10   | `Internal`        | A bug or a failure of the daemon itself.                        |

Codes are stable across versions; a new code is a new version.

### Versions

| Version | Change                                                                                     |
| ------- | ------------------------------------------------------------------------------------------ |
| 1       | The first version: hello, create, write, resize, attach, detach, kill, list.               |
| 2       | Adds the `Shutdown` request (tag `0x17`) and the `ShutdownRequested` handle of the server. |

**The rule.** Adding, removing or changing a message, a field, a tag or an error code changes the protocol: raise `PROTOCOL_VERSION` by one, add a row above and say what changed. The daemon and the client of one version accept only that version, so a new request is never sent to a daemon that does not know it: the handshake fails first, by name, with the versions in the sentence, instead of the request failing as an unknown tag. (Version 1 was only ever used by the tests of the library; nothing shipped with it.)

## What the daemon keeps

- **Sessions.** Each is a pseudo terminal with a process, started by `Create` and kept until `Kill`, the end of the daemon or, for a process that ended on its own, until somebody kills the session to release it. A session whose process ended stays listed with its exit code and counts against the limit of sessions.
- **A buffer of output** per session: a ring of the latest bytes (`--buffer-bytes`, at most 1 MiB), oldest first out, and a copy never starts in the middle of a UTF-8 character. It is bytes, not the state of a terminal: after it has wrapped, a replay can begin in the middle of an escape sequence, and a program on the alternate screen is not redrawn by it.
- **Attach.** `Attach` answers with the buffer and then sends everything that comes after as `Output` events, with nothing missing and nothing repeated (the daemon takes the copy and adds the connection to the session under one lock). Two clients may be attached to one session. `Detach` stops the events; the session goes on and keeps filling its buffer, and a later `Attach`, from this connection or from a new process, gets it.
- **A client that does not read** is cut. Each connection has a queue of 128 frames; when it is full the daemon closes that connection instead of waiting (waiting would stop the shell and every other client). The sessions go on, and the client gets the buffer back by connecting again and attaching.

### Limits

| What                                   | Limit                                             |
| -------------------------------------- | ------------------------------------------------- |
| One frame                              | 2 MiB; a bigger length is refused unread          |
| Output kept per session                | `--buffer-bytes`, 1 MiB by default and never more |
| Sessions                               | 256                                               |
| Frames queued for one client           | 128; a client that falls behind is disconnected   |
| Time to say `Hello`                    | 5 seconds                                         |
| One `Write` sent by the client library | 64 KiB (a longer write goes in several requests)  |

## Threads

`Daemon::start` starts one thread (`noren-daemon`) with a current-thread runtime: the accept loop and one task per connection. Everything that can block on a PTY (starting a process, writing to it, ending it) goes to the blocking pool, so a slow shell never stops the other connections. Each session has its own three threads (reader, pump, waiter). `norend` itself waits for a stop on its main thread. `Daemon::shutdown` joins them all.

## Tests

- `crates/noren-core/tests/daemon.rs`: the server and the client in one process, over the real pipe or socket, with real shells.
- `crates/norend/tests/process.rs`: the `norend` program in another process (the binary Cargo builds), without a window (`CREATE_NO_WINDOW` on Windows), with its output captured: create, write, read, detach, write while detached, a new connection that gets the buffer back, the options, the exit codes, the refusal of a second daemon and of another protocol version, and a clean stop that ends the shells and frees the endpoint. On Unix it also sends `SIGTERM` and `SIGINT`.
- `apps/desktop/src-tauri/src/daemon_link.rs` (tests in the same file): the app's side, with real shells. A daemon already running (found, not started; the shell lives in it; the pid is the one `List` gives; killing releases it), the output in order once with the end last and its code, a session that cannot start, the app quitting (its sessions end, the daemon stays), a `norend` started when none answers (the shell is a child of it, not of the app, and opens in the folder of the app; stopping it ends the process with code 0 and frees the endpoint), that daemon outliving the app and the next run finding it, two apps starting at once ending up on one daemon, the fallback to the session manager (no `norend` at the path, a name that is not an endpoint, a program that ends with code 7 before it listens, one that never listens), a daemon that goes away (the sessions end, the next one finds a daemon again), typing not waiting behind a session that is starting (a fake daemon that never answers a `Create`), and on Linux the process group of `norend`.
- `apps/desktop/src-tauri/src/bridge.rs`: the same scenarios the bridge always had, with the sessions in a daemon: the end of a shell announced once through `session-exit` with its route released, a session moved to a new channel keeping its process, the shell started ahead handed to the call that asks for it, and the agent scan starting from the pid `List` gives.
- `apps/desktop/src-tauri/src/pane_sessions.rs` and `persist.rs` (tests in `pane_sessions.rs` and in `bridge.rs`, with the sessions in a daemon of the test and real shells): leaving with the setting on keeps the shell of a pane running (same process) and ends the others, with it off ends every session and clears the book, a later run gets back the shell of the pane by its id with what it printed (and its end is announced), a session with the pane's id but another process is not its shell, the shells no pane came back for are ended and one some other client is attached to is not, with the setting off nothing is taken over and what was left is ended, a shell that ended while the app was away is released, killing the session of a pane forgets the pane, and sessions in the app's own process are never written down. In `daemon_link.rs`: `detach` keeps the sessions asked for, `reattach` takes one over with its buffer, and a real `norend` outlives the app that started it, with its shell.
- `pnpm smoke`: the three smoke runs above and the persistence run, in the real app with its window hidden.

## What is not there

- The tray icon to quit for real (which stops the daemon), and the installer carrying `norend`, are the next step of the roadmap. Until then an installed app has no `norend` next to it and falls back to the sessions inside the app, and a `norend` left running after the window closes is stopped by hand.
- A development build needs `cargo build -p norend` once (`pnpm smoke` does it) so that `target/debug/norend` sits next to `target/debug/noren`.
- A `norend` that is left running keeps its executable open on Windows, which stops an installer from replacing it; the installer step has to stop it first.
- The time to the first prompt with the daemon was not measured: `--perf` keeps its sessions inside the app. Starting `norend` adds to the first start after the machine booted (the system may also scan a new executable), and the hop through the pipe adds to each chunk of output; neither has a number yet.
- Ctrl+C on Windows is handled (`Signals` in `crates/norend/src/main.rs`) but not exercised by a test: sending it to a child needs a console shared with the child, which would need a window.
- The refusal of another user (the SID of the pipe, the uid of the socket) is checked by reading back the access list and the modes, not by a second account; a remote client of the pipe is refused by a flag the tests cannot reach without another machine.
- On Windows, a `conpty.dll` from another program in the `PATH` (a terminal that ships its own) can make `ClosePseudoConsole` block for a long time when a session is closed right after another one was created. It was reproduced without the daemon, and the tests wait for the first output of each session before closing another.
- The daemon does not start by itself (the app starts it), is not a system service, and does not start when the machine does.
- On Windows the `norend` the app starts inherits the inheritable handles of the app (`Command` hands them all on): when a program starts the app and reads its output through a pipe, that program does not see the end of the output until the daemon ends. The smoke script reads files for this reason. A normal start from the desktop has no such pipe.
