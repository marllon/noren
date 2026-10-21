# The local API

A program on your computer, running as you, can ask a running Noren to do what a person does in its window: list and create spaces, open tabs and splits, type into a terminal, read what a terminal printed and show a notification. This page is the contract. How it is built is in [ARCHITECTURE.md](ARCHITECTURE.md#the-local-api).

The API only exists while Noren runs, and only for the user that runs it. It sends nothing over the network.

## Reaching it

| What                      | Where                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Endpoint, Windows         | the named pipe `\\.\pipe\noren-<your SID>-api-default` (only your SID may open it; remote clients are refused)                                                           |
| Endpoint, macOS and Linux | the socket `api-default.sock` in a folder that belongs to you (`$XDG_RUNTIME_DIR/noren`, else `noren-<uid>` in the temporary folder), mode 0600 in a folder of mode 0700 |
| Token                     | `<data folder of Noren>/api/token`: on Windows `%APPDATA%\io.github.marllon.noren\api\token`; 64 hexadecimal characters and a line break                                 |

The token is 32 random bytes, made the first time Noren starts and kept after that (a missing or damaged file is replaced). It is the first thing every connection must say. Read it from the file each time you connect: a new Noren data folder, or a damaged file, gives a new one. Do not copy it anywhere else; whoever has it can drive your terminals.

If the endpoint is taken (another Noren is running) or the token file cannot be written, Noren starts without the API and says so on its error output.

## The conversation

Every message is one frame of the session daemon framing: a 4-byte big-endian length, then one JSON object in UTF-8. A frame of more than 2 MiB is refused unread and the connection closes.

```text
client  {"type":"auth","version":1,"token":"<64 hex characters>"}     the first message, always
server  {"type":"welcome","version":1}                                or an error, then the connection closes
client  {"id":7,"method":"spaces.list","params":{}}                   any number, one at a time
server  {"id":7,"result":{...}}                                       or
server  {"id":7,"error":{"code":"invalid_params","message":"..."}}
```

- A wrong or missing token, a request before the authentication, another `version` or a first message that is not an `auth` gets an error and the connection closes. Nothing is run for it.
- `id` is a whole number from 0 up that you choose; the answer carries it back. A connection serves one request at a time, in order; connections run side by side (up to 32 at once).
- A request that is invalid (bad JSON, unknown method, an unknown field, wrong `params`) gets an error answer and the connection stays open.
- The server waits 5 s for the authentication and 30 s for a request. The app waits 25 s for its window, so a call that the window does not answer is a `timeout` from the app, not from the server.

### Errors

| `code`                                                   | Meaning                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_json`, `invalid_request`                        | the message is not JSON, or not a request                                                                                                                                                                                                                 |
| `unknown_method`, `invalid_params`                       | the method is not in the list below, or `params` do not fit it                                                                                                                                                                                            |
| `frame_too_large`                                        | the frame is over the limit (the connection closes)                                                                                                                                                                                                       |
| `unauthenticated`, `unauthorized`, `unsupported_version` | the first message was not a good `auth` (the connection closes)                                                                                                                                                                                           |
| `not_found`                                              | the space, tab or terminal you named does not exist                                                                                                                                                                                                       |
| `failed`                                                 | the call was well formed and could not be done (see the message). **While Noren is starting**, its window is up but not yet listening, and a call gets `failed` at once with a message that begins "Noren is still starting": wait a moment and try again |
| `timeout`                                                | the window did not answer in time                                                                                                                                                                                                                         |
| `shutting_down`                                          | Noren is closing                                                                                                                                                                                                                                          |
| `internal`                                               | something broke inside Noren                                                                                                                                                                                                                              |

## Events

A client may ask to be told what happens in the terminals instead of asking again and again. Send `events.subscribe`; from then on the server writes event messages in the same stream as the answers, with no `id`:

```text
client  {"id":3,"method":"events.subscribe","params":{"types":["terminal.output","agent.state"],"sessionId":"s1"}}
server  {"id":3,"result":{"types":["terminal.output","agent.state"],"sessionId":"s1"}}
server  {"event":"terminal.output","data":{"sessionId":"s1","text":"hello\r\n"}}
server  {"event":"agent.state","data":{"sessionId":"s1","state":"working"}}
server  {"event":"events.dropped","data":{"count":12}}
```

| Event             | `data`                                                   | When                                                                |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `terminal.output` | `{ sessionId, text }`                                    | a terminal printed `text` (as the shell wrote it, escapes included) |
| `agent.state`     | `{ sessionId, state: "waiting" \| "working" \| "idle" }` | an agent in the session changed state                               |
| `events.dropped`  | `{ count }`                                              | you were too slow and `count` events were left out (see below)      |

- `events.subscribe` takes `types` (a list of `terminal.output` and `agent.state`, at least one; absent means both) and `sessionId` (one session; absent means every session). An unknown type, an empty list, an empty `sessionId` or an extra field is `invalid_params` and changes nothing.
- A connection gets events only after it authenticated **and** subscribed. Subscribing again replaces the filter (events the old filter had queued are not sent). There is no unsubscribe: close the connection.
- Events are in the same stream as the answers. An event may come between a request and its answer; the answers keep the order of the requests; the events keep the order they happened in. Read frames in a loop and tell them apart by the field: `event` for an event, `id` for an answer.
- A long output comes as several `terminal.output` events in a row (a piece is at most 256 KiB of text, cut at a character boundary), which joined make the text.
- **If you do not read.** Noren keeps up to 64 events waiting for you. Past that it drops the new ones for you alone (nobody else is slowed down), and when it has sent what was waiting it tells you with `events.dropped` how many it left out. Your connection stays open. Read the connection quickly, or ask for less (`sessionId`, `types`).
- Noren sends no event for output or states that happened before you subscribed.

### What the app publishes

- **`terminal.output`** for every session, as it is shown in the terminal: the app copies each chunk of output after it has handed the chunk to the terminal, so a client never slows the terminal down, and with nobody subscribed nothing is copied. The `text` is UTF-8: a character that arrives cut between two chunks is held back until its last byte comes and then goes out whole, and a byte that cannot be part of any character becomes U+FFFD. A shell that prints before Noren knows its number has that text published first, once the number is known. Shells on another machine are published the same way. A session taken over after the app restarted publishes what it had printed meanwhile.
- **`sessionId`** is the number of the shell session, as text (`"7"`), the same one the page keeps for the terminal. The API tells you which session a terminal belongs to: `items.create` and `splits.create` answer with the `session` of the shell they started, and `spaces.list` gives the `session` of every terminal (`null` when it has none). Subscribe with that `sessionId`, and do it before the call if you want the prompt the new shell prints by itself.
- **`agent.state`** when the agent in a session changes state: `waiting`, `working` or `idle`, the words the list of agents shows. The page tells the app only when the state changes, so a state is never repeated; an agent that stops being shown (its command ended, the pane went away) is `idle`. A session that never had an agent publishes nothing.

## Methods

Names of things are the ids that `spaces.list` shows. A terminal is named by the id of its pane.

| Method          | `params`                                                       | `result`                                                                                                                                      |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `spaces.list`   | none                                                           | `{ spaces: [{ id, name, active, items: [{ id, title?, pinned, active, focused, panes: [{ id, type, status, profile, cwd?, session }] }] }] }` |
| `spaces.create` | `{ name }`                                                     | `{ space, name }`; the space is made, not shown                                                                                               |
| `items.create`  | `{ space, cwd?, profile? }`                                    | `{ space, item, terminal, session }`; a tab with a new shell                                                                                  |
| `splits.create` | `{ item, direction: "right" \| "down", cwd?, profile? }`       | `{ item, terminal, session }`; a new pane with a new shell beside the pane in focus                                                           |
| `terminal.send` | `{ terminal, text?, keys?: [name] }` (at least one of the two) | `{ terminal, bytes }`                                                                                                                         |
| `terminal.read` | `{ terminal, lines? }` (1 to 10000)                            | `{ terminal, lines: [text], truncated }`; the newest lines, within 1 MiB                                                                      |
| `notify`        | `{ title, body?, terminal? }`                                  | `{ shown, terminal? }`; a notification of the system                                                                                          |

`session` is the number of the shell session as text (`"7"`): the id that `terminal.output` and `agent.state` events carry as `sessionId`. In `spaces.list` it is `session: null` for a pane with no shell (a browser pane, or a terminal whose shell did not start).

`notify` asks Noren to show a notification of the system. `title` is 1 to 128 characters and not blank, `body` is 1 to 1024 characters, both on one line (no control character), `terminal` is the id of a terminal pane the notification is about (`not_found` if there is no such terminal). Nothing else is accepted. **It honors the notification settings of the user**: with the notifications turned off in the settings, nothing is shown and the answer is `{ "shown": false }`. `shown` is also `false` when the same words for the same terminal were shown less than 3 s ago, or when the system refused the notification; it is `true` only when Noren handed a notification to the system. The call is answered either way, so `shown: false` is not an error. A notification you asked for is shown even when the window of Noren has the focus. The system shows the title cut at 80 characters and the body at 200. It never types anything anywhere.

`terminal.send` writes `text` exactly as given, then the keys by name (`Enter`, `Tab`, `Esc`, `Backspace`, `Space`, the cursor keys, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`, `F1` to `F12`, a letter or digit, and `Ctrl+`, `Alt+` and `Shift+` before them: `Ctrl+C`, `Alt+Up`). An unknown key name sends nothing at all. **Noren never adds an Enter**: a command runs only if you send the `Enter` key (or a line break in `text`) yourself. Never send what a model suggested without a person agreeing to it.

## A client, in short

```js
// Node, on Windows: the pipe is a socket to Node.
import net from "node:net";
import { readFileSync } from "node:fs";

const token = readFileSync(tokenPath, "utf8").trim();
const socket = net.connect(pipePath);
const frame = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
};
socket.write(frame({ type: "auth", version: 1, token }));
// read a frame: the welcome; then
socket.write(frame({ id: 1, method: "spaces.list", params: {} }));
```

## The smoke run

`pnpm smoke` ends with `noren --smoke-api`, which starts the real app with its window hidden, on an endpoint and a token folder of its own (never the ones of a Noren you have open), and plays such a client: it reads the token file, shows that a wrong token is refused, authenticates, calls `spaces.list`, `spaces.create` and `spaces.list` again, and requires the new space in the second list. A call that is told the window is starting is tried again, and the run says how many were. It then opens a second connection, subscribes to `terminal.output`, makes a tab with `items.create`, takes the `session` of the answer (and requires `spaces.list` to give the same one to that terminal), calls `notify` and waits, with a time limit, for a `terminal.output` event of that session: the prompt the shell prints by itself. The run keeps its settings in a folder of its own with the notifications turned off, so `notify` must answer `shown: false` and no notification appears on your desktop. It sends no key and no text to any terminal (so no Enter), shows no window and exits with 0 only if every step held, the event included.

## The command line

`noren-cli` (NOR-F17-02b, the crate `crates/noren-cli`) is a client of this API for a terminal or a script: `new-tab`, `split`, `send`, `read` and `notify`, each one call (`new-tab` first calls `spaces.list` to turn the name of a space into its id). It prints the `result` as one line of JSON, and exits with 0 (done), 1 (Noren answered with an error), 2 (wrong command line, nothing sent) or 3 (Noren could not be reached: not running, no token file, token refused). It finds Noren by the rules in [Reaching it](#reaching-it), reads the token file at every run and adds nothing to what it is told (no Enter). How an AI agent should use it is in [AGENTS.md](AGENTS.md).

The binary is `noren-cli` and not `noren`: the app package already builds `noren` in the same target folder, and the release `noren.exe` has no console. The `noren` alias is left to the packages (NOR-F20-03).

For tests or a second copy of the app, `--endpoint <name>` (`NOREN_API_ENDPOINT`) picks another API (`api-<name>`) and `--token-file <path>` (`NOREN_API_TOKEN_FILE`) another token file. In Rust the same client is `noren_core::api::ApiClient` (`ApiTarget::standard()` is the endpoint and token file of a normal installation, `token_file_in` the one rule for where the token is).

## Not here yet

- A `noren-cli` command for `spaces.list` (the API has it; the command line does not wrap it yet), and a way for a shell to know its own terminal id.
- Routing rules for new tabs and the CLI (NOR-F17-03).
