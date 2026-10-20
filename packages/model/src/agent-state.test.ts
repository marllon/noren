import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_ECHO_WINDOW_MS,
  AGENT_STATES,
  AgentCatalogSchema,
  AgentStateTracker,
  DEFAULT_AGENT_CATALOG,
  ManualClock,
  ShellIntegrationParser,
  TerminalTextStripper,
  advanceAgentState,
  agentSettingsOf,
  compileAgentRules,
  configJsonSchema,
  parseConfigText,
  settleAgentState,
  startAgentState,
} from "./index";
import type { AgentEntry, AgentRules, AgentSignal, AgentState } from "./index";
import { encodeUtf8 } from "./utf8";
import { AGENT_FIXTURES, AIDER_FIXTURE, CLAUDE_FIXTURE, CODEX_FIXTURE } from "./agent-fixtures";

// The state of an agent (working, waiting for you, idle): the plain text of the output, the
// classifier over the fixtures of three agents, the notification and the silence on a clock the
// test moves, and the patterns and the silence in the catalog and in config.jsonc.

const SILENCE_MS = 8000;

const entryOf = (id: string): AgentEntry => {
  const entry = DEFAULT_AGENT_CATALOG.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no ${id} in the default catalog`);
  return entry;
};

function trackerFor(id: string) {
  const clock = new ManualClock();
  const changes: AgentState[] = [];
  const tracker = new AgentStateTracker({
    clock,
    rules: compileAgentRules(entryOf(id), SILENCE_MS),
    onChange: (state) => changes.push(state),
  });
  return { clock, tracker, changes };
}

describe("TerminalTextStripper", () => {
  const strip = (...chunks: (string | Uint8Array)[]): string => {
    const stripper = new TerminalTextStripper();
    return chunks.map((chunk) => stripper.feed(chunk)).join("");
  };

  it("keeps the words and drops colors, cursor moves and the erase codes", () => {
    expect(strip("\u001b[1;32mdone\u001b[0m in \u001b[2K\u001b[1G\u001b[3Atime")).toBe(
      "done in time",
    );
  });

  it("drops window titles and notifications ended by BEL or by ST", () => {
    expect(
      strip("a\u001b]0;my title\u0007b\u001b]9;hi\u001b\\c\u001b]777;notify;t;body\u0007d"),
    ).toBe("abcd");
  });

  it("drops device control strings and charset selection", () => {
    expect(strip("x\u001bPq#0;2;0;0;0\u001b\\y\u001b(Bz\u001b7\u001b8")).toBe("xyz");
  });

  it("reads a line end as one \\n, whether it is \\n, \\r\\n or a lone \\r", () => {
    expect(strip("a\r\nb\nc\rd")).toBe("a\nb\nc\nd");
    expect(strip("a\r", "\nb")).toBe("a\nb");
  });

  it("follows a sequence cut between two chunks", () => {
    expect(strip("ab\u001b", "[3", "1mcd\u001b]0;ti", "tle\u0007ef")).toBe("abcdef");
    expect(strip("ab\u001b]9;no", "te\u001b", "\\cd")).toBe("abcd");
  });

  it("keeps a UTF-8 character that is cut between two chunks", () => {
    const bytes = encodeUtf8("aé✻b");
    const cut = bytes.indexOf(0xe2) + 1;
    expect(strip(bytes.slice(0, cut), bytes.slice(cut))).toBe("aé✻b");
  });

  it("drops the other control characters and lets CAN end a sequence", () => {
    expect(strip("a\u0007b\u0008c\u007fd")).toBe("abcd");
    expect(strip("a\u001b[12\u0018b")).toBe("ab");
  });

  it("never throws and never gives back an escape character", () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 40 }), { maxLength: 10 }), (chunks) => {
        const stripper = new TerminalTextStripper();
        for (const chunk of chunks) {
          const text = stripper.feed(chunk);
          expect(text).not.toContain("\u001b");
        }
      }),
    );
  });
});

describe("the fixtures of three agents", () => {
  it("are three, and each is told by the catalog of the app", () => {
    expect(AGENT_FIXTURES.map((fixture) => fixture.agent)).toEqual(["claude", "codex", "aider"]);
    for (const fixture of AGENT_FIXTURES) expect(entryOf(fixture.agent).patterns).toBeDefined();
  });

  for (const fixture of AGENT_FIXTURES) {
    describe(fixture.agent, () => {
      it("is working while it prints its status and its work", () => {
        const { tracker } = trackerFor(fixture.agent);
        expect(tracker.state).toBe("idle");
        for (const chunk of fixture.working) tracker.feed(chunk);
        expect(tracker.state).toBe("working");
      });

      it("is waiting for you when it asks a question, even one cut between two chunks", () => {
        const { tracker } = trackerFor(fixture.agent);
        for (const chunk of fixture.working) tracker.feed(chunk);
        for (const chunk of fixture.waiting) tracker.feed(chunk);
        expect(tracker.state).toBe("waiting");
      });

      it("is idle when its prompt is back after the work", () => {
        const { tracker } = trackerFor(fixture.agent);
        for (const chunk of fixture.working) tracker.feed(chunk);
        expect(tracker.state).toBe("working");
        for (const chunk of fixture.idle) tracker.feed(chunk);
        expect(tracker.state).toBe("idle");
      });

      it("goes idle after the question is answered and the prompt is back", () => {
        const { clock, tracker } = trackerFor(fixture.agent);
        for (const chunk of fixture.waiting) tracker.feed(chunk);
        expect(tracker.state).toBe("waiting");
        clock.advance(1000);
        tracker.input();
        expect(tracker.state).toBe("working");
        for (const chunk of fixture.idle) tracker.feed(chunk);
        expect(tracker.state).toBe("idle");
      });

      it("gives the same answer with the pure functions, chunk by chunk", () => {
        const rules = compileAgentRules(entryOf(fixture.agent), SILENCE_MS);
        const stripper = new TerminalTextStripper();
        let memory = startAgentState(0);
        const run = (chunks: readonly string[], now: number) => {
          for (const chunk of chunks) {
            memory = advanceAgentState(
              memory,
              { kind: "output", text: stripper.feed(chunk) },
              now,
              rules,
            );
          }
        };
        run(fixture.working, 100);
        expect(memory.state).toBe("working");
        run(fixture.waiting, 200);
        expect(memory.state).toBe("waiting");
        expect(memory.since).toBe(200);
      });
    });
  }

  it("keep the state apart: a question of one agent is not read in the output of another", () => {
    const { tracker } = trackerFor("aider");
    for (const chunk of CLAUDE_FIXTURE.working) tracker.feed(chunk);
    // The status line of another agent is only output: it still means work.
    expect(tracker.state).toBe("working");
    for (const chunk of CODEX_FIXTURE.waiting) tracker.feed(chunk);
    // `aider` has no pattern for this question: the output is just more work.
    expect(tracker.state).toBe("working");
    for (const chunk of AIDER_FIXTURE.waiting) tracker.feed(chunk);
    expect(tracker.state).toBe("waiting");
  });
});

describe("a notification (OSC 9 and OSC 777)", () => {
  it("makes a working agent wait for you", () => {
    const { tracker, changes } = trackerFor("claude");
    for (const chunk of CLAUDE_FIXTURE.working) tracker.feed(chunk);
    tracker.notify();
    expect(tracker.state).toBe("waiting");
    expect(changes).toEqual(["working", "waiting"]);
  });

  it("makes an idle agent wait for you, and OSC 9 and 777 both arrive as notifications", () => {
    const parser = new ShellIntegrationParser();
    const events = [
      ...parser.feed("\u001b]9;needs you\u0007"),
      ...parser.feed("\u001b]777;notify;Agent;needs you\u0007"),
    ];
    expect(events.map((event) => event.kind)).toEqual(["notification", "notification"]);
    const { tracker } = trackerFor("codex");
    for (const event of events) if (event.kind === "notification") tracker.notify();
    expect(tracker.state).toBe("waiting");
  });

  it("is not undone by silence", () => {
    const { clock, tracker } = trackerFor("claude");
    tracker.notify();
    clock.advance(10 * SILENCE_MS);
    expect(tracker.state).toBe("waiting");
  });
});

describe("silence, on a clock the test moves", () => {
  it("turns a working agent idle after the silence, and not a moment before", () => {
    const { clock, tracker, changes } = trackerFor("codex");
    tracker.feedText("compiling the module\n");
    expect(tracker.state).toBe("working");
    clock.advance(SILENCE_MS - 1);
    expect(tracker.state).toBe("working");
    clock.advance(1);
    expect(tracker.state).toBe("idle");
    expect(changes).toEqual(["working", "idle"]);
    expect(clock.pending).toBe(0);
  });

  it("counts from the last output: more output moves the end of the silence", () => {
    const { clock, tracker } = trackerFor("codex");
    tracker.feedText("one\n");
    clock.advance(SILENCE_MS - 1000);
    tracker.feedText("two\n");
    clock.advance(SILENCE_MS - 1);
    expect(tracker.state).toBe("working");
    clock.advance(1);
    expect(tracker.state).toBe("idle");
  });

  it("is configurable per agent, over the default of the settings", () => {
    const clock = new ManualClock();
    const entry: AgentEntry = { id: "napper", executables: ["napper"], silenceSeconds: 2 };
    const tracker = new AgentStateTracker({ clock, rules: compileAgentRules(entry, SILENCE_MS) });
    tracker.feedText("busy\n");
    clock.advance(1999);
    expect(tracker.state).toBe("working");
    clock.advance(1);
    expect(tracker.state).toBe("idle");
  });

  it("takes new rules at once (the settings file changed)", () => {
    const { clock, tracker } = trackerFor("codex");
    tracker.feedText("busy\n");
    clock.advance(1000);
    tracker.setRules(compileAgentRules(undefined, 1500));
    clock.advance(499);
    expect(tracker.state).toBe("working");
    clock.advance(1);
    expect(tracker.state).toBe("idle");
  });

  it("leaves no timer when the state is not working, nor after dispose", () => {
    const { clock, tracker } = trackerFor("codex");
    expect(clock.pending).toBe(0);
    tracker.feedText("busy\n");
    expect(clock.pending).toBe(1);
    tracker.notify();
    expect(clock.pending).toBe(0);
    tracker.input();
    expect(clock.pending).toBe(1);
    tracker.dispose();
    expect(clock.pending).toBe(0);
    tracker.feedText("more\n");
    expect(tracker.state).toBe("working");
    expect(clock.pending).toBe(0);
  });

  it("settleAgentState changes nothing for an agent that is not working", () => {
    const rules = compileAgentRules(undefined, SILENCE_MS);
    const waiting = advanceAgentState(startAgentState(0), { kind: "notification" }, 5, rules);
    expect(settleAgentState(waiting, 10 * SILENCE_MS, rules)).toBe(waiting);
  });
});

describe("what the person types", () => {
  const rules = compileAgentRules(undefined, SILENCE_MS);
  const output = (text: string): AgentSignal => ({ kind: "output", text });

  it("answers a question: waiting becomes working", () => {
    let memory = advanceAgentState(startAgentState(0), { kind: "notification" }, 10, rules);
    memory = advanceAgentState(memory, { kind: "input" }, 500, rules);
    expect(memory.state).toBe("working");
    expect(memory.since).toBe(500);
  });

  it("does not start work by itself, and the echo of the keys is not work", () => {
    let memory = startAgentState(0);
    memory = advanceAgentState(memory, { kind: "input" }, 1000, rules);
    expect(memory.state).toBe("idle");
    memory = advanceAgentState(memory, output("h"), 1000 + AGENT_ECHO_WINDOW_MS - 1, rules);
    expect(memory.state).toBe("idle");
    // The same text a moment later is the agent answering.
    memory = advanceAgentState(memory, output("thinking\n"), 1000 + AGENT_ECHO_WINDOW_MS, rules);
    expect(memory.state).toBe("working");
  });

  it("does not read the question again once it was answered", () => {
    const entry = entryOf("aider");
    const own = compileAgentRules(entry, SILENCE_MS);
    let memory = advanceAgentState(startAgentState(0), output("(Y)es/(N)o [Yes]: "), 10, own);
    expect(memory.state).toBe("waiting");
    memory = advanceAgentState(memory, { kind: "input" }, 20, own);
    memory = advanceAgentState(memory, output("working on it\n"), 400, own);
    expect(memory.state).toBe("working");
  });
});

describe("the rules in order", () => {
  const entry: AgentEntry = {
    id: "demo",
    executables: ["demo"],
    patterns: { working: ["busy"], waiting: ["question"], idle: ["ready"] },
  };
  const rules = compileAgentRules(entry, SILENCE_MS);
  const state = (text: string, from?: AgentState): AgentState => {
    let memory = startAgentState(0);
    if (from === "working")
      memory = advanceAgentState(memory, { kind: "output", text: "x\n" }, 1, rules);
    if (from === "waiting") memory = advanceAgentState(memory, { kind: "notification" }, 1, rules);
    return advanceAgentState(memory, { kind: "output", text }, 1000, rules).state;
  };

  it("waiting beats working, working beats idle", () => {
    expect(state("busy question ready")).toBe("waiting");
    expect(state("busy ready")).toBe("working");
    expect(state("ready")).toBe("idle");
  });

  it("matches without caring about case, and ^ and $ are line by line", () => {
    const own = compileAgentRules(
      { id: "x", executables: ["x"], patterns: { idle: ["^> $"] } },
      SILENCE_MS,
    );
    const next = advanceAgentState(
      advanceAgentState(startAgentState(0), { kind: "output", text: "x\n" }, 1, own),
      { kind: "output", text: "done\n> " },
      2,
      own,
    );
    expect(next.state).toBe("idle");
    expect(state("BUSY")).toBe("working");
  });

  it("calls any other visible text work, and nothing visible changes nothing", () => {
    expect(state("hello\n")).toBe("working");
    expect(state("   \n\n")).toBe("idle");
    expect(state("   \n", "waiting")).toBe("waiting");
  });

  it("keeps waiting through plain output (a redraw of the question)", () => {
    expect(state("blinking cursor\n", "waiting")).toBe("waiting");
    expect(state("busy", "waiting")).toBe("working");
    expect(state("ready", "waiting")).toBe("idle");
  });

  it("falls back on the generic questions when the entry lists no waiting pattern", () => {
    const bare = compileAgentRules({ id: "x", executables: ["x"] }, SILENCE_MS);
    for (const question of [
      "Overwrite the file? [y/N] ",
      "Continue (yes/no)? ",
      "Press Enter to continue",
      "Do you want to proceed?",
    ]) {
      const next = advanceAgentState(
        startAgentState(0),
        { kind: "output", text: question },
        1,
        bare,
      );
      expect(next.state, question).toBe("waiting");
    }
    const plain = advanceAgentState(
      startAgentState(0),
      { kind: "output", text: "Ran 3 tests\n" },
      1,
      bare,
    );
    expect(plain.state).toBe("working");
  });

  it("an entry with an empty waiting list has no waiting patterns, not even the generic ones", () => {
    const none = compileAgentRules(
      { id: "x", executables: ["x"], patterns: { waiting: [] } },
      SILENCE_MS,
    );
    const next = advanceAgentState(startAgentState(0), { kind: "output", text: "[y/N] " }, 1, none);
    expect(next.state).toBe("working");
  });
});

describe("robustness", () => {
  const signal: fc.Arbitrary<AgentSignal> = fc.oneof(
    fc.string({ maxLength: 200 }).map((text): AgentSignal => ({ kind: "output", text })),
    fc.constant<AgentSignal>({ kind: "notification" }),
    fc.constant<AgentSignal>({ kind: "input" }),
  );

  it("any run of signals ends in one of the three states, with time that only moves forward", () => {
    const rules: AgentRules = compileAgentRules(entryOf("claude"), SILENCE_MS);
    fc.assert(
      fc.property(
        fc.array(fc.tuple(signal, fc.integer({ min: 0, max: 20000 })), { maxLength: 40 }),
        (run) => {
          let memory = startAgentState(0);
          let now = 0;
          for (const [next, step] of run) {
            now += step;
            memory = advanceAgentState(memory, next, now, rules);
            memory = settleAgentState(memory, now, rules);
            expect(AGENT_STATES).toContain(memory.state);
            expect(memory.since).toBeLessThanOrEqual(now);
            expect(memory.partial.length).toBeLessThanOrEqual(1000);
          }
        },
      ),
    );
  });

  it("reads a flood of output at the cost of a page", () => {
    const rules = compileAgentRules(entryOf("claude"), SILENCE_MS);
    const flood = "line of output without a question\n".repeat(200_000);
    const started = Date.now();
    const next = advanceAgentState(startAgentState(0), { kind: "output", text: flood }, 1, rules);
    expect(next.state).toBe("working");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("patterns and silence in the catalog", () => {
  const parse = (value: unknown) => AgentCatalogSchema.safeParse(value);

  it("the built-in catalog is valid and every pattern in it is a regular expression", () => {
    expect(parse(DEFAULT_AGENT_CATALOG).success).toBe(true);
    for (const entry of DEFAULT_AGENT_CATALOG) {
      const rules = compileAgentRules(entry, SILENCE_MS);
      const listed = Object.values(entry.patterns ?? {}).flat().length;
      expect(
        rules.working.length + rules.waiting.length + rules.idle.length,
      ).toBeGreaterThanOrEqual(listed);
    }
  });

  it("takes patterns for each state and a silence of its own", () => {
    const result = parse([
      {
        id: "helper",
        executables: ["helper"],
        patterns: { working: ["thinking"], waiting: ["\\[y/n\\]", "^allow\\?"], idle: ["^> $"] },
        silenceSeconds: 20,
      },
    ]);
    expect(result.success).toBe(true);
  });

  it("takes an entry with no patterns and no silence, as before", () => {
    expect(parse([{ id: "helper", executables: ["helper"] }]).success).toBe(true);
  });

  it("refuses a pattern that is not a regular expression, at its place", () => {
    const result = parse([
      { id: "helper", executables: ["helper"], patterns: { waiting: ["fine", "(unclosed"] } },
    ]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual([0, "patterns", "waiting", 1]);
    expect(result.error.issues[0]?.message).toBe("Not a valid regular expression");
  });

  it("refuses an empty pattern, a pattern that is too long, too many, and an unknown state", () => {
    const base = { id: "helper", executables: ["helper"] };
    expect(parse([{ ...base, patterns: { idle: [""] } }]).success).toBe(false);
    expect(parse([{ ...base, patterns: { idle: ["a".repeat(201)] } }]).success).toBe(false);
    expect(
      parse([{ ...base, patterns: { idle: Array.from({ length: 17 }, () => "a") } }]).success,
    ).toBe(false);
    expect(parse([{ ...base, patterns: { sleeping: ["a"] } }]).success).toBe(false);
    expect(parse([{ ...base, patterns: { idle: [1] } }]).success).toBe(false);
  });

  it("refuses a silence that is not between 1 second and an hour", () => {
    const base = { id: "helper", executables: ["helper"] };
    for (const bad of [0, 0.5, -3, 3601, Number.NaN, "5"]) {
      expect(parse([{ ...base, silenceSeconds: bad }]).success, String(bad)).toBe(false);
    }
    expect(parse([{ ...base, silenceSeconds: 1 }]).success).toBe(true);
    expect(parse([{ ...base, silenceSeconds: 3600 }]).success).toBe(true);
  });
});

describe("patterns and silence in config.jsonc", () => {
  function configOf(text: string) {
    const result = parseConfigText(text);
    if (!result.ok) throw new Error(`expected a valid file: ${JSON.stringify(result.errors)}`);
    return result.config;
  }

  it("takes 8 seconds of silence when the file says nothing", () => {
    expect(agentSettingsOf(configOf("{}").agents).silenceMs).toBe(8000);
  });

  it("takes the silence of the file, and falls back on the default for one out of range", () => {
    expect(
      agentSettingsOf(configOf('{ "agents": { "silenceSeconds": 20 } }').agents).silenceMs,
    ).toBe(20000);
    expect(agentSettingsOf({ silenceSeconds: 0 }).silenceMs).toBe(8000);
    expect(agentSettingsOf({ silenceSeconds: Number.NaN }).silenceMs).toBe(8000);
    expect(agentSettingsOf({ silenceSeconds: 99999 }).silenceMs).toBe(8000);
  });

  it("takes patterns in a catalog of your own", () => {
    const config = configOf(`{
  "agents": {
    "silenceSeconds": 12,
    "catalog": [
      { "id": "helper", "executables": ["helper"], "patterns": { "waiting": ["continue\\\\?"] } },
    ],
  },
}`);
    const settings = agentSettingsOf(config.agents);
    expect(settings.silenceMs).toBe(12000);
    expect(settings.catalog[0]?.patterns?.waiting).toEqual(["continue\\?"]);
  });

  it("refuses an invalid pattern and a silence out of range, with the place and the line", () => {
    const result = parseConfigText(`{
  "agents": {
    "catalog": [
      { "id": "helper", "executables": ["helper"], "patterns": { "idle": ["[a-"] } },
    ],
  },
}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("Not a valid regular expression");
    expect(result.errors[0]?.line).toBe(4);
    expect(parseConfigText('{ "agents": { "silenceSeconds": 0 } }').ok).toBe(false);
    expect(parseConfigText('{ "agents": { "silenceSeconds": 7200 } }').ok).toBe(false);
  });

  it("describes the new fields in the JSON Schema", () => {
    const text = JSON.stringify(configJsonSchema());
    for (const word of ["silenceSeconds", "patterns", "waiting", "working", "idle"]) {
      expect(text).toContain(`"${word}"`);
    }
  });
});
