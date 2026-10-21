# Bench task suite

`bench/tasks/` holds 60 tasks that a local model is asked to do, each with an automatic check. A runner sends the tasks to a model server and counts the right answers; this page is the format of a task, the rules of the check and what the runner does and records. The code of the suite is `packages/model/src/bench-suite.ts` and the test `bench-suite.test.ts`, which reads every file in the folder; the runner is `packages/model/src/bench-runner.ts`.

The check only compares text. It never runs a command that a model wrote.

## The suite

| Kind        | Count | What the model does                                      | Id                           |
| ----------- | ----- | -------------------------------------------------------- | ---------------------------- |
| `command`   | 20    | writes one command, 10 for PowerShell and 10 for bash    | `cmd-pwsh-01`, `cmd-bash-01` |
| `explain`   | 20    | explains an error and says how to fix it                 | `explain-01`                 |
| `summarize` | 20    | summarizes the output of a command in one short sentence | `summarize-01`               |

The count of each kind is declared in `BENCH_DISTRIBUTION` and checked by the test. Ids and prompts are in English and name no product of another maker, only shell tools.

## A task

One JSON file per task, named `<id>.json`:

```json
{
  "id": "cmd-bash-10",
  "kind": "command",
  "shell": "bash",
  "prompt": "Write a bash command that makes the file deploy.sh executable.",
  "check": { "accept": ["chmod +x deploy.sh", "chmod 755 deploy.sh"] },
  "examples": {
    "pass": ["chmod +x deploy.sh", "chmod 755 deploy.sh"],
    "fail": ["chmod -x deploy.sh", "chmod 644 deploy.sh"]
  }
}
```

- `id`: lower-case words joined by dashes, equal to the file name, starting with `cmd-pwsh-`, `cmd-bash-`, `explain-` or `summarize-`.
- `kind`: `command`, `explain` or `summarize`.
- `shell`: `pwsh` or `bash`, only in a `command` task.
- `prompt`: what the model is asked.
- `input`: optional text the prompt is about, the error to explain or the output to summarize.
- `check`: how an answer is judged (below).
- `examples`: sample answers. Every `pass` example must pass the check and every `fail` example must be refused; the test runs them, so a check that is too loose or too strict fails the suite, not only a file with a wrong shape.

## Checking a command

The answer is one line. A code fence, backticks around it or a prompt mark (`$ `, `PS C:\> `) are taken off first. Both the answer and each accepted form are then read the same way and compared:

- The line is split into words. Quotes are removed, so `"a b"` and `'a b'` are the same word. `|`, `||`, `&&`, `;`, `>` and parentheses are words of their own, so the spaces around them do not matter. A quoted `|` is plain text.
- Spaces and tabs between words do not matter. In `pwsh` the text is lower-case before comparing; in `bash` case matters.
- The answer is right when it equals one of the forms in `accept`.

Fields of the `check` of a command:

| Field             | Meaning                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `accept`          | The accepted forms (at least one).                                                                           |
| `aliases`         | Groups of words that mean the same, for example `["Get-ChildItem", "gci", "ls", "dir"]`.                     |
| `flagOrder`       | `fixed` (default) keeps the order; `any` lets the flags of each stage (between operators) come in any order. |
| `flagsWithValue`  | Flags that take the next word (`-Filter *.log`), which then moves with the flag.                             |
| `splitShortFlags` | Reads `-lat` as `-l -a -t`; only for tools that read bundles that way.                                       |
| `forbidden`       | Words that must not appear anywhere in the answer.                                                           |

## Checking an explanation or a summary

The answer is compared as lower-case text with the spaces folded.

| Field       | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `required`  | Groups of alternatives. Every group needs one of its terms in the answer. |
| `forbidden` | Terms that must not appear.                                               |
| `maxWords`  | The most words the answer may have (a summary is short).                  |

A term matches at the start of a word: `permission` matches `permissions`, and `rm` does not match `format`.

## Adding a task

Write the file in `bench/tasks/`, keep the id equal to the file name, give at least two `pass` and two `fail` examples (a `fail` example that is nearly right is the most useful), and run `pnpm exec vitest run packages/model/src/bench-suite.test.ts`. The test also counts the suite, so a new task changes `BENCH_DISTRIBUTION` too.

## The runner

`runBench({ ai, provider, model, tasks, now, signal, onProgress })` runs the tasks against one provider through `AiBackend.chat`, one at a time. It is pure TypeScript: it opens no connection of its own (the Rust side talks to the provider), reads no file and takes the clock (`now`, in milliseconds) from its caller, so a test sets every latency.

**What is sent.** Each task is one request with an id of its own and two messages. The system message depends on the kind: a command task asks for one command for the shell of the task (PowerShell or bash) alone on a line, with no explanation and no code fence; an explanation task asks for what the error means and how to fix it in a few sentences; a summary task asks for one short sentence. The user message is the prompt of the task, followed by its `input` in a code fence when it has one. The deltas of the answer are joined and given to `checkBenchAnswer`.

**Only a model on this computer.** The run is refused, before any request, when the address of the provider is not `localhost`, `127.0.0.1` or `::1` (any port, `http` or `https`), when the address holds a user name or password, when no model is named (a blank `model` takes the default model of the provider) or when two tasks share an id. The refusal is a `BenchRefusedError` that says why. A provider elsewhere would be sent 60 prompts, and the bench is meant for models you run yourself.

**What is measured, for each task.**

| Field             | Meaning                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`, `reason`    | The answer passed its check, or why it did not. A failed call is `the provider failed: <kind>`.                                                                                    |
| `firstChunkMs`    | From the request to the first delta that has text; `null` when none came.                                                                                                          |
| `totalMs`         | From the request to its last event (`done` or `error`).                                                                                                                            |
| `outputTokens`    | The count the provider reported in the stream (`tokensSource: "stream"`), or else the characters of the answer divided by 4, rounded up (`"estimate"`).                            |
| `tokensPerSecond` | `outputTokens` over `totalMs`, rounded to two decimals; `null` for a failed call, or one with no time or no tokens. A count when `tokensSource` is `stream`, an estimate when not. |
| `error`           | `{ kind, message }` of the provider when the call failed (`network`, `timeout`, `http`, ...); `null` otherwise. The message never holds a key.                                     |

A call that fails (an `error` event, `chat` rejecting, or an answer that ends without `done`) is a failed task with the kind of the error and the run goes on with the next task. A partial answer of a broken stream is never judged.

**Totals.** For the whole run and for each kind: tasks run, passed, calls that failed, accuracy (passed over run, 0 when none ran) and the medians of the time to the first delta, of the total time and of the tokens per second. The medians leave out the tasks whose call failed, so a refused connection does not look fast. The result checks itself: `benchRunSchema` refuses a result whose totals are not what its tasks add up to.

**Cancelling.** When `signal` aborts, the request in flight is cancelled with `ai.cancel`, no further task is sent and the result is `cancelled` with the tasks that were done; the one cut short is not among them. A task that ended with `done` before the cancel took effect is kept. `planned` tells how many tasks the run was asked to do.

**The result.** `runBench` returns a `BenchRun` (and `benchRunSchema` reads it back from JSON): `version`, `startedAt` (ISO 8601, UTC), the `provider` (`id`, `kind` and `baseUrl`; never a key), the `model`, the `state` (`complete` or `cancelled`), `planned`, the `tasks`, the `totals` and `memory`, which is `null` or the memory of the model (below). Its file is `bench-results/<YYYY-MM-DD-HHmmss>.json`, named from the start of the run in UTC by `benchResultPath`.

**Tokens of the stream.** When the provider reports how many tokens the answer has, that count is used and the task is marked `tokensSource: "stream"`; the tokens per second are then the count over the total time. For the chat completions format (Ollama, LM Studio and the rest) the request asks for it with `stream_options: { include_usage: true }` and the count is `usage.completion_tokens` of the last chunk, the one with no `choices`; for the Anthropic format it is `usage.output_tokens` of `message_delta`. The Rust parser puts it in the `done` it ends the stream with (`StreamEvent::Done { output_tokens }`), the bridge passes it on and the page gets `{ type: "done", outputTokens }`. A server that sends no count, or a count that is not a whole number of 0 or more, leaves it out: the task keeps the estimate and nothing fails. A count of 0 next to an answer that has text also keeps the estimate, and a failed call never uses a count. The two sources can be mixed in one run (a result is still valid), so the medians of the tokens per second are only comparable between runs of the same source. `FakeBackend` reports a count with `aiTokens` / `setAiTokens` (a number or a function of the request).

## The memory of the model

When the provider is the pre-defined Ollama (`id` `ollama`) and at least one task was done, `runBench` asks for the memory of the model once the tasks are over, with `AiBackend.ollamaMemory(model)`, and stores it in `memory`:

```json
{ "source": "ollama", "bytes": 5137025024, "vramBytes": 4000000000 }
```

`bytes` is `size` of `GET /api/ps` (the whole model as Ollama holds it) and `vramBytes` is `size_vram` (the part in video memory); both are whole numbers of 0 or more, and the schema is strict (no other key, no other `source`). The time between the last task and the question is short, so the model is still loaded unless Ollama's own timer unloaded it.

`memory` is `null` when:

- the provider is not Ollama (LM Studio and the rest have no such answer: they are never asked);
- no task was done (a cancelled run with none, or an empty list);
- Ollama is not running, does not answer within 3 s, answers with a status that is not 2xx or with something that is not what Ollama sends;
- the model is not among the loaded ones (`llama3` and `llama3:latest` are the same model; `llama3:8b` is another);
- `size` or `size_vram` of the model is negative, has a fraction, is text or is missing;
- asking rejects or answers something the schema refuses.

None of these fails the run: the tasks are kept and the state is what it was. A cancelled run with some tasks done is measured too. A file written before the memory was measured has `memory: null` and still reads; `BENCH_RUN_VERSION` stays 1.

The Rust side is `AiClient::ollama_memory` in `crates/noren-core/src/ai.rs` (the tests start a local HTTP server and cover a name, a name with `:latest`, a model that is not loaded, invalid numbers, a status 500 and an answer that is not Ollama's), the Tauri command is `ai_ollama_memory` (main window only) and `FakeBackend` takes `ollamaMemory` (a reading, or a function of the model name) and `setOllamaMemory`.

**Real servers.** The bench has been run against the fake provider and the local test server; a run against Ollama and LM Studio needs one of them running on this computer. In NOR-F16-02d neither answered (`curl` to `127.0.0.1:11434/api/tags` and `127.0.0.1:1234/v1/models` found nothing), so that run was skipped. With Ollama running, `curl -s http://127.0.0.1:11434/api/ps` shows the fields the parser reads: `models[].name`, `models[].model`, `models[].size` and `models[].size_vram`.

Run the tests of the runner with `pnpm exec vitest run packages/model/src/bench-runner.test.ts`.

## The results on disk

`Backend.saveBenchResult(text)` writes a run and `Backend.listBenchResults()` lists the ones written. The code is `crates/noren-core/src/bench.rs` (`BenchStore`, no Tauri), the commands `bench_save` and `bench_list` in the Tauri app (the main window only), `FakeBackend` for the tests and the web demo (in memory only, so a web page forgets its results when it is closed) and `packages/model/src/bench-results.ts` for the page.

**The folder.** `bench-results/` in the data folder of the app, next to `state.json`. It is created when the first result is saved; listing never creates it, and a folder that is not there is no results.

**The name is not the caller's.** `saveBenchResult` takes only the text of the run. The file name is built from its `startedAt` (an ISO 8601 time in UTC, the form `Date.toISOString` writes): `2026-10-20T14:05:09.123Z` is `2026-10-20-140509.json`, the same name `benchResultPath` gives. A name has to be exactly `YYYY-MM-DD-HHmmss` with a real month, day and time (a slash, `..`, a drive, an absolute path or another shape is refused before anything is written), so the path can never leave the folder. A text that is not a JSON object with such a `startedAt` is refused too.

**Two runs in the same second** (a second window, a script) are `2026-10-20-140509.json`, then `-2.json`, `-3.json`; a file is never replaced, and the call resolves with the name it was written under. Up to 999 files fit in one second.

**Writing** is atomic (a temporary file beside it, then a rename), the same way as `state.json`. A text over 1 MiB (`MAX_BENCH_RESULT_BYTES`; a run of the 60 tasks is about 30 KiB) is refused.

**Listing** returns `{ name, text }` newest first: by start time, and `-3` before `-2` before the file with no suffix. At most 100 are returned (`MAX_BENCH_RESULTS`). A file is left out when its name is not one the app writes, when it is a folder or a link to one, is not UTF-8 text, is not shaped like a JSON object or is over 1 MiB; a file that is left out does not count toward the 100.

**The page checks the run twice.** The core keeps text and does not know the schema. `saveBenchRun(backend, run)` checks the run with `benchRunSchema` and rejects, calling the backend not at all, when it is not valid; `loadBenchRuns(backend)` checks every listed file again and leaves out the ones that are not JSON or not a valid run, so a file edited by hand or written by a later version never stops the list. A backend that cannot read the folder rejects.

Run the tests with `pnpm exec vitest run packages/model/src/bench-results.test.ts` and `cargo test -p noren-core bench`.

## The scoreboard

`packages/model/src/bench-scoreboard.ts` turns the saved runs (`SavedBenchRun[]` of `loadBenchRuns`) into a scoreboard, picks the model to suggest as the default, writes the edit of the settings that makes it the default and writes the table as CSV. It is pure TypeScript (no file, no DOM, no Tauri); the screen that shows it is described in [The screen](#the-screen).

**One row for each model.** `benchScoreboard(saved)` makes a row for each pair of provider id and model, from the newest run of the pair (by `startedAt`, compared as a time, so `…09Z` is older than `…09.5Z`; the same moment goes to the later file, `-2` after the file with no suffix). A row has the rank, the provider, the model, how many runs the pair has (`runs`), the file and start time of the newest run, its `state` (`complete` or `cancelled`), `planned`, `done` and `errors`, the accuracy of the run and of each kind, the medians (time to the first piece, total time, tokens per second), `tokensSource` (`stream`, `estimate`, `mixed` when the run has both, or `null` when no task has a reading) and `memory`. An older run only adds to `runs`; it never changes the numbers.

**The order.** Accuracy, highest first; a tie goes to the lower median total time (a row with none, because every call failed, comes last); then the provider id and the model, as plain text. A run that was cancelled is listed like the others, with the tasks it did, and is never recommended.

**The recommendation.** `recommendBenchModel(rows)` picks the model to suggest as the default for this computer:

1. Only a row whose newest run is `complete` and has an accuracy above 0 can be picked (`recommendable`). A model whose newest run was cancelled is out even if an older run was complete: the newest run is the one that says how the model does now.
2. The highest accuracy wins.
3. A tie goes to the lower median total time (no median comes last).
4. Still tied, the smaller memory (`memory.bytes`; a row with no reading comes after one that has it).
5. Still tied, the provider id and then the model, so the answer never depends on the order of the files.

No row that can be picked (no runs, only cancelled runs, or no answer right anywhere) is `undefined`: nothing is recommended, and the screen should say so instead of picking a model. Memory is only read from Ollama, so on a tie of accuracy and time an Ollama model with a reading comes before a model of another provider.

**Making it the default.** `benchDefaultEdits({ provider, model }, knownProviderIds)` gives the edits for `editConfigText` that set `ai.defaults.ask`, `ai.defaults.explain` and `ai.defaults.command` (the three `AI_FUNCTIONS`, each with its `provider` and its `model`), and nothing else: it does not turn `ai.enabled` on. `knownProviderIds` is `knownAiProviderIds(config.ai?.providers)`, which is `ollama` and the ids listed in `ai.providers`. The result is `{ ok: true, edits }`, or `{ ok: false, reason }` with no edits for a provider the settings do not know (`unknown-provider`: they would not pass the schema) or a model that is blank or longer than `MAX_AI_MODEL` (`bad-model`). The comments and the other settings of the file stay, because `editConfigText` only replaces or inserts the values.

**The CSV.** `benchScoreboardCsv(rows)` writes `BENCH_CSV_HEADER` (`rank,provider_id,model,runs,file,started_at,state,planned,done,errors,accuracy,accuracy_command,accuracy_explain,accuracy_summarize,median_first_chunk_ms,median_total_ms,median_tokens_per_second,tokens_source,memory_bytes,memory_vram_bytes,recommended`) and a record for each row, cells separated by a comma and every line, the last too, ended by `\n`. Numbers are written with `String` (a point, no grouping, no locale) and an empty cell is a number there is no reading for. A cell is put in quotes, with each quote doubled, when it has a comma, a quote or a line break (RFC 4180). The model name and the provider id come from the provider, so a text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets an apostrophe in front (`=1+1` is written `'=1+1`) and a spreadsheet shows it as text instead of running it. `recommended` is `true` on the row `recommendBenchModel` picks.

Run the tests with `pnpm exec vitest run packages/model/src/bench-scoreboard.test.ts`.

## Recommended models

`packages/model/src/bench-models.ts` holds the curated list of local models and picks the ones that fit a computer. It is pure TypeScript: it reads no file and no hardware (the memory is an argument; the machine is read by the Rust side, see [The memory of the machine](#the-memory-of-the-machine)), opens no connection and **never runs a command**. The screen that uses it comes later and puts an install command in a terminal only after the person confirms it (D8).

**The catalog.** `BENCH_MODEL_CATALOG` is a list of models, each checked by `benchCatalogModelSchema` (strict: no other field):

| Field            | Meaning                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`             | The model as the Ollama library names it, `name:tag` (`qwen3:8b`). It is data, not a label.                         |
| `downloadBytes`  | Size of the download, whole bytes.                                                                                  |
| `minMemoryBytes` | The memory the model needs to run, whole bytes, at least the download.                                              |
| `uses`           | What it is good for: `ask`, `explain`, `command` (the three AI functions), at least one, none twice.                |
| `license`        | `Apache-2.0` or `MIT`: open weights under a permissive license. A model under custom or research-only terms is out. |

`benchCatalogSchema` also refuses an empty list and an id listed twice. An id is a strict `name:tag`: lower-case letters and digits with one `.`, `-` or `_` between two runs of them, a single `:`, at most 64 characters (`isBenchModelId`). A space, `;`, `&`, `|`, `$`, a backtick, a quote, a line break, `..`, a slash or a leading `-` cannot match, so an id is one safe word in PowerShell and in bash. The catalog names no maker's product in a text of the interface: it has no label field, and the screen words each model in its own text.

**Where the sizes come from.** The download is the size the Ollama library prints for the tag (`https://ollama.com/library/<name>/tags`) and the license is the one on the page of the tag, both read on 2026-10-21. `minMemoryBytes` is the download plus 1 GiB for the context (4 K tokens) and the runtime buffers, rounded up to half a GiB. `qwen2.5-coder:3b` is not in the catalog because its tag is under a research-only license. Refresh the numbers from those pages when a model is added or a tag changes.

**The choice.** `recommendedBenchModels({ ramBytes, vramBytes }, catalog?)` returns the models that fit, the most capable first:

- `vramBytes` is the video memory, or `null` when it is not known. When it is a number (0 included) the models are chosen for it, because a model that fits there runs on the GPU. When it is `null`, or when no model fits it (a small or shared GPU next to plenty of RAM), they are chosen for the RAM, and `memory` says `"ram"` (or `"vram"`).
- **The margin.** A model may take part of a memory, not all of it: **60% of the RAM** (`BENCH_RAM_SHARE`; the system, the terminal, the browser and the rest need the other 40%, and a model that leaves the machine swapping is worse than a smaller one) and **90% of the video memory** (`BENCH_VRAM_SHARE`; the screen and the driver keep some). The budget is `floor(bytes × share)` in whole bytes (`budgetBytes` in the answer) and a model fits when `minMemoryBytes <= budgetBytes`: a model that needs exactly the budget fits, one byte less memory does not.
- **The order.** The memory the model needs, largest first (more weights is more capable), then the id as plain text, so the order never depends on the order of the catalog. Each entry has its `rank` from 1, its `headroomBytes` (the budget minus what it needs) and a `reason`: `largest-fit` for the first and `fits` for the rest.
- **Nothing fits.** An empty `models` with `emptyReason: "no-model-fits"`, not an error.
- **A memory that is not valid** (negative, fractional, `NaN`, infinite, beyond 2^53, not a number, a missing `ramBytes` or `vramBytes`) is `{ ok: false, reason: "invalid-hardware" }`. It never throws.

| RAM, no video memory | Budget (60%) | Best of the catalog  | Models |
| -------------------- | ------------ | -------------------- | ------ |
| 4 GiB                | 2.4 GiB      | `qwen2.5-coder:1.5b` | 1      |
| 8 GiB                | 4.8 GiB      | `phi4-mini:latest`   | 5      |
| 16 GiB               | 9.6 GiB      | `qwen2.5-coder:14b`  | 10     |
| 32 GiB               | 19.2 GiB     | `qwen3:14b`          | 11     |
| **Video memory**     | **Budget**   |                      |        |
| 6 GiB                | 5.4 GiB      | `phi4-mini:latest`   | 5      |
| 12 GiB               | 10.8 GiB     | `qwen3:14b`          | 11     |
| 24 GiB               | 21.6 GiB     | `qwen2.5-coder:32b`  | 13     |

**The install command.** `ollamaPullCommand(id, catalog?)` returns `{ ok: true, command: "ollama pull <id>" }` for an id that is a strict `name:tag` **and** is in the catalog. Any other text is `{ ok: false, reason }`: `bad-id` for a shape that is not a model id (a space, a line break, `;`, `&`, `|`, `$`, a backtick, a quote, `..`, a leading `-`, a text over 64 characters, something that is not a string) and `not-in-catalog` for a well-formed id the catalog does not list. The command is the same text in PowerShell and in bash and is only text: nothing here runs it.

Run the tests with `pnpm exec vitest run packages/model/src/bench-models.test.ts`.

## The memory of the machine

`Backend.readHardware()` answers the memory that `recommendedBenchModels` takes: `{ ramBytes, vramBytes }`, or `null` when the RAM is not known. It only reads: nothing is written, installed or sent anywhere. The screen that uses it comes in the next task; nothing calls it yet.

- **RAM.** `noren-core` (`crates/noren-core/src/hardware.rs`, no Tauri) asks `sysinfo` (already a dependency, with only its `system` feature) for the total memory.
- **VRAM.** There is no portable way to ask for it and no crate in the tree reads it, so the one source is `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`, which ships with the driver of NVIDIA cards. It is started with no window (`CREATE_NO_WINDOW` on Windows), no input, its error output thrown away, at most 4 KiB of its output read and a 3 second deadline after which it is killed. A card of another make, the memory a computer shares between processor and screen (Apple Silicon, most integrated graphics), a computer with no `nvidia-smi` or a driver that hangs all give `vramBytes: null`, which the recommendation reads as "choose for the RAM". With several cards the largest one counts, because a model that needs more than one card has to be split across them and is slower; the list should not promise what one card cannot hold.
- **Nothing fails.** A number is kept only when it is a whole number of bytes above 0 and at most 2^53 - 1 (`Number.MAX_SAFE_INTEGER`; `MAX_EXACT_BYTES`), which a JavaScript number holds exactly. A VRAM that is missing, 0 or past that is `null`; a RAM that is missing, 0 or past it leaves no reading at all (`null`). The text of `nvidia-smi` is parsed strictly (`parse_nvidia_smi_memory`): one whole number of MiB per line and nothing else; `N/A`, `[Not Supported]`, a sign, a fraction, a unit, an error message, a card of 0 MiB or a number whose size in bytes is past the limit makes the whole text `null`, and so does one bad line among good ones. A program that is not there, fails, takes too long or prints something that is not text is `null`.
- **Where it lives.** The reading sits behind the `HardwareSource` trait (as `ProcessSource` does for the agent detector), so the tests feed values they made up; `SystemHardware` is the real source (`with_nvidia_smi(program, timeout)` points it at another program for a test). The Tauri command is `hardware_read` (`bridge.rs`, over a `HardwareState` that holds the source, so the tests of the command feed a made-up one and start no process; it runs off the async workers because it may start a process), registered in `main.rs` and `build.rs` and granted to the `main` window only; it answers `{ ramBytes, vramBytes }` with `vramBytes` always present (`null` when unknown), or `null`. `TauriBackend.readHardware` passes the answer through `benchHardwareOf`, the one rule of the page: a RAM that is not a whole number above 0 up to `Number.MAX_SAFE_INTEGER` is `null`, a VRAM that is not one is `null`, any other field is dropped. A browser cannot ask its visitor's computer, so the web build answers `null`.
- **The fake.** `new FakeBackend({ hardware: { ramBytes, vramBytes } })` and `setHardware(hardware | null)` simulate a computer (read through `benchHardwareOf` as well, so the fake cannot answer what the real backend never would). The default is `null`: no hardware known, as in the browser; a test or an e2e that needs a memory says so.

Run the tests with `cargo test -p noren-core --lib hardware` (add `-- --nocapture` to see the memory this computer reports), `cargo test -p noren the_page_reads_the_memory` and `pnpm exec vitest run packages/model/src/fake-backend-hardware.test.ts apps/desktop/src/tauri-backend.test.ts`.

## The screen

The scoreboard is in the AI section of the settings screen, under the providers (`apps/desktop/src/BenchPanel.tsx`). It reads the saved results through the backend (`loadBenchRuns`, so a file that is not a valid run is left out) when the settings open, and has a "Reload results" button. It only reads results; **running the bench from the screen is not done yet**, and the empty state says so and says where a result is saved.

- **The table.** One row for each model in the order of the board: model, provider, accuracy overall and for commands, explanations and summaries, the median time to the first piece and the total time, the tokens per second with where they come from (counted by the server, estimated, or both), the memory Ollama held (and the part in video memory), and the run: finished, or cancelled with how many of the planned tasks it did, plus how many runs the model has. A dash is a number there is no reading for. The recommended row carries a "Recommended" mark (`data-nr-recommended="true"` on the row); a line above the table names it, or says that no model can be recommended yet.
- **Use as default.** Each row has a button, and there is one for the recommended model. It takes `benchDefaultEdits` with the ids of `knownAiProviderIds(config.ai.providers)` and hands the edits to `configManager.update`, so `ai.defaults.ask`, `explain` and `command` are written at once into `config.jsonc` with its comments (the AI stays off if it was off). A refusal (a provider the settings do not list, or a bad model name) and a failed update (for example a file with a syntax error) are shown as an alert and nothing is written. The reason of a failed update is the text of the config manager, which is English.
- **Export.** "Copy scoreboard as CSV" puts `benchScoreboardCsv` on the clipboard, the way the terminal copy does. A clipboard needs no file dialog or download folder, and nothing leaves the computer. (The clipboard of Windows hands the line breaks back as CRLF; the text the app writes has LF.)
- **Web build.** The e2e tests seed result files under the `noren.web.bench-results` key of the browser storage before the page loads: a JSON object from a file name (`2026-10-20-120000.json`) to the run, written as a text or as the object itself. They reach `listBenchResults` of the fake backend like the files of the data folder. The fixtures are in `e2e/bench-fixture.ts` and are checked with `benchRunSchema`.

Run the tests with `pnpm exec playwright test -c e2e/playwright.config.ts bench.spec.ts` (after `pnpm --filter @noren/desktop build`) and `pnpm exec vitest run apps/desktop/src/bench-format.test.ts apps/desktop/src/web-bench-results.test.ts`.
