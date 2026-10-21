# Bench task suite

`bench/tasks/` holds 60 tasks that a local model is asked to do, each with an automatic check. A runner (NOR-F16-02) will send the tasks to a model server and count the right answers; this page is the format of a task and the rules of the check. The code is `packages/model/src/bench-suite.ts` and the test `bench-suite.test.ts`, which reads every file in the folder.

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
