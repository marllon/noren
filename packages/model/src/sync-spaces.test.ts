import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import { createDefaultWorkspace } from "./default-workspace";
import { checkInvariants } from "./invariants";
import { reduceStrict } from "./reducer";
import {
  SPACE_FILE_EXTENSION,
  exportFileName,
  exportSpace,
  parseSpaceFile,
  type SpaceFile,
} from "./space-file";
import { SYNC_LIMITS, isSyncSpaceFileName } from "./sync";
import type { SyncSpaceFile, SyncSpaceFolder } from "./sync";
import { planSpacePull, planSpacePush, spaceFileSignature, spacesToRead } from "./sync-spaces";
import { deepFreeze, testContext } from "./test-helpers";
import type { Space, Workspace } from "./types";

// The pure side of the spaces in the sync (NOR-F19-01c): the name each space gets as a file, which
// spaces a push has to write, what a pull does with each file in the folder (new, changed, the same,
// not a space file), and `space/reimport`, the action that makes a space again from a changed file.

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const folderOf = (files: SyncSpaceFile[], cloned: string[] = []): SyncSpaceFolder => ({
  files,
  cloned,
});
const entry = (name: string, linkedTo: string | null, hash = HASH_A, linkedHash = hash) => ({
  name,
  hash,
  linked: linkedTo === null ? null : { spaceId: linkedTo, hash: linkedHash },
});

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};

/** A workspace of the default space and one space for each name, each with its own first tab. */
function workspaceWith(...names: string[]): Workspace {
  const { ctx } = testContext();
  let ws = createDefaultWorkspace();
  for (const name of names) {
    ws = reduceStrict(ws, { type: "space/create", name, activate: false }, ctx);
  }
  return ws;
}

const spaceNamed = (ws: Workspace, name: string): Space =>
  must(ws.spaces.find((space) => space.name === name));

const fileOfSpace = (space: Space): SpaceFile => {
  const made = exportSpace(space);
  if (!made.ok) throw new Error(made.error);
  return made.file;
};
const textOfSpace = (space: Space): string => {
  const made = exportSpace(space);
  if (!made.ok) throw new Error(made.error);
  return made.text;
};

describe("exportFileName and the sync", () => {
  it("never gives a name the sync would skip", () => {
    for (const name of [
      ".hidden",
      "..",
      "con",
      "con.fig",
      "CON",
      "aux.txt",
      "Work.",
      " Work ",
      "a/b",
      "a\\b",
      "tab\tname",
      "bell\u007f",
      "c1\u0085control",
      "",
      "x".repeat(300),
      "emoji 🙂 space",
    ]) {
      const fileName = exportFileName(name);
      expect(isSyncSpaceFileName(fileName), `${JSON.stringify(name)} -> ${fileName}`).toBe(true);
    }
  });

  it("is a name the sync carries for any name at all (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (name) => {
        const fileName = exportFileName(name);
        expect(fileName.endsWith(SPACE_FILE_EXTENSION)).toBe(true);
        expect(isSyncSpaceFileName(fileName)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("keeps the names people give spaces", () => {
    expect(exportFileName("Work")).toBe("Work.noren-space.json");
    expect(exportFileName("Client work 2")).toBe("Client work 2.noren-space.json");
    expect(exportFileName(".hidden")).toBe("hidden.noren-space.json");
    expect(exportFileName("con.fig")).toBe("space.noren-space.json");
  });
});

describe("spaceFileSignature", () => {
  it("ignores where you were looking and sees everything else", () => {
    const ws = workspaceWith("Work");
    const work = spaceNamed(ws, "Work");
    const { ctx } = testContext();
    let next = reduceStrict(ws, { type: "item/create", spaceId: work.id }, ctx);
    next = reduceStrict(next, { type: "item/create", spaceId: work.id }, ctx);
    const space = spaceNamed(next, "Work");
    const ids = Object.keys(space.items);
    expect(ids.length).toBeGreaterThan(1);
    const file = fileOfSpace(space);
    const looking = JSON.parse(JSON.stringify(file)) as Record<string, unknown> & {
      space: { activeItemId?: string; items: { focusedPaneId: string }[] };
    };
    looking.space.activeItemId = file.space.items[0]?.id ?? "";
    looking.space.items = looking.space.items.map((item) => ({ ...item, focusedPaneId: "p1" }));
    expect(JSON.stringify(looking)).not.toBe(JSON.stringify(file));
    expect(spaceFileSignature(looking as unknown as SpaceFile)).toBe(spaceFileSignature(file));
    expect(spaceFileSignature({ ...file, space: { ...file.space, name: "Other" } })).not.toBe(
      spaceFileSignature(file),
    );
    expect(
      spaceFileSignature({ ...file, space: { ...file.space, items: file.space.items.slice(1) } }),
    ).not.toBe(spaceFileSignature(file));
  });
});

describe("planSpacePush", () => {
  it("makes one file for each space, named after it, in the order of the spaces", () => {
    const ws = workspaceWith("Work", "Play");
    const plan = planSpacePush(ws.spaces, folderOf([]));
    const names = plan.writes.map((write) => write.name);
    expect(names).toEqual([
      exportFileName(must(ws.spaces[0]).name),
      "Work.noren-space.json",
      "Play.noren-space.json",
    ]);
    expect(plan.writes.map((write) => write.spaceId)).toEqual(ws.spaces.map((space) => space.id));
    for (const write of plan.writes) {
      expect(parseSpaceFile(write.text).ok).toBe(true);
    }
    expect(plan.skipped).toEqual([]);
    expect(plan.unchanged).toBe(0);
  });

  it("tells two spaces of the same name apart, with or without case", () => {
    const ws = workspaceWith("Work", "work", "Work");
    const plan = planSpacePush(
      ws.spaces.filter((space) => space.name.toLowerCase() === "work"),
      folderOf([]),
    );
    expect(plan.writes.map((write) => write.name)).toEqual([
      "Work.noren-space.json",
      "work-2.noren-space.json",
      "Work-3.noren-space.json",
    ]);
    expect(new Set(plan.writes.map((write) => write.name.toLowerCase())).size).toBe(3);
  });

  it("does not take a name that is in the folder or in the clone", () => {
    const ws = workspaceWith("Work", "Play");
    const plan = planSpacePush(
      ws.spaces.slice(1),
      folderOf([entry("Work.noren-space.json", null)], ["play.noren-space.json"]),
    );
    expect(plan.writes.map((write) => write.name)).toEqual([
      "Work-2.noren-space.json",
      "Play-2.noren-space.json",
    ]);
  });

  it("keeps the name of a space that has a file, even after the space is renamed", () => {
    const ws = workspaceWith("Work");
    const work = spaceNamed(ws, "Work");
    const renamed = reduceStrict(
      ws,
      { type: "space/rename", spaceId: work.id, name: "Day job" },
      testContext().ctx,
    );
    const plan = planSpacePush(
      [spaceNamed(renamed, "Day job")],
      folderOf([entry("Work.noren-space.json", work.id)]),
    );
    expect(plan.writes.map((write) => write.name)).toEqual(["Work.noren-space.json"]);
    expect(plan.writes[0]?.text).toContain('"name": "Day job"');
    // A new space named like the old file takes the next name: that file is the old space's.
    const other = planSpacePush(
      [spaceNamed(workspaceWith("Work"), "Work")],
      folderOf([entry("Work.noren-space.json", "gone-space")]),
    );
    expect(other.writes.map((write) => write.name)).toEqual(["Work-2.noren-space.json"]);
  });

  it("plans only the spaces that have a file when asked to", () => {
    const ws = workspaceWith("Work", "Play");
    const play = spaceNamed(ws, "Play");
    const plan = planSpacePush(ws.spaces, folderOf([entry("Play.noren-space.json", play.id)]), {
      linkedOnly: true,
    });
    expect(plan.writes.map((write) => write.spaceId)).toEqual([play.id]);
  });

  it("leaves a space alone whose file says the same, apart from where you were looking", () => {
    const ws = workspaceWith("Work");
    const work = spaceNamed(ws, "Work");
    const held = new Map([["Work.noren-space.json", textOfSpace(work)]]);
    const folder = folderOf([entry("Work.noren-space.json", work.id)]);
    expect(planSpacePush([work], folder, { held }).unchanged).toBe(1);
    expect(planSpacePush([work], folder, { held }).writes).toEqual([]);

    // Another tab shown: still the same space.
    const { ctx } = testContext();
    const more = reduceStrict(ws, { type: "item/create", spaceId: work.id }, ctx);
    const first = must(
      spaceNamed(more, "Work").items[must(Object.keys(spaceNamed(more, "Work").items)[0])],
    );
    const looking = reduceStrict(
      more,
      { type: "space/set-active-item", spaceId: work.id, itemId: first.id },
      ctx,
    );
    const heldBefore = new Map([["Work.noren-space.json", textOfSpace(spaceNamed(more, "Work"))]]);
    const sameSpace = planSpacePush([spaceNamed(looking, "Work")], folder, { held: heldBefore });
    expect(sameSpace.writes).toEqual([]);

    // A new tab, a new name, or no text to compare: the file is written.
    const changed = reduceStrict(looking, { type: "item/create", spaceId: work.id }, ctx);
    expect(
      planSpacePush([spaceNamed(changed, "Work")], folder, { held: heldBefore }).writes,
    ).toHaveLength(1);
    expect(planSpacePush([work], folder).writes).toHaveLength(1);
    expect(
      planSpacePush([work], folder, { held: new Map([["Work.noren-space.json", "not a space"]]) })
        .writes,
    ).toHaveLength(1);
  });

  it("skips a space it cannot export and writes the others, saying why", () => {
    const ws = workspaceWith("Work", "Leaky");
    const leaky = spaceNamed(ws, "Leaky");
    const token = "gh" + "p_" + "a1B2".repeat(9);
    const withPage = reduceStrict(
      ws,
      { type: "item/create", spaceId: leaky.id },
      testContext().ctx,
    );
    const itemId = must(Object.keys(spaceNamed(withPage, "Leaky").items)[0]);
    const poisoned: Space = {
      ...spaceNamed(withPage, "Leaky"),
      items: {
        [itemId]: {
          ...must(spaceNamed(withPage, "Leaky").items[itemId]),
          layout: {
            kind: "pane",
            pane: {
              id: "page",
              type: "browser",
              profileId: "none",
              url: `https://example.com/?token=${token}`,
              status: "idle",
              unread: false,
              bell: false,
            },
          },
          focusedPaneId: "page",
        },
      },
    };
    const plan = planSpacePush([spaceNamed(ws, "Work"), poisoned], folderOf([]));
    expect(plan.writes.map((write) => write.name)).toEqual(["Work.noren-space.json"]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.name).toBe("Leaky");
    expect(plan.skipped[0]?.reason).toContain("secret");
    expect(JSON.stringify(plan)).not.toContain(token);
  });

  it("says what a file leaves out because it looked like a secret", () => {
    const ws = workspaceWith("Work");
    const work = spaceNamed(ws, "Work");
    const withSecret = reduceStrict(
      ws,
      { type: "space/set-defaults", spaceId: work.id, env: { API_TOKEN: "x", EDITOR: "vim" } },
      testContext().ctx,
    );
    const plan = planSpacePush([spaceNamed(withSecret, "Work")], folderOf([]));
    expect(plan.leftOut).toEqual([
      { name: "Work", removed: { env: ["API_TOKEN"], commands: [], profiles: [] } },
    ]);
    expect(plan.writes[0]?.text).not.toContain("API_TOKEN");
    expect(plan.writes[0]?.text).toContain("EDITOR");
  });

  it("never writes a name the sync would refuse, for any name of a space (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "binary", maxLength: 40 }), { maxLength: 6 }),
        (names) => {
          const spaces = names
            .map((name) => name.trim())
            .filter((name) => name !== "" && !name.includes("\u0000"))
            .map((name, index): Space => ({
              ...must(createDefaultWorkspace().spaces[0]),
              id: `s-${index}`,
              name,
            }));
          const plan = planSpacePush(spaces, folderOf([]));
          const seen = new Set<string>();
          for (const write of plan.writes) {
            expect(isSyncSpaceFileName(write.name), write.name).toBe(true);
            expect(seen.has(write.name.toLowerCase()), write.name).toBe(false);
            seen.add(write.name.toLowerCase());
          }
          expect(plan.writes.length + plan.skipped.length).toBe(spaces.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("planSpacePull", () => {
  const ws = workspaceWith("Work");
  const work = spaceNamed(ws, "Work");
  const cameText = textOfSpace(spaceNamed(workspaceWith("Came"), "Came"));

  it("makes a new space of a file the record does not know", () => {
    const files = [entry("Came.noren-space.json", null, HASH_A)];
    expect(spacesToRead(files).map((file) => file.name)).toEqual(["Came.noren-space.json"]);
    const plan = planSpacePull(files, new Map([["Came.noren-space.json", cameText]]), ws.spaces);
    expect(plan.add.map((added) => added.name)).toEqual(["Came.noren-space.json"]);
    expect(plan.add[0]?.file.space.name).toBe("Came");
    expect(plan.replace).toEqual([]);
    expect(plan.ignored).toEqual([]);
  });

  it("does nothing, and does not read, a file the record knows with the same bytes", () => {
    const files = [entry("Work.noren-space.json", work.id, HASH_A, HASH_A)];
    expect(spacesToRead(files)).toEqual([]);
    const plan = planSpacePull(files, new Map(), ws.spaces);
    expect(plan).toEqual({ add: [], replace: [], relink: [], ignored: [], unchanged: 1 });
  });

  it("makes the linked space again from a file that changed", () => {
    const files = [entry("Work.noren-space.json", work.id, HASH_B, HASH_A)];
    expect(spacesToRead(files)).toHaveLength(1);
    const plan = planSpacePull(files, new Map([["Work.noren-space.json", cameText]]), ws.spaces);
    expect(plan.replace).toHaveLength(1);
    expect(plan.replace[0]).toMatchObject({ name: "Work.noren-space.json", spaceId: work.id });
    expect(plan.add).toEqual([]);
  });

  it("only renews the record when the changed file says what the space says", () => {
    const files = [entry("Work.noren-space.json", work.id, HASH_B, HASH_A)];
    const plan = planSpacePull(
      files,
      new Map([["Work.noren-space.json", textOfSpace(work)]]),
      ws.spaces,
    );
    expect(plan.relink).toEqual([{ name: "Work.noren-space.json", spaceId: work.id }]);
    expect(plan.replace).toEqual([]);
    expect(plan.add).toEqual([]);
  });

  it("brings back a space whose file changed on another computer after it was removed here", () => {
    const files = [entry("Gone.noren-space.json", "space-that-is-gone", HASH_B, HASH_A)];
    const plan = planSpacePull(files, new Map([["Gone.noren-space.json", cameText]]), ws.spaces);
    expect(plan.add.map((added) => added.name)).toEqual(["Gone.noren-space.json"]);
    expect(plan.replace).toEqual([]);
  });

  it("leaves out a file that is not a space file, with the reason, and goes on", () => {
    const files = [
      entry("Broken.noren-space.json", null),
      entry("Missing.noren-space.json", null),
      entry("Fine.noren-space.json", null),
    ];
    const plan = planSpacePull(
      files,
      new Map([
        ["Broken.noren-space.json", "{ nope"],
        ["Fine.noren-space.json", cameText],
      ]),
      ws.spaces,
    );
    expect(plan.add.map((added) => added.name)).toEqual(["Fine.noren-space.json"]);
    expect(plan.ignored).toEqual([
      { name: "Broken.noren-space.json", reason: "it is not valid JSON" },
      { name: "Missing.noren-space.json", reason: "the file could not be read" },
    ]);
  });

  it("never throws, whatever the files say (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 120 }), { maxLength: 4 }), (texts) => {
        const files = texts.map((_, index) => entry(`F${index}.noren-space.json`, null));
        const read = new Map(texts.map((text, index) => [`F${index}.noren-space.json`, text]));
        const plan = planSpacePull(files, read, ws.spaces);
        expect(plan.add.length + plan.ignored.length).toBe(texts.length);
      }),
      { numRuns: 100 },
    );
  });

  it("answers the same for what a push wrote: nothing to import (the push and the pull agree)", () => {
    const pushed = planSpacePush(ws.spaces, folderOf([]));
    const folder = pushed.writes.map((write) => entry(write.name, write.spaceId, HASH_A, HASH_A));
    const plan = planSpacePull(folder, new Map(), ws.spaces);
    expect(plan.unchanged).toBe(folder.length);
    expect(plan.add).toEqual([]);
  });
});

describe("space/reimport", () => {
  const reimport = (spaceId: string, file: SpaceFile): Action => ({
    type: "space/reimport",
    spaceId,
    file,
  });

  function fixture() {
    const { ctx } = testContext();
    let ws = workspaceWith("Work", "Play");
    const work = spaceNamed(ws, "Work");
    ws = reduceStrict(ws, { type: "item/create", spaceId: work.id }, ctx);
    ws = reduceStrict(ws, { type: "item/create", spaceId: work.id }, ctx);
    ws = reduceStrict(ws, { type: "space/activate", spaceId: spaceNamed(ws, "Play").id }, ctx);
    return { ws, ctx };
  }

  it("makes the space again in its place, with its id, and keeps the tabs it had as closed", () => {
    const { ws, ctx } = fixture();
    const work = spaceNamed(ws, "Work");
    const incoming = fileOfSpace({
      ...spaceNamed(workspaceWith("Other"), "Other"),
      name: "Work renamed",
    });
    const next = reduceStrict(deepFreeze(ws), reimport(work.id, incoming), ctx);
    expect(next.spaces.map((space) => space.id)).toEqual(ws.spaces.map((space) => space.id));
    expect(must(next.spaces[1]).name).toBe("Work renamed");
    expect(next.activeSpaceId).toBe(ws.activeSpaceId);
    const oldTabs = Object.keys(work.items);
    expect(next.closed.map((closed) => closed.item.id)).toEqual(expect.arrayContaining(oldTabs));
    expect(next.closed.every((closed) => closed.spaceId === work.id)).toBe(true);
    expect(checkInvariants(next)).toEqual([]);
    for (const id of Object.keys(must(next.spaces[1]).items)) expect(oldTabs).not.toContain(id);
  });

  it("keeps the picture behind the terminals, which a file never carries", () => {
    const { ws, ctx } = fixture();
    const work = spaceNamed(ws, "Work");
    const pictured: Workspace = {
      ...ws,
      spaces: ws.spaces.map((space) =>
        space.id === work.id ? { ...space, background: { image: "C:\\pics\\a.png" } } : space,
      ),
    };
    const next = reduceStrict(pictured, reimport(work.id, fileOfSpace(work)), ctx);
    expect(spaceNamed(next, "Work").background).toEqual({ image: "C:\\pics\\a.png" });
  });

  it("changes nothing for a space that is not there or a file that is not valid", () => {
    const { ws, ctx } = fixture();
    const work = spaceNamed(ws, "Work");
    const file = fileOfSpace(work);
    expect(reduceStrict(ws, reimport("nope", file), ctx)).toBe(ws);
    expect(
      reduceStrict(ws, reimport(work.id, { ...file, version: 2 } as unknown as SpaceFile), ctx),
    ).toBe(ws);
  });

  it("is never the same twice: ids are fresh each time", () => {
    const { ws, ctx } = fixture();
    const work = spaceNamed(ws, "Work");
    const file = fileOfSpace(work);
    const once = reduceStrict(ws, reimport(work.id, file), ctx);
    const twice = reduceStrict(once, reimport(work.id, file), ctx);
    expect(Object.keys(spaceNamed(twice, "Work").items)).not.toEqual(
      Object.keys(spaceNamed(once, "Work").items),
    );
    expect(textOfSpace(spaceNamed(twice, "Work"))).toBe(textOfSpace(spaceNamed(once, "Work")));
    expect(checkInvariants(twice)).toEqual([]);
  });
});

describe("limits", () => {
  it("names the ceilings the core uses", () => {
    expect(SYNC_LIMITS.files).toBe(500);
    expect(SYNC_LIMITS.fileBytes).toBe(1024 * 1024);
  });
});
