import { describe, expect, it } from "vitest";
import { FakeBackend, ManualClock, agentSettingsOf } from "@noren/model";
import type { AgentSettings, Id, Pane, Workspace } from "@noren/model";
import { AgentScanner } from "./agent-scanner";
import { fixturePane, fixtureSpace, fixtureTab } from "./closed-fixtures";

// The look at the process tree on an interval, on a manual clock and the fake backend: which panes
// are asked about, the interval taken from the settings, one look at a time, and the settings that
// turn it off or empty the catalog.

const CATALOG = [
  { id: "claude", executables: ["claude"] },
  { id: "codex", executables: ["codex"] },
];

/** A pane to put in the workspace: `session: false` leaves it with no session, `status` is its state. */
interface PanePlan {
  id: Id;
  session?: boolean;
  status?: Pane["status"];
}

interface Setup {
  clock: ManualClock;
  backend: FakeBackend;
  scanner: AgentScanner;
  settings: { current: AgentSettings };
  /** The session of each pane that has one. */
  sessions: Map<Id, number>;
  results: Map<Id, string>[];
  errors: unknown[];
}

async function setup(
  plans: readonly PanePlan[],
  settings: Partial<AgentSettings> = {},
): Promise<Setup> {
  const clock = new ManualClock();
  const backend = new FakeBackend({ clock });
  const sessions = new Map<Id, number>();
  const panes: Pane[] = [];
  for (const plan of plans) {
    const sessionId =
      plan.session === false ? undefined : await backend.createSession({ cols: 80, rows: 24 });
    if (sessionId !== undefined) sessions.set(plan.id, sessionId);
    panes.push({
      ...fixturePane(plan.id),
      ...(sessionId !== undefined ? { sessionId: String(sessionId) } : {}),
      ...(plan.status !== undefined ? { status: plan.status } : {}),
    });
  }
  const workspace: Workspace = {
    version: 2,
    spaces: [
      fixtureSpace(
        "s1",
        panes.map((pane) => fixtureTab(`i-${pane.id}`, pane)),
      ),
    ],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
  };
  const current = { current: { ...agentSettingsOf({ catalog: CATALOG }), ...settings } };
  const results: Map<Id, string>[] = [];
  const errors: unknown[] = [];
  const scanner = new AgentScanner({
    clock,
    backend,
    workspace: () => workspace,
    settings: () => current.current,
    onResult: (agents) => results.push(new Map(agents)),
    onError: (error) => errors.push(error),
  });
  return { clock, backend, scanner, settings: current, sessions, results, errors };
}

const sessionOf = (s: Setup, pane: Id): number => {
  const id = s.sessions.get(pane);
  if (id === undefined) throw new Error(`no session for ${pane}`);
  return id;
};

describe("AgentScanner", () => {
  it("maps the agent under a session back to its pane", async () => {
    const s = await setup([{ id: "p1" }, { id: "p2" }, { id: "p3" }]);
    s.backend.setSessionAgent(sessionOf(s, "p1"), "claude");
    s.backend.setSessionAgent(sessionOf(s, "p3"), "codex");
    await s.scanner.scan();
    expect(s.results).toEqual([
      new Map([
        ["p1", "claude"],
        ["p3", "codex"],
      ]),
    ]);
  });

  it("asks only about panes with a live session", async () => {
    const s = await setup([
      { id: "alive" },
      { id: "nosession", session: false },
      { id: "exited", status: "exited" },
    ]);
    await s.scanner.scan();
    const calls = s.backend.callsTo("scanAgents");
    expect(calls).toHaveLength(1);
    // The session of the pane that exited is still alive in the fake, but the pane says it ended.
    expect(calls[0]?.args[0]).toEqual([sessionOf(s, "alive")]);
  });

  it("starts with a look, then looks again after the interval of the settings, until stopped", async () => {
    const s = await setup([{ id: "p1" }], agentSettingsOf({ catalog: CATALOG, scanSeconds: 2 }));
    s.scanner.start();
    await s.scanner.scan();
    expect(s.backend.callsTo("scanAgents")).toHaveLength(1);
    s.clock.advance(1999);
    expect(s.backend.callsTo("scanAgents")).toHaveLength(1);
    s.clock.advance(1);
    await s.scanner.scan();
    expect(s.backend.callsTo("scanAgents")).toHaveLength(2);
    s.scanner.stop();
    expect(s.clock.pending).toBe(0);
    s.clock.advance(60_000);
    await s.scanner.scan();
    expect(s.backend.callsTo("scanAgents")).toHaveLength(3);
  });

  it("reads the interval again at every look", async () => {
    const s = await setup([{ id: "p1" }], agentSettingsOf({ catalog: CATALOG, scanSeconds: 10 }));
    s.scanner.start();
    await s.scanner.scan();
    s.settings.current = agentSettingsOf({ catalog: CATALOG, scanSeconds: 1 });
    s.clock.advance(10_000);
    await s.scanner.scan();
    // The look at 10 s set the next timer from the new interval: one second after it.
    const calls = s.backend.callsTo("scanAgents").length;
    s.clock.advance(1000);
    await s.scanner.scan();
    expect(s.backend.callsTo("scanAgents").length).toBe(calls + 1);
    s.scanner.stop();
  });

  it("does nothing, and clears the panes, when agents are off", async () => {
    const s = await setup([{ id: "p1" }], { enabled: false });
    await s.scanner.scan();
    expect(s.backend.callsTo("scanAgents")).toHaveLength(0);
    expect(s.results).toEqual([new Map()]);
  });

  it("does not ask with an empty catalog", async () => {
    const s = await setup([{ id: "p1" }], { catalog: [] });
    await s.scanner.scan();
    expect(s.backend.callsTo("scanAgents")).toHaveLength(0);
    expect(s.results).toEqual([new Map()]);
  });

  it("keeps one look in flight: a look asked for meanwhile is the same look", async () => {
    const s = await setup([{ id: "p1" }]);
    const first = s.scanner.scan();
    const second = s.scanner.scan();
    expect(second).toBe(first);
    await first;
    expect(s.backend.callsTo("scanAgents")).toHaveLength(1);
    await s.scanner.scan();
    expect(s.backend.callsTo("scanAgents")).toHaveLength(2);
  });

  it("reports a failed look and leaves the answer alone", async () => {
    const s = await setup([{ id: "p1" }]);
    const failure = new Error("catalog refused");
    s.backend.scanAgents = () => Promise.reject(failure);
    await expect(s.scanner.scan()).resolves.toBeUndefined();
    expect(s.errors).toEqual([failure]);
    expect(s.results).toEqual([]);
  });
});
