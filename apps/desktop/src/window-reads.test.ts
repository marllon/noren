import {
  FakeBackend,
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_PREVIEW_TEXT_BYTES,
  createSequentialIds,
  layoutPanes,
  restoreWorkspace,
  workspaceWindows,
} from "@noren/model";
import type { FilePreview, GitDiff, Id, Pane } from "@noren/model";
import { describe, expect, it } from "vitest";
import { memoryQuickEvents } from "./quick";
import type { QuickEvents } from "./quick";
import {
  MAX_WINDOW_READS,
  WINDOW_READ_EVENT,
  WINDOW_READ_RESULT_EVENT,
  createWindowReads,
  followWindowReads,
  previewFromWire,
  previewToWire,
  readOfWindowRequest,
} from "./window-sync";
import { moveItemToNewWindow } from "./window-service";
import { createWorkspaceStore } from "./workspace-store";

const clock = { now: () => 1000 };

const NOTES = "/work/notes.md";
const OTHER_NOTES = "/work/other.md";
const MAIN_NOTES = "/work/in-main.md";
const REPO = "/work/repo";
const OTHER_REPO = "/work/other-repo";
const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 255, 254,
]);

/**
 * A main window with three tabs. The first has a terminal, a preview of NOTES and a diff of REPO
 * and goes to a window "A"; the second has a terminal and a preview of OTHER_NOTES and a diff of
 * OTHER_REPO and goes to a window "B"; the third stays in the main window with a preview of
 * MAIN_NOTES and a diff of REPO.
 */
async function openMain(backend = new FakeBackend()) {
  backend.setFile(NOTES, "# Notes\n");
  backend.setFile(OTHER_NOTES, "other\n");
  backend.setFile(MAIN_NOTES, "main\n");
  backend.setGitDiff(REPO, DIFF);
  backend.setGitDiff(OTHER_REPO, DIFF);
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  store.getState().newTab();
  store.getState().newTab();
  const space = () => {
    const ws = store.getState().workspace;
    return ws.spaces.find((s) => s.id === ws.activeSpaceId);
  };
  const items = Object.keys(space()?.items ?? {});
  const [first, second, third] = items;
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("three tabs were expected");
  }
  const panesOf = (itemId: Id): Pane[] => {
    for (const s of store.getState().workspace.spaces) {
      const item = s.items[itemId];
      if (item !== undefined) return layoutPanes(item.layout);
    }
    return [];
  };
  const terminalOf = (itemId: Id): Id => {
    const pane = panesOf(itemId).find((p) => p.type === "terminal");
    if (pane === undefined) throw new Error("a terminal was expected");
    return pane.id;
  };
  const addPanes = (itemId: Id, path: string, cwd: string): void => {
    const paneId = terminalOf(itemId);
    store.getState().dispatch({
      type: "pane/split",
      itemId,
      paneId,
      dir: "row",
      side: "after",
      path,
    });
    store.getState().dispatch({
      type: "pane/split",
      itemId,
      paneId,
      dir: "row",
      side: "after",
      diff: true,
      cwd,
    });
  };
  addPanes(first, NOTES, REPO);
  addPanes(second, OTHER_NOTES, OTHER_REPO);
  addPanes(third, MAIN_NOTES, REPO);
  for (const [itemId, name] of [
    [first, "A"],
    [second, "B"],
  ] as const) {
    const result = await moveItemToNewWindow(store, backend, itemId, name);
    if (!result.ok) throw new Error(result.reason);
  }
  const windows = workspaceWindows(store.getState().workspace);
  const [windowA, windowB] = windows;
  if (windowA === undefined || windowB === undefined) throw new Error("two windows were expected");
  const paneOfType = (itemId: Id, type: "preview" | "diff"): Pane => {
    const pane = panesOf(itemId).find((p) => p.type === type);
    if (pane === undefined) throw new Error(`a ${type} pane was expected`);
    return pane;
  };
  return {
    backend,
    store,
    windowA: windowA.id,
    windowB: windowB.id,
    first,
    second,
    third,
    previewOf: (itemId: Id) => paneOfType(itemId, "preview"),
    diffOf: (itemId: Id) => paneOfType(itemId, "diff"),
    terminalOf,
  };
}

type Main = Awaited<ReturnType<typeof openMain>>;

const previewRequest = (main: Main, windowId: Id, itemId: Id, request = 1) => ({
  windowId,
  request,
  kind: "preview",
  itemId,
  paneId: main.previewOf(itemId).id,
  path: main.previewOf(itemId).path,
});
const diffRequest = (main: Main, windowId: Id, itemId: Id, request = 1) => ({
  windowId,
  request,
  kind: "diff",
  itemId,
  paneId: main.diffOf(itemId).id,
  cwd: main.diffOf(itemId).cwd,
});

/** The bus plus what went through it. */
function recordingEvents(): { events: QuickEvents; heard: { event: string; payload: unknown }[] } {
  const inner = memoryQuickEvents();
  const heard: { event: string; payload: unknown }[] = [];
  return {
    heard,
    events: {
      listen: inner.listen,
      emit: async (event, payload) => {
        heard.push({ event, payload });
        await inner.emit(event, payload);
      },
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("readOfWindowRequest", () => {
  it("accepts the read of a preview pane and of a diff pane of a tab of the window", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const preview = main.previewOf(main.first);
    expect(readOfWindowRequest(previewRequest(main, main.windowA, main.first, 7), ws)).toEqual({
      windowId: main.windowA,
      request: 7,
      read: { kind: "preview", itemId: main.first, paneId: preview.id, path: NOTES },
    });
    const diff = main.diffOf(main.first);
    expect(readOfWindowRequest(diffRequest(main, main.windowA, main.first, 8), ws)).toEqual({
      windowId: main.windowA,
      request: 8,
      read: { kind: "diff", itemId: main.first, paneId: diff.id, cwd: REPO },
    });
  });

  it("reads what the pane holds, whatever else the event says", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const asked = readOfWindowRequest(
      { ...previewRequest(main, main.windowA, main.first), extra: "/etc/passwd", url: "https://x" },
      ws,
    );
    expect(asked?.read).toEqual({
      kind: "preview",
      itemId: main.first,
      paneId: main.previewOf(main.first).id,
      path: NOTES,
    });
    expect(Object.keys(asked?.read ?? {}).sort()).toEqual(["itemId", "kind", "paneId", "path"]);
  });

  it("ignores a read from a window the workspace does not have", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    for (const windowId of ["nope", "main", "window-x", "", "a b"]) {
      expect(
        readOfWindowRequest({ ...previewRequest(main, main.windowA, main.first), windowId }, ws),
        windowId,
      ).toBeUndefined();
    }
  });

  it("ignores a read for a pane of the main window or of the space of another window", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    // The tab that stayed in the main window, asked for by a window.
    expect(readOfWindowRequest(previewRequest(main, main.windowA, main.third), ws)).toBeUndefined();
    expect(readOfWindowRequest(diffRequest(main, main.windowA, main.third), ws)).toBeUndefined();
    // The tab of window B, asked for by window A and the other way round.
    expect(
      readOfWindowRequest(previewRequest(main, main.windowA, main.second), ws),
    ).toBeUndefined();
    expect(readOfWindowRequest(diffRequest(main, main.windowB, main.first), ws)).toBeUndefined();
    // And each by its own window works.
    expect(readOfWindowRequest(previewRequest(main, main.windowB, main.second), ws)).toBeDefined();
  });

  it("ignores a pane that is not in the tab named, one that does not exist and one of the wrong kind", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const good = previewRequest(main, main.windowA, main.first);
    expect(
      readOfWindowRequest({ ...good, paneId: main.previewOf(main.second).id }, ws),
    ).toBeUndefined();
    expect(readOfWindowRequest({ ...good, paneId: "ghost" }, ws)).toBeUndefined();
    expect(readOfWindowRequest({ ...good, itemId: "ghost" }, ws)).toBeUndefined();
    // A preview read for the diff pane, a diff read for the preview pane, either for the terminal.
    expect(
      readOfWindowRequest({ ...good, paneId: main.diffOf(main.first).id }, ws),
    ).toBeUndefined();
    const diff = diffRequest(main, main.windowA, main.first);
    expect(
      readOfWindowRequest({ ...diff, paneId: main.previewOf(main.first).id }, ws),
    ).toBeUndefined();
    const terminal = main.terminalOf(main.first);
    expect(readOfWindowRequest({ ...good, paneId: terminal }, ws)).toBeUndefined();
    expect(readOfWindowRequest({ ...diff, paneId: terminal }, ws)).toBeUndefined();
    expect(readOfWindowRequest({ ...good, kind: "terminal" }, ws)).toBeUndefined();
    expect(readOfWindowRequest({ ...good, kind: undefined }, ws)).toBeUndefined();
  });

  it("ignores a path or a folder that is not the one of the pane", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const preview = previewRequest(main, main.windowA, main.first);
    for (const path of [
      OTHER_NOTES,
      "/etc/passwd",
      `${NOTES}/`,
      `${NOTES}x`,
      NOTES.toUpperCase(),
      `${NOTES}/../../etc/passwd`,
      "",
      undefined,
      null,
      7,
      [NOTES],
      { toString: () => NOTES },
    ]) {
      expect(readOfWindowRequest({ ...preview, path }, ws), String(path)).toBeUndefined();
    }
    const diff = diffRequest(main, main.windowA, main.first);
    for (const cwd of [OTHER_REPO, "/", `${REPO}/sub`, `${REPO}/`, "", undefined, null, [REPO]]) {
      expect(readOfWindowRequest({ ...diff, cwd }, ws), String(cwd)).toBeUndefined();
    }
    // The path of a diff pane sent as a preview read, and the folder of a preview as a diff.
    expect(readOfWindowRequest({ ...diff, kind: "preview", path: REPO }, ws)).toBeUndefined();
  });

  it("ignores a read with no number, or one that is not a positive whole number", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const good = previewRequest(main, main.windowA, main.first);
    expect(readOfWindowRequest({ ...good, request: undefined }, ws)).toBeUndefined();
    for (const request of [0, -1, 1.5, NaN, Infinity, "1", null, [1], 2 ** 60]) {
      expect(readOfWindowRequest({ ...good, request }, ws), String(request)).toBeUndefined();
    }
    expect(readOfWindowRequest({ ...good, request: 1 }, ws)).toBeDefined();
    expect(readOfWindowRequest({ ...good, request: 2 ** 40 }, ws)).toBeDefined();
  });

  it("ignores what is not an event of a window at all", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    for (const payload of [undefined, null, "x", 3, [], {}, { windowId: main.windowA }]) {
      expect(readOfWindowRequest(payload, ws)).toBeUndefined();
    }
  });

  it("whatever a page sends, a read that gets through names a pane of the window and its own path", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const space = (windowId: Id) => {
      const window = workspaceWindows(ws).find((w) => w.id === windowId);
      return ws.spaces.find((s) => s.id === window?.spaceId);
    };
    // Every window, tab, pane, kind and path or folder of the workspace, right and wrong, plus junk.
    const panes = ws.spaces.flatMap((s) =>
      Object.values(s.items).flatMap((item) =>
        layoutPanes(item.layout).map((pane) => ({ item: item.id, pane })),
      ),
    );
    const windows = [main.windowA, main.windowB, "nope"];
    const values = [NOTES, OTHER_NOTES, MAIN_NOTES, REPO, OTHER_REPO, "", undefined, 3];
    let accepted = 0;
    let tried = 0;
    for (const windowId of windows) {
      for (const { item, pane } of panes) {
        for (const kind of ["preview", "diff", "browser", undefined]) {
          for (const value of values) {
            for (const field of ["path", "cwd"]) {
              tried++;
              const asked = readOfWindowRequest(
                { windowId, request: 1, kind, itemId: item, paneId: pane.id, [field]: value },
                ws,
              );
              if (asked === undefined) continue;
              accepted++;
              const held = space(windowId)?.items[asked.read.itemId];
              const found =
                held && layoutPanes(held.layout).find((p) => p.id === asked.read.paneId);
              expect(found, JSON.stringify(asked)).toBeDefined();
              if (asked.read.kind === "preview") {
                expect(found?.type).toBe("preview");
                expect(asked.read.path).toBe(found?.path);
              } else {
                expect(found?.type).toBe("diff");
                expect(asked.read.cwd).toBe(found?.cwd);
              }
            }
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(1000);
    // Two windows, each with a preview pane and a diff pane, asked right once each.
    expect(accepted).toBe(4);
  });
});

describe("previewToWire and previewFromWire", () => {
  const previews: FilePreview[] = [
    { kind: "markdown", text: "# Hi" },
    { kind: "json", text: '{"a":1}' },
    { kind: "text", text: "" },
    { kind: "image", mime: "image/png", bytes: PNG },
    { kind: "refused", reason: "missing" },
    { kind: "refused", reason: "too-large", size: 2_000_000 },
    { kind: "refused", reason: "unreadable", detail: "access is denied" },
  ];

  it.each(previews)("a $kind preview crosses as JSON and comes out the same", (preview) => {
    const sent = JSON.parse(JSON.stringify(previewToWire(preview))) as unknown;
    expect(previewFromWire(sent)).toEqual(preview);
  });

  it("carries the bytes of a big picture whole", () => {
    const big = new Uint8Array(300_000);
    big.set(PNG);
    for (let at = PNG.length; at < big.length; at++) big[at] = at % 251;
    const sent = JSON.parse(
      JSON.stringify(previewToWire({ kind: "image", mime: "image/png", bytes: big })),
    ) as unknown;
    const back = previewFromWire(sent);
    expect(back.kind).toBe("image");
    if (back.kind === "image") expect(Array.from(back.bytes)).toEqual(Array.from(big));
  });

  it.each([
    ["not an object", "markdown"],
    ["null", null],
    ["no kind", {}],
    ["a kind unknown here", { kind: "video", text: "x" }],
    ["text that is not text", { kind: "text", text: 3 }],
    ["text past the limit", { kind: "text", text: "a".repeat(MAX_PREVIEW_TEXT_BYTES + 1) }],
    ["a picture with no data", { kind: "image", mime: "image/png" }],
    ["a picture that is not base64", { kind: "image", mime: "image/png", data: "%%%" }],
    ["a picture that is another kind", { kind: "image", mime: "image/gif", data: "iVBORw0KGgo=" }],
    ["a picture that is no picture", { kind: "image", mime: "image/png", data: "aGVsbG8=" }],
    [
      "a picture past the limit",
      {
        kind: "image",
        mime: "image/png",
        data: "A".repeat(Math.ceil(MAX_PREVIEW_IMAGE_BYTES / 3) * 4 + 4),
      },
    ],
    ["a refusal for a reason unknown here", { kind: "refused", reason: "because" }],
    ["a refusal with no reason", { kind: "refused" }],
  ])("refuses %s", (_name, value) => {
    expect(() => previewFromWire(value)).toThrow();
  });

  it("keeps a size only when it is a number it can show, and cuts a long detail", () => {
    expect(previewFromWire({ kind: "refused", reason: "too-large", size: -1 })).toEqual({
      kind: "refused",
      reason: "too-large",
    });
    expect(previewFromWire({ kind: "refused", reason: "too-large", size: "big" })).toEqual({
      kind: "refused",
      reason: "too-large",
    });
    const cut = previewFromWire({ kind: "refused", reason: "unreadable", detail: "x".repeat(900) });
    expect(cut.kind === "refused" ? cut.detail?.length : -1).toBe(500);
  });
});

describe("followWindowReads", () => {
  /** The replies the main window sent to the pages, as the page would hear them. */
  const repliesOf = (heard: { event: string; payload: unknown }[]) =>
    heard.filter((h) => h.event === WINDOW_READ_RESULT_EVENT).map((h) => h.payload);

  it("reads the file of a preview pane through the backend and answers the window that asked", async () => {
    const main = await openMain();
    const { events, heard } = recordingEvents();
    const stop = followWindowReads(main.store, main.backend, events);
    await settle();
    await events.emit(WINDOW_READ_EVENT, previewRequest(main, main.windowA, main.first, 5));
    await settle();
    expect(repliesOf(heard)).toEqual([
      {
        windowId: main.windowA,
        request: 5,
        kind: "preview",
        preview: { kind: "markdown", text: "# Notes\n" },
      },
    ]);
    expect(main.backend.callsTo("readFilePreview").map((call) => call.args)).toEqual([[NOTES]]);
    expect(main.backend.callsTo("readGitDiff")).toEqual([]);
    stop();
  });

  it("reads the git diff of a diff pane and answers with it", async () => {
    const main = await openMain();
    const { events, heard } = recordingEvents();
    followWindowReads(main.store, main.backend, events);
    await settle();
    await events.emit(WINDOW_READ_EVENT, diffRequest(main, main.windowB, main.second, 3));
    await settle();
    expect(repliesOf(heard)).toEqual([
      { windowId: main.windowB, request: 3, kind: "diff", diff: { kind: "diff", text: DIFF } },
    ]);
    expect(main.backend.callsTo("readGitDiff").map((call) => call.args)).toEqual([[OTHER_REPO]]);
    expect(main.backend.callsTo("readFilePreview")).toEqual([]);
  });

  it("answers a picture as base64, which the page turns into the picture again", async () => {
    const main = await openMain();
    main.backend.setFile(NOTES, PNG);
    const { events, heard } = recordingEvents();
    followWindowReads(main.store, main.backend, events);
    await settle();
    await events.emit(WINDOW_READ_EVENT, previewRequest(main, main.windowA, main.first));
    await settle();
    const [reply] = repliesOf(heard) as { preview: unknown }[];
    expect(JSON.parse(JSON.stringify(reply?.preview))).toMatchObject({ kind: "image" });
    expect(previewFromWire(reply?.preview)).toEqual({
      kind: "image",
      mime: "image/png",
      bytes: PNG,
    });
  });

  it("answers a refusal as an answer: a file that is gone, a folder that is no repository", async () => {
    const main = await openMain();
    main.backend.setFile(NOTES, null);
    main.backend.setGitDiff(REPO, null);
    const { events, heard } = recordingEvents();
    followWindowReads(main.store, main.backend, events);
    await settle();
    await events.emit(WINDOW_READ_EVENT, previewRequest(main, main.windowA, main.first, 1));
    await events.emit(WINDOW_READ_EVENT, diffRequest(main, main.windowA, main.first, 2));
    await settle();
    expect(repliesOf(heard)).toEqual([
      {
        windowId: main.windowA,
        request: 1,
        kind: "preview",
        preview: { kind: "refused", reason: "missing" },
      },
      {
        windowId: main.windowA,
        request: 2,
        kind: "diff",
        diff: { kind: "refused", reason: "not-a-repository" },
      },
    ]);
  });

  it("says so when the read itself fails, instead of leaving the window waiting", async () => {
    const backend = new FakeBackend();
    const main = await openMain(backend);
    backend.readFilePreview = () => Promise.reject(new Error("the shell is gone"));
    const { events, heard } = recordingEvents();
    followWindowReads(main.store, backend, events);
    await settle();
    await events.emit(WINDOW_READ_EVENT, previewRequest(main, main.windowA, main.first, 4));
    await settle();
    expect(repliesOf(heard)).toEqual([
      { windowId: main.windowA, request: 4, failed: "the shell is gone" },
    ]);
  });

  it("reads nothing and answers nothing for a request that is not the window's own", async () => {
    const main = await openMain();
    const { events, heard } = recordingEvents();
    followWindowReads(main.store, main.backend, events);
    await settle();
    const good = previewRequest(main, main.windowA, main.first);
    for (const wrong of [
      { ...good, windowId: main.windowB },
      { ...good, itemId: main.second },
      { ...good, itemId: main.third, paneId: main.previewOf(main.third).id, path: MAIN_NOTES },
      { ...good, path: "/etc/passwd" },
      { ...good, path: OTHER_NOTES },
      { ...diffRequest(main, main.windowA, main.first), cwd: "/" },
      { ...good, request: 0 },
      { ...good, kind: "diff" },
      { ...good, paneId: main.terminalOf(main.first) },
      "not an event",
      null,
    ]) {
      await events.emit(WINDOW_READ_EVENT, wrong);
    }
    await settle();
    expect(repliesOf(heard)).toEqual([]);
    expect(main.backend.callsTo("readFilePreview")).toEqual([]);
    expect(main.backend.callsTo("readGitDiff")).toEqual([]);
  });

  it("reads again for the same pane each time it is asked, the way a refresh does", async () => {
    const main = await openMain();
    const { events, heard } = recordingEvents();
    followWindowReads(main.store, main.backend, events);
    await settle();
    await events.emit(WINDOW_READ_EVENT, diffRequest(main, main.windowA, main.first, 1));
    await settle();
    main.backend.setGitDiff(REPO, "");
    await events.emit(WINDOW_READ_EVENT, diffRequest(main, main.windowA, main.first, 2));
    await settle();
    expect(repliesOf(heard)).toMatchObject([
      { request: 1, diff: { kind: "diff", text: DIFF } },
      { request: 2, diff: { kind: "diff", text: "" } },
    ]);
    expect(main.backend.callsTo("readGitDiff")).toHaveLength(2);
  });

  it("has at most MAX_WINDOW_READS going for a window, and ignores the rest until some are done", async () => {
    const backend = new FakeBackend();
    const main = await openMain(backend);
    const release: (() => void)[] = [];
    backend.readFilePreview = () =>
      new Promise<FilePreview>((resolve) => {
        release.push(() => resolve({ kind: "text", text: "late" }));
      });
    const { events, heard } = recordingEvents();
    followWindowReads(main.store, backend, events);
    await settle();
    for (let request = 1; request <= MAX_WINDOW_READS + 3; request++) {
      await events.emit(WINDOW_READ_EVENT, previewRequest(main, main.windowA, main.first, request));
    }
    await settle();
    expect(release).toHaveLength(MAX_WINDOW_READS);
    // Another window has its own room.
    await events.emit(WINDOW_READ_EVENT, previewRequest(main, main.windowB, main.second, 99));
    await settle();
    expect(release).toHaveLength(MAX_WINDOW_READS + 1);
    for (const done of release.splice(0)) done();
    await settle();
    expect(repliesOf(heard)).toHaveLength(MAX_WINDOW_READS + 1);
    // Room again.
    await events.emit(WINDOW_READ_EVENT, previewRequest(main, main.windowA, main.first, 100));
    await settle();
    expect(release).toHaveLength(1);
  });

  it("stops answering when stopped", async () => {
    const main = await openMain();
    const { events, heard } = recordingEvents();
    const stop = followWindowReads(main.store, main.backend, events);
    await settle();
    stop();
    await events.emit(WINDOW_READ_EVENT, previewRequest(main, main.windowA, main.first));
    await settle();
    expect(repliesOf(heard)).toEqual([]);
    expect(main.backend.callsTo("readFilePreview")).toEqual([]);
  });

  it("does not answer a read for a pane the workspace no longer has", async () => {
    const main = await openMain();
    const { events, heard } = recordingEvents();
    followWindowReads(main.store, main.backend, events);
    await settle();
    const request = previewRequest(main, main.windowA, main.first);
    main.store.getState().dispatch({ type: "item/close", itemId: main.first });
    await events.emit(WINDOW_READ_EVENT, request);
    await settle();
    expect(repliesOf(heard)).toEqual([]);
    expect(main.backend.callsTo("readFilePreview")).toEqual([]);
  });
});

describe("createWindowReads: the page of a window", () => {
  it("asks the main window, which reads, and gets the file and the diff back", async () => {
    const main = await openMain();
    const events = memoryQuickEvents();
    followWindowReads(main.store, main.backend, events);
    const reads = createWindowReads(events, main.windowA);
    const preview = main.previewOf(main.first);
    const diff = main.diffOf(main.first);
    expect(await reads.forPane(main.first, preview.id).readFilePreview(NOTES)).toEqual({
      kind: "markdown",
      text: "# Notes\n",
    });
    expect(await reads.forPane(main.first, diff.id).readGitDiff(REPO)).toEqual({
      kind: "diff",
      text: DIFF,
    });
    // The reads were made by the main window's backend, one each.
    expect(main.backend.callsTo("readFilePreview").map((c) => c.args)).toEqual([[NOTES]]);
    expect(main.backend.callsTo("readGitDiff").map((c) => c.args)).toEqual([[REPO]]);
    reads.stop();
  });

  it("gets a picture back as the bytes it was", async () => {
    const main = await openMain();
    main.backend.setFile(NOTES, PNG);
    const events = memoryQuickEvents();
    followWindowReads(main.store, main.backend, events);
    const reads = createWindowReads(events, main.windowA);
    const answer = await reads
      .forPane(main.first, main.previewOf(main.first).id)
      .readFilePreview(NOTES);
    expect(answer).toEqual({ kind: "image", mime: "image/png", bytes: PNG });
  });

  it("numbers its requests and sends what pane and tab they are for", async () => {
    const { events, heard } = recordingEvents();
    const reads = createWindowReads(events, "w1", { timeoutMs: 20 });
    const first = reads.forPane("i1", "p1").readFilePreview("/a.md");
    const second = reads.forPane("i2", "p2").readGitDiff("/repo");
    await settle();
    await expect(first).rejects.toThrow("did not answer");
    await expect(second).rejects.toThrow("did not answer");
    expect(heard.filter((h) => h.event === WINDOW_READ_EVENT).map((h) => h.payload)).toEqual([
      { windowId: "w1", request: 1, kind: "preview", itemId: "i1", paneId: "p1", path: "/a.md" },
      { windowId: "w1", request: 2, kind: "diff", itemId: "i2", paneId: "p2", cwd: "/repo" },
    ]);
  });

  it("hands out the same reader for a pane every time, so a pane does not read again by itself", () => {
    const reads = createWindowReads(memoryQuickEvents(), "w1");
    expect(reads.forPane("i1", "p1")).toBe(reads.forPane("i1", "p1"));
    expect(reads.forPane("i1", "p1")).not.toBe(reads.forPane("i1", "p2"));
    expect(reads.forPane("i1", "p1")).not.toBe(reads.forPane("i2", "p1"));
  });

  it("rejects when the main window reports that the read failed", async () => {
    const events = memoryQuickEvents();
    await events.listen(WINDOW_READ_EVENT, (payload) => {
      const { windowId, request } = payload as { windowId: string; request: number };
      void events.emit(WINDOW_READ_RESULT_EVENT, { windowId, request, failed: "boom".repeat(400) });
    });
    const reads = createWindowReads(events, "w1");
    const error = await reads
      .forPane("i1", "p1")
      .readFilePreview("/a.md")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("boom".repeat(400).slice(0, 500));
  });

  it("rejects when nobody answers in time", async () => {
    const reads = createWindowReads(memoryQuickEvents(), "w1", { timeoutMs: 20 });
    await expect(reads.forPane("i1", "p1").readGitDiff("/repo")).rejects.toThrow(
      "the main window did not answer",
    );
  });

  /** A main window that answers each read with `reply(windowId, request)`. */
  async function answeringWith(
    reply: (windowId: string, request: number) => unknown[],
  ): Promise<QuickEvents> {
    const events = memoryQuickEvents();
    await events.listen(WINDOW_READ_EVENT, (payload) => {
      const { windowId, request } = payload as { windowId: string; request: number };
      for (const one of reply(windowId, request)) void events.emit(WINDOW_READ_RESULT_EVENT, one);
    });
    return events;
  }

  it("keeps waiting through an answer that is not its own, for another window, request, kind or a bad shape", async () => {
    const answer = { kind: "preview", preview: { kind: "text", text: "right" } };
    const events = await answeringWith((windowId, request) => [
      { windowId: "w2", request, ...answer },
      { windowId, request: request + 1, ...answer },
      { windowId, request, kind: "diff", diff: { kind: "diff", text: "x" } },
      { windowId, request, kind: "preview", preview: { kind: "video" } },
      { windowId, request, kind: "preview" },
      { windowId, request, failed: 3 },
      { windowId, request: "1", ...answer },
      null,
      "x",
      { windowId, request, ...answer },
    ]);
    const reads = createWindowReads(events, "w1", { timeoutMs: 1000 });
    expect(await reads.forPane("i1", "p1").readFilePreview("/a.md")).toEqual({
      kind: "text",
      text: "right",
    });
  });

  it("times out on answers that are all wrong", async () => {
    const events = await answeringWith((windowId, request) => [
      { windowId: "w2", request, kind: "preview", preview: { kind: "text", text: "wrong window" } },
      { windowId, request, kind: "preview", preview: { kind: "image", mime: "image/png" } },
      // An answer of the other kind, even one that holds a good preview, is not for a preview read.
      { windowId, request, kind: "diff", preview: { kind: "text", text: "wrong kind" } },
    ]);
    const reads = createWindowReads(events, "w1", { timeoutMs: 30 });
    await expect(reads.forPane("i1", "p1").readFilePreview("/a.md")).rejects.toThrow(
      "did not answer",
    );
  });

  it("takes the first answer and ignores a second one for the same request", async () => {
    const events = await answeringWith((windowId, request) => [
      { windowId, request, kind: "diff", diff: { kind: "diff", text: "first" } },
      { windowId, request, kind: "diff", diff: { kind: "diff", text: "second" } },
    ]);
    const reads = createWindowReads(events, "w1");
    const got: GitDiff = await reads.forPane("i1", "p1").readGitDiff("/repo");
    expect(got).toEqual({ kind: "diff", text: "first" });
  });

  it("has at most four reads on their way, and sends the next when one is answered", async () => {
    const { events, heard } = recordingEvents();
    const reads = createWindowReads(events, "w1", { timeoutMs: 5000 });
    const results = Array.from({ length: 6 }, (_, n) =>
      reads.forPane("i1", `p${n}`).readGitDiff(`/repo${n}`),
    );
    await settle();
    const sent = () => heard.filter((h) => h.event === WINDOW_READ_EVENT);
    expect(sent()).toHaveLength(4);
    await events.emit(WINDOW_READ_RESULT_EVENT, {
      windowId: "w1",
      request: 1,
      kind: "diff",
      diff: { kind: "diff", text: "one" },
    });
    await settle();
    expect(sent()).toHaveLength(5);
    expect(await results[0]).toEqual({ kind: "diff", text: "one" });
    for (const request of [2, 3, 4, 5, 6]) {
      await events.emit(WINDOW_READ_RESULT_EVENT, {
        windowId: "w1",
        request,
        kind: "diff",
        diff: { kind: "diff", text: String(request) },
      });
      await settle();
    }
    expect(sent()).toHaveLength(6);
    expect(await Promise.all(results)).toHaveLength(6);
  });

  it("fails the reads still waiting when stopped, and listens again if it is asked again", async () => {
    const events = memoryQuickEvents();
    const reads = createWindowReads(events, "w1", { timeoutMs: 5000 });
    const waiting = reads.forPane("i1", "p1").readGitDiff("/repo");
    await settle();
    reads.stop();
    await expect(waiting).rejects.toThrow("stopped");
    // A page that mounts again (a development double effect) can read again.
    const main = await openMain();
    followWindowReads(main.store, main.backend, events);
    const again = createWindowReads(events, main.windowA);
    again.stop();
    expect(await again.forPane(main.first, main.diffOf(main.first).id).readGitDiff(REPO)).toEqual({
      kind: "diff",
      text: DIFF,
    });
  });
});
