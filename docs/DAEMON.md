# The session daemon

`norend` keeps terminal sessions alive in a process of its own, so a window can close and open again without ending the shells in it. This page describes the program, the endpoint it listens on, the protocol its clients speak and what it keeps.

Status: the server and the client live in `noren-core` (`crates/noren-core/src/daemon/`) and the program is `crates/norend`. The app does not use the daemon yet; making it a client is a later step of the roadmap. Nothing here installs a system service: `norend` runs when somebody starts it.

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

## The endpoint

The address is built by `Endpoint::named(name)` (`daemon/ipc.rs`) and is closed to every user but the current one.

- **Windows.** A named pipe `\\.\pipe\noren-<SID of the user>-<name>`. It is created with a security descriptor that has one entry, full access for the SID of the user running the daemon and no other entry, with `PIPE_REJECT_REMOTE_CLIENTS` on. The first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a second daemon, or a program that took the name first, makes the start fail with "address in use" instead of sharing the name.
- **Unix.** A socket `<folder>/<name>.sock`. The folder is `$XDG_RUNTIME_DIR/noren` when that variable is set, else `<temporary folder>/noren-<uid>`. The daemon creates the folder with mode 0700, or checks an existing one: another owner, a symbolic link, or any access for group or others makes the start fail. The socket file is mode 0600, and every accepted connection must come from the same user id (the peer credentials of the socket). The socket of a dead daemon is replaced; a file that is not a socket is never deleted; a live socket is "address in use".

## Security

- Only the user who runs the daemon can open the endpoint (above). The daemon does not authenticate beyond that: **any process of the same user can create sessions, write to them, read their output and stop the daemon.** That is the same power such a process already has to start a shell, and the reason the endpoint is never opened to the network.
- A client is never trusted to be well formed. A frame longer than the limit is refused before any of it is read, a message must use exactly its bytes, a list is checked against the bytes left before it allocates, and a connection that breaks the rules is told why and closed while the daemon goes on (`crates/noren-core/src/daemon/protocol.rs`, `frame.rs`; tested with random and mutated input).
- A connection must say `Hello` within 5 seconds; a silent one is closed.
- The daemon never talks to the network and never runs anything on its own: it runs what a client asks for with `Create`, exactly as given (a program and its arguments, never through a shell).
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

## What is not there

- Ctrl+C on Windows is handled (`Signals` in `crates/norend/src/main.rs`) but not exercised by a test: sending it to a child needs a console shared with the child, which would need a window.
- The refusal of another user (the SID of the pipe, the uid of the socket) is checked by reading back the access list and the modes, not by a second account; a remote client of the pipe is refused by a flag the tests cannot reach without another machine.
- On Windows, a `conpty.dll` from another program in the `PATH` (a terminal that ships its own) can make `ClosePseudoConsole` block for a long time when a session is closed right after another one was created. It was reproduced without the daemon, and the tests wait for the first output of each session before closing another.
- The daemon does not start by itself, is not a system service, and the app does not use it yet.
