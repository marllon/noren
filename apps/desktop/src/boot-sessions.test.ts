import { describe, expect, it } from "vitest";
import {
  ConfigManager,
  FakeBackend,
  createDefaultWorkspace,
  layoutPanes,
  serializeWorkspace,
} from "@noren/model";
import type { Id, Workspace } from "@noren/model";
import { restoreKeepingSessions, withoutReattachedSnapshots } from "./boot-sessions";

// The start of the app tells the backend whether shells outlive the app before it restores any shell,
// so a pane can get its old shell back, and a pane that did needs no copy of its old scrollback.

const BASH = [{ id: "bash", name: "Bash", default: true }];

const onlyPane = (ws: Workspace) => {
  const item = Object.values(ws.spaces[0]?.items ?? {})[0];
  const pane = item === undefined ? undefined : layoutPanes(item.layout)[0];
  if (pane === undefined) throw new Error("the workspace has no pane");
  return pane;
};

async function started(config: string | null, state?: string) {
  const fake = new FakeBackend({
    profiles: BASH,
    config,
    ...(state !== undefined ? { state } : {}),
  });
  const manager = new ConfigManager();
  await manager.start(fake);
  return { fake, manager };
}

describe("restoring with the shells the daemon kept", () => {
  it("hands the setting over before the first pane asks for its shell", async () => {
    const { fake, manager } = await started(null);
    await restoreKeepingSessions(fake, manager);

    const order = fake.calls
      .map((call) => call.method)
      .filter((method) => ["setKeepSessions", "reattachSession", "createSession"].includes(method));
    expect(order).toEqual(["setKeepSessions", "reattachSession", "createSession"]);
    expect(fake.keepSessions).toBe(true);
  });

  it("hands over false when the file turns it off, still before the restore", async () => {
    const { fake, manager } = await started('{ "sessions": { "keepOnClose": false } }');
    await restoreKeepingSessions(fake, manager);

    const methods = fake.calls.map((call) => call.method);
    expect(methods.indexOf("setKeepSessions")).toBeLessThan(methods.indexOf("reattachSession"));
    expect(fake.callsTo("setKeepSessions").map((call) => call.args[0])).toEqual([false]);
    expect(fake.keepSessions).toBe(false);
  });

  it("follows the setting after the restore: a change of the file reaches the backend", async () => {
    const { fake, manager } = await started(null);
    const { follow } = await restoreKeepingSessions(fake, manager);

    fake.setConfig('{ "sessions": { "keepOnClose": false } }');
    await follow.settled();
    expect(fake.keepSessions).toBe(false);
  });

  it("gives a pane the shell the daemon kept for it and reports it", async () => {
    const saved = createDefaultWorkspace();
    const pane = onlyPane(saved);
    const { fake, manager } = await started(null, serializeWorkspace(saved));
    // The app was closed with the setting on and opened again: the daemon kept the shell of the pane.
    const kept = await fake.createSession({ cols: 80, rows: 24 });
    fake.holdSessionForPane(pane.id, kept);

    const { restored } = await restoreKeepingSessions(fake, manager);

    expect(restored.reattachedPaneIds).toEqual([pane.id]);
    expect(onlyPane(restored.workspace).sessionId).toBe(String(kept));
    // Nothing new was started for it.
    expect(fake.callsTo("createSession")).toHaveLength(1);
  });
});

describe("the saved scrollback of a pane that got its shell back", () => {
  it("is dropped, and the others stay", () => {
    const texts = new Map<Id, string>([
      ["p1", "old lines 1"],
      ["p2", "old lines 2"],
    ]);
    withoutReattachedSnapshots(texts, ["p2"]);
    expect([...texts.keys()]).toEqual(["p1"]);
  });

  it("does nothing when there is nothing saved or nothing came back", () => {
    expect(() => withoutReattachedSnapshots(undefined, ["p1"])).not.toThrow();
    const texts = new Map<Id, string>([["p1", "x"]]);
    withoutReattachedSnapshots(texts, []);
    expect([...texts.keys()]).toEqual(["p1"]);
    withoutReattachedSnapshots(texts, ["nope"]);
    expect([...texts.keys()]).toEqual(["p1"]);
  });
});
