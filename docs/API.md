# The local API

A program on your computer, running as you, can ask a running Noren to do what a person does in its window: list and create spaces, open tabs and splits, type into a terminal and read what a terminal printed. This page is the contract. How it is built is in [ARCHITECTURE.md](ARCHITECTURE.md#the-local-api).

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
- Noren sends no event for output or states that happened before you subscribed. What Noren publishes, and from where, is described in the changelog as it is added.

## Methods

Names of things are the ids that `spaces.list` shows. A terminal is named by the id of its pane.

| Method          | `params`                                                       | `result`                                                                                                                                      |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `spaces.list`   | none                                                           | `{ spaces: [{ id, name, active, items: [{ id, title?, pinned, active, focused, panes: [{ id, type, status, profile, cwd?, session }] }] }] }` |
| `spaces.create` | `{ name }`                                                     | `{ space, name }`; the space is made, not shown                                                                                               |
| `items.create`  | `{ space, cwd?, profile? }`                                    | `{ space, item, terminal }`; a tab with a new shell                                                                                           |
| `splits.create` | `{ item, direction: "right" \| "down", cwd?, profile? }`       | `{ item, terminal }`; a new pane with a new shell beside the pane in focus                                                                    |
| `terminal.send` | `{ terminal, text?, keys?: [name] }` (at least one of the two) | `{ terminal, bytes }`                                                                                                                         |
| `terminal.read` | `{ terminal, lines? }` (1 to 10000)                            | `{ terminal, lines: [text], truncated }`; the newest lines, within 1 MiB                                                                      |

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

`pnpm smoke` ends with `noren --smoke-api`, which starts the real app with its window hidden, on an endpoint and a token folder of its own (never the ones of a Noren you have open), and plays such a client: it reads the token file, shows that a wrong token is refused, authenticates, calls `spaces.list`, `spaces.create` and `spaces.list` again, and requires the new space in the second list. A call that is told the window is starting is tried again, and the run says how many were. It sends no key and no text to any terminal, shows no window and exits with 0 only if every step held.

## Not here yet

The server side of the events is done (NOR-F17-01e), but the app does not publish anything yet: the terminal output and the state of the agents reach the server in NOR-F17-01f, so today `events.subscribe` is answered and no event comes. The `noren` command line that wraps this API is NOR-F17-02.
