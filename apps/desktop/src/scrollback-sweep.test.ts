import { describe, expect, it } from "vitest";
import { FakeBackend } from "@noren/model";
import type { Item, Workspace } from "@noren/model";
import { fixturePane, fixtureSpace, fixtureTab } from "./closed-fixtures";
import { sweepOrphanScrollback } from "./scrollback-service";
import { createWorkspaceStore } from "./workspace-store";

// The sweep at the start: the files of `scrollback/` that no pane of the workspace claims go, and
// only those.

const tab = (itemId: string, paneId: string): Item =>
  fixtureTab(itemId, fixturePane(paneId, { ref: true }));

function setup(parts: { open?: Item[]; closed?: Item[]; archived?: Item[] } = {}) {
  const backend = new FakeBackend();
  const workspace: Workspace = {
    version: 2,
    spaces: [fixtureSpace("s1", parts.open ?? [tab("i-open", "open-pane")])],
    activeSpaceId: "s1",
    favorites: [],
    closed: (parts.closed ?? []).map((item) => ({ item, spaceId: "s1", closedAt: 1 })),
    archive: (parts.archived ?? []).map((item) => ({ item, spaceId: "s1", archivedAt: 1 })),
  };
  return { backend, store: createWorkspaceStore({ backend, workspace }) };
}

describe("sweepOrphanScrollback", () => {
  it("removes the files no pane claims and keeps the ones of open, closed and archived panes", async () => {
    const { backend, store } = setup({
      closed: [tab("i-closed", "closed-pane")],
      archived: [tab("i-archived", "archived-pane")],
    });
    for (const id of ["open-pane", "closed-pane", "archived-pane", "orphan-1", "orphan-2"]) {
      backend.setScrollback(id, `text of ${id}`);
    }
    const removed = await sweepOrphanScrollback(store, backend);
    expect(removed.sort()).toEqual(["orphan-1", "orphan-2"]);
    expect(Object.keys(backend.scrollbackFiles).sort()).toEqual([
      "archived-pane",
      "closed-pane",
      "open-pane",
    ]);
    expect(
      backend
        .callsTo("deleteScrollback")
        .map((call) => call.args[0])
        .sort(),
    ).toEqual(["orphan-1", "orphan-2"]);
  });

  it("with no files it lists and deletes nothing", async () => {
    const { backend, store } = setup();
    expect(await sweepOrphanScrollback(store, backend)).toEqual([]);
    expect(backend.callsTo("listScrollback")).toHaveLength(1);
    expect(backend.callsTo("deleteScrollback")).toEqual([]);
  });

  it("with a file for every pane, nothing is removed", async () => {
    const { backend, store } = setup({ closed: [tab("i-closed", "closed-pane")] });
    backend.setScrollback("open-pane", "a");
    backend.setScrollback("closed-pane", "b");
    expect(await sweepOrphanScrollback(store, backend)).toEqual([]);
    expect(backend.callsTo("deleteScrollback")).toEqual([]);
  });

  it("a pane that joins the workspace while the folder is being listed is not taken for an orphan", async () => {
    const { backend, store } = setup();
    backend.setScrollback("late-pane", "just written");
    backend.setScrollback("orphan", "old");
    const list = backend.listScrollback.bind(backend);
    backend.listScrollback = async () => {
      const ids = await list();
      // The workspace changes after the list is read; the answer is read from it only after that.
      const current = store.getState().workspace;
      store.setState({
        workspace: {
          ...current,
          closed: [
            ...current.closed,
            { item: tab("i-late", "late-pane"), spaceId: "s1", closedAt: 2 },
          ],
        },
      });
      return ids;
    };
    expect(await sweepOrphanScrollback(store, backend)).toEqual(["orphan"]);
    expect(Object.keys(backend.scrollbackFiles).sort()).toEqual(["late-pane"]);
  });

  it("reports a file it cannot remove and still removes the others", async () => {
    const { backend, store } = setup();
    backend.setScrollback("orphan-1", "x");
    backend.setScrollback("orphan-2", "y");
    const errors: unknown[] = [];
    const remove = backend.deleteScrollback.bind(backend);
    backend.deleteScrollback = async (paneId) => {
      if (paneId === "orphan-1") throw new Error("locked");
      return remove(paneId);
    };
    const removed = await sweepOrphanScrollback(store, backend, (error) => errors.push(error));
    expect(removed).toEqual(["orphan-2"]);
    expect(errors).toHaveLength(1);
    expect(backend.scrollbackFiles).toEqual({ "orphan-1": "x" });
  });

  it("removes nothing when the folder cannot be listed, and says so", async () => {
    const { backend, store } = setup();
    backend.setScrollback("orphan", "x");
    backend.listScrollback = async () => {
      throw new Error("no access");
    };
    const errors: unknown[] = [];
    expect(await sweepOrphanScrollback(store, backend, (e) => errors.push(e))).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(backend.scrollbackFiles).toEqual({ orphan: "x" });
  });
});
