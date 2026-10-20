import { FakeBackend, agentSettingsOf, restoreWorkspace, serializeWorkspace } from "@noren/model";
import type { AgentCatalog, Pane, Workspace } from "@noren/model";
import { layoutPanes } from "@noren/model";
import { describe, expect, it } from "vitest";
import { armAgentResumes } from "./resume-restore";
import { ResumeService } from "./resume-service";

// The fake restart of NOR-F14-03: a state saved with agents running in some panes, a backend with
// nothing to hand back, and the check that the right panes are armed with the right command, in the
// session each one got.

const CATALOG: AgentCatalog = [
  { id: "alpha", executables: ["alpha"], resume: "alpha --resume" },
  { id: "gamma", executables: ["gamma"] },
];

const PROFILES = [{ id: "bash", name: "Bash", default: true }];

function pane(id: string, cwd: string, command?: string): Pane {
  return {
    id,
    type: "terminal",
    profileId: "bash",
    cwd,
    status: "running",
    unread: false,
    bell: false,
    ...(command !== undefined ? { runningCommand: { text: command } } : {}),
  };
}

function workspaceOf(panes: Pane[]): Workspace {
  const layout = panes
    .map((p) => ({ kind: "pane" as const, pane: p }))
    .reduce<Workspace["spaces"][number]["items"][string]["layout"] | undefined>(
      (left, right) =>
        left === undefined
          ? right
          : { kind: "split", dir: "row", sizes: [50, 50], children: [left, right] },
      undefined,
    );
  if (layout === undefined) throw new Error("no panes");
  return {
    version: 2,
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
    spaces: [
      {
        id: "s1",
        name: "Main",
        icon: "terminal",
        color: "#6b8afd",
        modIds: [],
        defaults: { env: {} },
        aiEnabled: true,
        saveScrollback: true,
        pinned: [],
        tree: [{ kind: "item", id: "i1" }],
        items: {
          i1: {
            id: "i1",
            title: "work",
            titleLocked: true,
            layout,
            focusedPaneId: panes[0]?.id ?? "",
            lastActivityAt: 1,
          },
        },
        activeItemId: "i1",
      },
    ],
  } as unknown as Workspace;
}

async function restart(
  panes: Pane[],
  option: boolean,
  options: { keep?: string[]; enabled?: boolean } = {},
) {
  const backend = new FakeBackend({
    profiles: PROFILES,
    state: serializeWorkspace(workspaceOf(panes)),
  });
  for (const paneId of options.keep ?? []) {
    backend.holdSessionForPane(paneId, await backend.createSession({ cols: 80, rows: 24 }));
  }
  const restored = await restoreWorkspace(backend);
  const service = new ResumeService();
  const armed = armAgentResumes({
    restored,
    settings: {
      ...agentSettingsOf({ enabled: options.enabled ?? true, resumeOnRestore: option }),
      catalog: CATALOG,
    },
    backend,
    service,
  });
  return { backend, restored, service, armed };
}

const sessionOf = (restored: { workspace: Workspace }, paneId: string): number => {
  for (const item of Object.values(restored.workspace.spaces[0]?.items ?? {})) {
    for (const found of layoutPanes(item.layout)) {
      if (found.id === paneId && found.sessionId !== undefined) return Number(found.sessionId);
    }
  }
  throw new Error(`no session for ${paneId}`);
};

const PROMPT = new TextEncoder().encode("\x1b]133;A\x07$ ");

describe("armAgentResumes after a restart", () => {
  const panes = () => [
    pane("p1", "/work/a", "alpha --verbose"),
    pane("p2", "/work/b", "gamma"),
    pane("p3", "/work/c"),
  ];

  it("with the option on, types the resume command in the new shell of the agent's pane, once, at the prompt", async () => {
    const { backend, restored, service, armed } = await restart(panes(), true);
    expect(armed).toEqual([{ paneId: "p1", agentId: "alpha", text: "alpha --resume" }]);
    expect(service.waiting()).toEqual(["p1"]);

    // The new shell is in the folder that was saved, and nothing was typed yet.
    expect(backend.session(sessionOf(restored, "p1"))?.cwd).toBe("/work/a");
    expect(backend.callsTo("write")).toEqual([]);

    service.feed("p1", PROMPT);
    service.feed("p1", PROMPT);
    const writes = backend.callsTo("write");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toEqual([sessionOf(restored, "p1"), "alpha --resume\r"]);
  });

  it("with the option off, arms nothing and types nothing", async () => {
    const { backend, service, armed } = await restart(panes(), false);
    expect(armed).toEqual([]);
    expect(service.waiting()).toEqual([]);
    service.feed("p1", PROMPT);
    expect(backend.callsTo("write")).toEqual([]);
  });

  it("with the agents off, arms nothing", async () => {
    const { armed } = await restart(panes(), true, { enabled: false });
    expect(armed).toEqual([]);
  });

  it("does not arm the pane that got its old shell back", async () => {
    const { backend, service, armed } = await restart(panes(), true, { keep: ["p1"] });
    expect(armed).toEqual([]);
    service.feed("p1", PROMPT);
    expect(backend.callsTo("write")).toEqual([]);
  });

  it("does not arm an agent with no resume command, or a pane with no agent", async () => {
    const { armed } = await restart([pane("p2", "/work/b", "gamma"), pane("p3", "/work/c")], true);
    expect(armed).toEqual([]);
  });
});
