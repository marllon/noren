/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";
import { restoreWorkspace } from "./restore";
import { layoutPanes } from "./sessions";
import { parseState } from "./state";

// `scripts/smoke-persist-state.json` is the saved workspace that `pnpm smoke` puts in the folder of
// the persistence run (`noren --smoke-persist`), so the interface of each of its two runs restores a
// pane of its own. The Rust side looks for that pane by id (`PAGE_PANE` in `smoke_persist.rs`, which
// has a test that reads the same file); this keeps the file one the app accepts.

const FIXTURE = new URL("../../../scripts/smoke-persist-state.json", import.meta.url);
const PAGE_PANE = "smoke-persist-page-pane";

describe("scripts/smoke-persist-state.json", () => {
  const text = readFileSync(FIXTURE, "utf8");

  it("is a saved state the app accepts, with the one pane the persistence run looks for", () => {
    const parsed = parseState(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const panes = parsed.workspace.spaces.flatMap((space) =>
      Object.values(space.items).flatMap((item) => layoutPanes(item.layout)),
    );
    expect(panes.map((pane) => pane.id)).toEqual([PAGE_PANE]);
    expect(panes[0]?.sessionId).toBeUndefined();
  });

  it("is restored without a quarantine: the pane asks for its old shell, then names itself for a new one", async () => {
    const backend = new FakeBackend({
      profiles: [{ id: "bash", name: "Bash", default: true }],
      state: text,
    });
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("saved");
    expect(backend.quarantineCount).toBe(0);
    expect(backend.callsTo("reattachSession").map((call) => call.args[0])).toEqual([PAGE_PANE]);
    expect(backend.callsTo("createSession").map((call) => call.args[0])).toMatchObject([
      { paneId: PAGE_PANE },
    ]);
  });
});
