import { describe, expect, it } from "vitest";
import {
  FakeBackend,
  createDefaultWorkspace,
  createSequentialIds,
  exportSpace,
} from "@noren/model";
import type { Space } from "@noren/model";
import {
  appSpaceSyncPort,
  importNotes,
  importSpaceFiles,
  writeNotes,
  writeSpaceFiles,
} from "./space-sync";
import { createWorkspaceStore } from "./workspace-store";

// The spaces in the sync, over the real port of the window (the workspace store and the settings)
// and the in-memory backend: what is written before a push, what is made of the files after a pull,
// and that a space which went out as a file does not come back as a second space.

/** A computer: its backend, its workspace (the default space and one more for each name) and the port. */
function computer(...names: string[]) {
  const backend = new FakeBackend();
  const store = createWorkspaceStore({
    backend,
    workspace: createDefaultWorkspace(),
    newId: createSequentialIds("t"),
  });
  for (const name of names) store.getState().dispatch({ type: "space/create", name });
  const spaces = (): readonly Space[] => store.getState().workspace.spaces;
  return { backend, store, port: appSpaceSyncPort(store, backend), spaces };
}

type Computer = ReturnType<typeof computer>;

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};

const named = (machine: Computer, name: string): Space =>
  must(machine.spaces().find((space) => space.name === name));

const textOf = (space: Space): string => {
  const made = exportSpace(space);
  if (!made.ok) throw new Error(made.error);
  return made.text;
};

/** The file another computer would have pushed for a space of this name, with `tabs` tabs. */
function remoteFile(name: string, tabs = 1): string {
  const other = computer(name);
  const space = named(other, name);
  for (let n = 0; n < tabs; n++) {
    other.store.getState().dispatch({ type: "item/create", spaceId: space.id });
  }
  return textOf(named(other, name));
}

const path = (name: string): string => `spaces/${name}.noren-space.json`;

describe("writeSpaceFiles", () => {
  it("writes one file for each space and ties each to its space", async () => {
    const m = computer("Work", "Play");
    const result = await writeSpaceFiles(m.backend, m.port, { linkedOnly: false });
    expect(result.written.sort()).toEqual(
      [
        "Play.noren-space.json",
        "Work.noren-space.json",
        `${must(m.spaces()[0]).name}.noren-space.json`,
      ].sort(),
    );
    expect(result.skipped).toEqual([]);
    const folder = await m.backend.syncSpaceFiles();
    expect(folder.files).toHaveLength(3);
    for (const file of folder.files) {
      expect(file.linked?.hash).toBe(file.hash);
      expect(m.spaces().some((space) => space.id === file.linked?.spaceId)).toBe(true);
    }
    expect(m.backend.syncLocalFile(path("Work"))).toBe(textOf(named(m, "Work")));
  });

  it("writes nothing again for spaces whose file already says the same", async () => {
    const m = computer("Work");
    await writeSpaceFiles(m.backend, m.port, { linkedOnly: false });
    const again = await writeSpaceFiles(m.backend, m.port, { linkedOnly: false });
    expect(again.written).toEqual([]);
    expect(again.unchanged).toBe(2);
    expect(m.backend.callsTo("syncWriteSpaceFiles")).toHaveLength(1);
  });

  it("writes only the spaces that already have a file when asked to (before a pull)", async () => {
    const m = computer("Work", "Play");
    const none = await writeSpaceFiles(m.backend, m.port, { linkedOnly: true });
    expect(none.written).toEqual([]);
    expect(m.backend.callsTo("syncWriteSpaceFiles")).toHaveLength(0);
    // Work gets a file; then Work changes and Play is new: only Work is written again.
    await m.backend.syncWriteSpaceFiles([
      { name: "Work.noren-space.json", text: "{}", spaceId: named(m, "Work").id },
    ]);
    const some = await writeSpaceFiles(m.backend, m.port, { linkedOnly: true });
    expect(some.written).toEqual(["Work.noren-space.json"]);
    expect(m.backend.syncLocalFile(path("Play"))).toBeUndefined();
  });
});

describe("importSpaceFiles", () => {
  it("does not bring back the spaces this computer wrote (a pull after a push)", async () => {
    const m = computer("Work", "Play");
    await writeSpaceFiles(m.backend, m.port, { linkedOnly: false });
    const before = m.spaces().map((space) => space.id);
    const result = await importSpaceFiles(m.backend, m.port);
    expect(result.added).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(m.spaces().map((space) => space.id)).toEqual(before);
  });

  it("makes a new space of a file from the remote, once, and shows nothing", async () => {
    const m = computer("Work");
    m.backend.setSyncLocalFile(path("Came"), remoteFile("Came"));
    const shown = m.store.getState().workspace.activeSpaceId;
    const first = await importSpaceFiles(m.backend, m.port);
    expect(first.added).toEqual([{ file: "Came.noren-space.json", name: "Came" }]);
    expect(m.spaces().map((space) => space.name)).toContain("Came");
    expect(m.store.getState().workspace.activeSpaceId).toBe(shown);
    const count = m.spaces().length;
    // A second pull sees the same bytes it already made a space of: nothing new.
    const second = await importSpaceFiles(m.backend, m.port);
    expect(second.added).toEqual([]);
    expect(second.replaced).toEqual([]);
    expect(m.spaces()).toHaveLength(count);
    // Neither does a push in between change that.
    await writeSpaceFiles(m.backend, m.port, { linkedOnly: false });
    expect((await importSpaceFiles(m.backend, m.port)).added).toEqual([]);
    expect(m.spaces()).toHaveLength(count);
  });

  it("ties the new space to its file, so the next push writes to the same file", async () => {
    const m = computer();
    m.backend.setSyncLocalFile(path("Came"), remoteFile("Came"));
    await importSpaceFiles(m.backend, m.port);
    const folder = await m.backend.syncSpaceFiles();
    const came = must(folder.files.find((file) => file.name === "Came.noren-space.json"));
    expect(came.linked?.spaceId).toBe(named(m, "Came").id);
    await writeSpaceFiles(m.backend, m.port, { linkedOnly: false });
    expect(Object.keys(m.backend.syncRemoteFiles())).toEqual([]);
    const names = (await m.backend.syncSpaceFiles()).files.map((file) => file.name);
    expect(names).toEqual(
      ["Came.noren-space.json", `${must(m.spaces()[0]).name}.noren-space.json`].sort(),
    );
  });

  it("makes the space again, in its place and with its id, when its file changed", async () => {
    const m = computer("Work", "Play");
    m.backend.setSyncLocalFile(path("Came"), remoteFile("Came"));
    await importSpaceFiles(m.backend, m.port);
    m.store.getState().dispatch({ type: "space/create", name: "After" });
    const order = m.spaces().map((space) => space.name);
    const id = named(m, "Came").id;
    const index = order.indexOf("Came");

    m.backend.setSyncLocalFile(path("Came"), remoteFile("Came", 3));
    const result = await importSpaceFiles(m.backend, m.port);
    expect(result.replaced).toEqual([{ file: "Came.noren-space.json", name: "Came" }]);
    expect(result.added).toEqual([]);
    expect(m.spaces().map((space) => space.name)).toEqual(order);
    expect(m.spaces()[index]?.id).toBe(id);
    expect(Object.keys(must(m.spaces()[index]).items)).toHaveLength(3);
    // The old tab went to the closed ones, and the next pull has nothing more to do.
    expect(m.store.getState().workspace.closed.length).toBeGreaterThan(0);
    const again = await importSpaceFiles(m.backend, m.port);
    expect(again.replaced).toEqual([]);
    expect(again.added).toEqual([]);
  });

  it("does not close the tabs of a space because the other computer only looked at another tab", async () => {
    const m = computer();
    const base = computer("Came");
    const space = named(base, "Came");
    base.store.getState().dispatch({ type: "item/create", spaceId: space.id });
    base.store.getState().dispatch({ type: "item/create", spaceId: space.id });
    const first = textOf(named(base, "Came"));
    const firstItem = must(Object.keys(named(base, "Came").items)[0]);
    base.store
      .getState()
      .dispatch({ type: "space/set-active-item", spaceId: space.id, itemId: firstItem });
    const looking = textOf(named(base, "Came"));
    expect(looking).not.toBe(first);

    m.backend.setSyncLocalFile(path("Came"), first);
    await importSpaceFiles(m.backend, m.port);
    const held = named(m, "Came");
    m.backend.setSyncLocalFile(path("Came"), looking);
    const result = await importSpaceFiles(m.backend, m.port);
    expect(result.replaced).toEqual([]);
    expect(result.added).toEqual([]);
    expect(named(m, "Came")).toBe(held);
    // The record follows the new bytes, so the file is not looked at again.
    const folder = await m.backend.syncSpaceFiles();
    const file = must(folder.files.find((entry) => entry.name === "Came.noren-space.json"));
    expect(file.linked?.hash).toBe(file.hash);
  });

  it("leaves out a file that is not a space file, says why, and still makes the others", async () => {
    const m = computer();
    m.backend.setSyncLocalFile(path("Broken"), "{ not json");
    m.backend.setSyncLocalFile(path("Came"), remoteFile("Came"));
    const result = await importSpaceFiles(m.backend, m.port);
    expect(result.added.map((added) => added.name)).toEqual(["Came"]);
    expect(result.ignored).toEqual([
      { file: "Broken.noren-space.json", reason: "it is not valid JSON" },
    ]);
    // The broken file is looked at again by the next pull, and Came is not made twice.
    const count = m.spaces().length;
    const again = await importSpaceFiles(m.backend, m.port);
    expect(again.added).toEqual([]);
    expect(again.ignored).toHaveLength(1);
    expect(m.spaces()).toHaveLength(count);
  });

  it("brings back a space whose file changed after the space was removed here", async () => {
    const m = computer();
    m.backend.setSyncLocalFile(path("Came"), remoteFile("Came"));
    await importSpaceFiles(m.backend, m.port);
    const came = named(m, "Came");
    m.store
      .getState()
      .dispatch({ type: "space/delete", spaceId: came.id, items: { mode: "close" } });
    expect(m.spaces().some((space) => space.name === "Came")).toBe(false);
    // Unchanged file: it stays removed, as removals do not travel.
    expect((await importSpaceFiles(m.backend, m.port)).added).toEqual([]);
    // Changed on another computer: the space comes back.
    m.backend.setSyncLocalFile(path("Came"), remoteFile("Came", 2));
    const result = await importSpaceFiles(m.backend, m.port);
    expect(result.added).toEqual([{ file: "Came.noren-space.json", name: "Came" }]);
    expect(named(m, "Came").id).not.toBe(came.id);
  });

  it("rejects with the words of the backend when the files cannot be listed", async () => {
    const m = computer();
    m.backend.setSyncFailure(new Error("the sync folder is damaged"));
    await expect(importSpaceFiles(m.backend, m.port)).rejects.toThrow("the sync folder is damaged");
    await expect(writeSpaceFiles(m.backend, m.port, { linkedOnly: false })).rejects.toThrow(
      "the sync folder is damaged",
    );
  });
});

describe("what is said", () => {
  it("names the spaces added, the ones made again and the files left out", () => {
    const empty = { added: [], replaced: [], relinked: 0, ignored: [], failed: [], notes: [] };
    expect(importNotes(empty)).toEqual({ notes: [], changed: false });
    expect(
      importNotes({ ...empty, added: [{ file: "Work.noren-space.json", name: "Work" }] }),
    ).toEqual({ notes: ['Added the space "Work" from the remote.'], changed: true });
    const many = importNotes({
      ...empty,
      added: [
        { file: "A.noren-space.json", name: "A" },
        { file: "B.noren-space.json", name: "B" },
        { file: "C.noren-space.json", name: "C" },
      ],
      replaced: [{ file: "D.noren-space.json", name: "D" }],
      ignored: [{ file: "E.noren-space.json", reason: "it is not valid JSON" }],
      failed: [{ file: "F.noren-space.json", reason: "profiles could not be saved" }],
      notes: ["Imported space with a note."],
    });
    expect(many.changed).toBe(true);
    expect(many.notes).toEqual([
      'Added 3 spaces from the remote: "A", "B" and "C".',
      'Updated the space "D" from the remote; the tabs it had are in the closed tabs.',
      "Skipped spaces/E.noren-space.json: it is not valid JSON.",
      "Could not make a space from spaces/F.noren-space.json: profiles could not be saved",
      "Imported space with a note.",
    ]);
    expect(importNotes({ ...empty, relinked: 2 })).toEqual({ notes: [], changed: false });
  });

  it("names what a write left out because it looked like a secret", () => {
    const result = {
      written: [],
      unchanged: 0,
      skipped: [],
      leftOut: [{ name: "Work", removed: { env: ["API_TOKEN"], commands: [], profiles: [] } }],
    };
    expect(writeNotes(result)).toEqual([
      'Left out of the space files because they looked like secrets: "Work": variables API_TOKEN.',
    ]);
    expect(writeNotes({ ...result, leftOut: [] })).toEqual([]);
    expect(
      writeNotes({
        ...result,
        leftOut: [],
        skipped: [{ spaceId: "s", name: "Work", reason: "a page address holds a secret" }],
      }),
    ).toEqual(['Not written as a file: "Work" (a page address holds a secret).']);
  });
});
