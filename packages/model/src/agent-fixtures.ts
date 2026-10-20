// Output of three CLI agents, as their terminals receive it (colors, cursor moves, a window title),
// used by the state tests. Not part of the public API. The names are the ids of the executables,
// as the catalog has them; nothing here is shown in the interface.
//
// Each fixture has three runs, one for each state the classifier tells:
// - `working`: what the agent prints while it works (status line, diff, progress);
// - `waiting`: a question that needs the person (a permission, a choice);
// - `idle`: the input prompt back after the work, which is the end of a turn.
// A run is a list of chunks, in the order the session delivered them. The question of `waiting` is
// cut between two chunks on purpose in one of them.

const ESC = "\u001b";
const CSI = `${ESC}[`;
const dim = (text: string): string => `${CSI}2m${text}${CSI}22m`;
const bold = (text: string): string => `${CSI}1m${text}${CSI}22m`;
const color = (code: number, text: string): string => `${CSI}${code}m${text}${CSI}39m`;
const clearLine = `${CSI}2K${CSI}1G`;
const title = (text: string): string => `${ESC}]0;${text}\u0007`;

export interface AgentFixture {
  /** The catalog id of the agent. */
  readonly agent: string;
  readonly working: readonly string[];
  readonly waiting: readonly string[];
  readonly idle: readonly string[];
}

export const CLAUDE_FIXTURE: AgentFixture = {
  agent: "claude",
  working: [
    title("claude"),
    `${CSI}?25l${color(33, "✻")} Pondering… ${dim("(3s · esc to interrupt)")}\r\n`,
    `${clearLine}${color(33, "✶")} Pondering… ${dim("(4s · esc to interrupt)")}`,
    `\r\n${bold("● Update")}(src/main.ts)\r\n  ⎿  Updated src/main.ts with 4 additions\r\n`,
  ],
  waiting: [
    `${bold("Edit file")}\r\n src/main.ts\r\n\r\n Do you want to make this`,
    ` edit to src/main.ts?\r\n ${color(36, "❯ 1. Yes")}\r\n   2. Yes, allow all edits\r\n   3. No\r\n`,
  ],
  idle: [
    `${CSI}?25h\r\n${color(32, "● Done.")} The change is in.\r\n`,
    `${CSI}2K╭──────────────────────╮\r\n│ > ${CSI}7m ${CSI}27m                  │\r\n╰──────────────────────╯\r\n  ? for shortcuts\r\n`,
  ],
};

export const CODEX_FIXTURE: AgentFixture = {
  agent: "codex",
  working: [
    `${color(36, "•")} Working (12s • Esc to interrupt)\r\n`,
    `${CSI}1A${clearLine}${color(36, "•")} Working (13s • Esc to interrupt)\r\n`,
    `${dim("  └ ")}Read README.md\r\n`,
  ],
  waiting: [
    `${bold("Would you like to run the following command?")}\r\n\r\n  $ npm test\r\n\r\n`,
    ` ${color(32, "›")} 1. Yes, proceed\r\n   2. No, and tell Codex what to do differently\r\n`,
  ],
  idle: [
    `${color(32, "✔")} Ran npm test\r\n\r\nAll tests passed.\r\n`,
    `\r\n${CSI}1m›${CSI}22m ${dim("Send a message")}\r\n`,
  ],
};

export const AIDER_FIXTURE: AgentFixture = {
  agent: "aider",
  working: [
    "Tokens: 4.1k sent, 312 received.\r\n",
    `${color(32, "Applied edit to")} app.py\r\n`,
    "Streaming response from the model...\r\n",
  ],
  waiting: [
    `${color(33, "Run shell command?")} pytest -q\r\n`,
    "(Y)es/(N)o/(D)on't ask again [Yes]: ",
  ],
  idle: [`Commit 3f2a1b9 add a test\r\n`, `${bold("> ")}`],
};

export const AGENT_FIXTURES: readonly AgentFixture[] = [
  CLAUDE_FIXTURE,
  CODEX_FIXTURE,
  AIDER_FIXTURE,
];
