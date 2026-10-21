# Using Noren from an AI agent

This page is for an AI agent (or a script) that runs in a terminal inside Noren, or beside it, and wants to use the other terminals: open a tab, split one, read what a terminal printed, type into it, or tell the user something. It uses the `noren-cli` command, which talks to the running app through the [local API](API.md). The contract of the API is there; this page is how to behave.

`noren-cli` only works while Noren is running, for the user that runs it. Nothing goes over the network.

> The command is `noren-cli`, not `noren`: the app is already `noren`/`noren.exe`, and the release `noren.exe` has no console to print to. A shorter `noren` alias for the command line comes with the packages (NOR-F20-03).

## The rules

These come first because they matter more than the commands.

1. **A person decides what runs.** `noren-cli send` types into a real shell of the user. **Never send text that ends a command (a line break, `\r`, or the `Enter` key) unless a person agreed to that exact command in this conversation.** A command that a model suggested is not agreed to. Without an Enter, what you send is only typed on the prompt line, where the person can read it, edit it or clear it.
2. **`send` never adds an Enter.** What you give is what is typed. `--text "ls"` leaves `ls` on the prompt; the command runs only if you also pass `--key Enter`, or put a line break in the text. Both count as pressing Enter for rule 1.
3. **Read before you type.** `read` the terminal first: a program may be waiting for an answer (a password, a `y/n`), and your text would go to it.
4. **Do not copy the token.** The command reads it from the file of the user each time it runs. Do not print it, log it or send it anywhere.
5. **Stay in your lane.** Work in the terminals you opened or were pointed at. Do not read or type into other terminals the user did not mention: they may hold secrets or running work.

## Find the terminal

Everything is named by the ids Noren gives. You cannot guess them. The way to learn the id of a terminal with `noren-cli` is to make one:

```sh
noren-cli new-tab --space Work --cwd .
# {"space":"s1","item":"i9","terminal":"t9","session":"4"}
```

The terminal you just made is in the answer: `terminal` is the id you pass to `send`, `read` and `notify`, and `item` is the id you pass to `split`. This is also the safest way to work: use a terminal of your own, not one the user is typing in.

`noren-cli` has no command yet that lists the terminals that already exist, and the shells Noren starts do not carry their own pane id in the environment. The list is the API method `spaces.list` (every space, tab and pane with its id, folder and `session`), which a client of the [API](API.md#methods) can call; if a person gives you a terminal id, use it as it is.

`--space` takes the id or the name of a space. A name that two spaces share is refused (use the id). `--cwd .` means the folder you run the command in; any relative folder is made absolute first, because the app does not know where you are.

## The commands

Every command prints the answer of Noren as **one line of JSON** on standard output and exits with a code. A message for a person goes to standard error.

```sh
# A tab with a new shell in a space (id or name), in this folder.
noren-cli new-tab --space Work --cwd . [--profile <id>]

# A new pane beside the focused pane of a tab (the item id), to the right or down.
noren-cli split --item i9 --direction right [--cwd <folder>] [--profile <id>]

# Type into a terminal. Text exactly as given, then keys by name. No Enter is added.
noren-cli send --terminal t9 --text "git status"
noren-cli send --terminal t9 --key Ctrl+C
# {"terminal":"t9","bytes":10}

# The newest lines the terminal printed (1 to 10000).
noren-cli read --terminal t9 --lines 40
# {"terminal":"t9","lines":["$ git status","On branch main"],"truncated":false}

# A notification of the system.
noren-cli notify --title "Build finished" --body "12 tests failed" --terminal t9
# {"shown":false,"terminal":"t9"}
```

Key names: `Enter`, `Tab`, `Esc`, `Backspace`, `Space`, the cursor keys, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`, `F1` to `F12`, a letter or digit, and `Ctrl+`, `Alt+`, `Shift+` before them. Repeat `--key` for several: `--key Ctrl+C --key Up`. A name Noren does not know sends nothing at all.

`noren-cli --help` prints all of this.

### `notify` can answer `shown: false`

`notify` honors the notification settings of the user. If they turned notifications off, nothing is shown and the answer is `{"shown":false}`; the same words for the same terminal within 3 seconds, or a refusal by the operating system, also give `false`. **That is not an error** (the exit code is 0). Do not retry in a loop and do not conclude the user saw it: if the message matters, say it in your own output too. A `shown: true` means Noren handed a notification to the system, not that anybody looked at it.

## Exit codes

| Code | Meaning                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 0    | Done. Standard output has the JSON line.                                                                          |
| 1    | Noren was reached and said no: `not_found` (a space or terminal that does not exist), `invalid_params`, `failed`. |
| 2    | The command line is wrong. Nothing was sent.                                                                      |
| 3    | Noren could not be reached: not running, no token file yet, or the token was refused.                             |

The message on standard error says which. After exit 1 with `failed` and a message that begins "Noren is still starting", wait a moment and try once more. After exit 3, do not keep trying: tell the user that Noren is not running or not reachable.

## Reading the output well

- `read` gives plain text lines, oldest first, with the colors and cursor movements already applied by the terminal. `truncated: true` means older lines were dropped to fit the limit (1 MiB).
- To see the result of something a person ran, `read` again after a short wait; there is no "wait for the command to finish" call. Do not poll in a tight loop.
- Lines can hold secrets that were printed on the screen. Do not forward what you read to anywhere the person did not agree to.

## A safe sequence

```sh
noren-cli new-tab --space Work --cwd .                       # your own terminal: note "terminal"
noren-cli send --terminal t9 --text "npm test"               # typed, not run
# ... a person reads the prompt line and agrees, or runs it themselves ...
noren-cli send --terminal t9 --key Enter                     # only after that agreement
noren-cli read --terminal t9 --lines 60
noren-cli notify --title "Tests done" --terminal t9
```

## For a script that is not `noren-cli`

The command is a thin client. Any program can speak the API itself (a pipe or a socket, a token file, JSON frames); see [API.md](API.md#a-client-in-short). The same rules apply.

For tests, `noren-cli` can be pointed at another Noren with `--endpoint <name>` and `--token-file <path>` (or `NOREN_API_ENDPOINT` and `NOREN_API_TOKEN_FILE`); normal use needs neither.
