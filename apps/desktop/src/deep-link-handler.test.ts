import {
  FakeBackend,
  createDefaultWorkspace,
  createSequentialIds,
  parseActionsFile,
} from "@noren/model";
import type { Id, ProjectAction } from "@noren/model";
import { describe, expect, it } from "vitest";
import { createDeepLinkHandler } from "./deep-link-handler";
import { handleDeepLink, setDeepLinkHandler } from "./deep-link";
import { createWorkspaceStore } from "./workspace-store";

const clock = { now: () => 1000 };
const enc = encodeURIComponent;

const FILE = JSON.stringify({
  actions: [
    { id: "loop", label: "Loop", command: "loop", stop: "loop parar", tab: "loop" },
    { id: "dev", label: "Dev server", command: "pnpm dev", tab: "dev" },
  ],
});

interface Setup {
  /** Folders of the spaces to start with, in order (the first one is "Main", the active space). */
  folders?: (string | undefined)[];
  files?: Record<string, string>;
}

function setup({ folders = [undefined], files = {} }: Setup = {}) {
  const backend = new FakeBackend({ actionsFiles: files });
  const newId = createSequentialIds("n");
  const store = createWorkspaceStore({
    backend,
    workspace: createDefaultWorkspace({ newId, clock }),
    newId,
    clock,
  });
  const [first, ...rest] = folders;
  if (first !== undefined) {
    const main = store.getState().workspace.spaces[0];
    if (main) store.getState().editSpace(main.id, { cwd: first });
  }
  for (const [index, cwd] of rest.entries()) {
    store.getState().createSpace({ name: `S${index + 2}`, ...(cwd !== undefined ? { cwd } : {}) });
  }
  const mainId = store.getState().workspace.spaces[0]?.id ?? "";
  store.getState().activateSpace(mainId);

  const runs: { spaceId: Id; action: ProjectAction }[] = [];
  const notices: string[] = [];
  const handle = createDeepLinkHandler({
    store,
    backend,
    runAction: (spaceId, action) => runs.push({ spaceId, action }),
    notify: (text) => notices.push(text),
  });
  const workspace = () => store.getState().workspace;
  const active = () => workspace().spaces.find((s) => s.id === workspace().activeSpaceId);
  return { backend, store, handle, runs, notices, workspace, active };
}

describe("deep link handler: open", () => {
  it("focuses the space whose default folder matches", async () => {
    const t = setup({ folders: [undefined, "/srv/a", "/srv/b"] });
    await t.handle("noren://open?path=/srv/b");
    expect(t.active()?.name).toBe("S3");
    await t.handle("noren://open?path=/srv/a");
    expect(t.active()?.name).toBe("S2");
    expect(t.workspace().spaces).toHaveLength(3);
    expect(t.notices).toEqual([]);
    expect(t.runs).toEqual([]);
  });

  it("matches a folder the way sameFolder does: other separators, a trailing slash, Windows case", async () => {
    const t = setup({ folders: [undefined, "C:\\Users\\Ada\\Dev"] });
    await t.handle(`noren://open?path=${enc("c:/users/ada/dev/")}`);
    expect(t.active()?.name).toBe("S2");
    expect(t.workspace().spaces).toHaveLength(2);
  });

  it("makes a new space with that folder when none matches, named after the last segment", async () => {
    const t = setup();
    await t.handle("noren://open?path=/srv/new%20proj");
    const space = t.active();
    expect(t.workspace().spaces).toHaveLength(2);
    expect(space?.name).toBe("new proj");
    expect(space?.defaults.cwd).toBe("/srv/new proj");
    expect(Object.keys(space?.items ?? {})).toHaveLength(1);
    // The same link again focuses it instead of making another.
    await t.handle("noren://open?path=/srv/new%20proj/");
    expect(t.workspace().spaces).toHaveLength(2);
  });

  it("a folder with an accent keeps it", async () => {
    const t = setup();
    await t.handle(`noren://open?path=${enc("/home/jo\u00e3o/caf\u00e9")}`);
    expect(t.active()?.defaults.cwd).toBe("/home/jo\u00e3o/caf\u00e9");
    expect(t.active()?.name).toBe("caf\u00e9");
  });

  it("does not start a session or run anything", async () => {
    const t = setup();
    await t.handle("noren://open?path=/srv/new");
    expect(t.backend.callsTo("runCommand")).toHaveLength(0);
    expect(t.backend.callsTo("write")).toHaveLength(0);
    expect(t.runs).toEqual([]);
  });
});

describe("deep link handler: action", () => {
  it("focuses the space, reads its file and hands the declared action to runAction", async () => {
    const t = setup({ folders: [undefined, "/srv/proj"], files: { "/srv/proj": FILE } });
    await t.handle("noren://action?path=/srv/proj&id=dev");
    expect(t.active()?.defaults.cwd).toBe("/srv/proj");
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.spaceId).toBe(t.active()?.id);
    // The command is the one in the file, not text from the link.
    expect(t.runs[0]?.action).toEqual({
      id: "dev",
      label: "Dev server",
      command: "pnpm dev",
      tab: "dev",
    });
    expect(t.notices).toEqual([]);
  });

  it("reads the file of the folder the space already has (another spelling of the same folder)", async () => {
    const t = setup({ folders: [undefined, "C:\\Dev\\Proj"], files: { "C:\\Dev\\Proj": FILE } });
    await t.handle(`noren://action?path=${enc("c:/dev/proj/")}&id=loop`);
    expect(t.runs.map((r) => r.action.id)).toEqual(["loop"]);
    expect(t.workspace().spaces).toHaveLength(2);
  });

  it("makes the space when the folder has none, once the action is known to exist", async () => {
    const t = setup({ files: { "/srv/fresh": FILE } });
    await t.handle("noren://action?path=/srv/fresh&id=loop");
    expect(t.workspace().spaces).toHaveLength(2);
    expect(t.active()?.defaults.cwd).toBe("/srv/fresh");
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.spaceId).toBe(t.active()?.id);
    expect(t.runs[0]?.action.command).toBe("loop");
  });

  it("an unknown id: a notice, nothing runs and no space is made", async () => {
    const t = setup({ files: { "/srv/fresh": FILE } });
    await t.handle("noren://action?path=/srv/fresh&id=nope");
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('no action "nope"');
    expect(t.runs).toEqual([]);
    expect(t.workspace().spaces).toHaveLength(1);
  });

  it("a folder with no file: a notice and nothing happens", async () => {
    const t = setup();
    await t.handle("noren://action?path=/srv/fresh&id=loop");
    expect(t.notices[0]).toContain("There is no .noren/actions.json in /srv/fresh");
    expect(t.runs).toEqual([]);
    expect(t.workspace().spaces).toHaveLength(1);
  });

  it("an invalid file: a notice with the reason, nothing runs", async () => {
    const bad = '{ "actions": [ { "id": "loop" } ] }';
    const reason = parseActionsFile(bad);
    expect(reason.ok).toBe(false);
    const t = setup({ files: { "/srv/fresh": bad } });
    await t.handle("noren://action?path=/srv/fresh&id=loop");
    expect(t.notices[0]).toContain("is invalid");
    expect(t.notices[0]).toContain("actions[0]");
    expect(t.runs).toEqual([]);
    expect(t.workspace().spaces).toHaveLength(1);
  });

  it("a file that cannot be read: a notice with the reason", async () => {
    const t = setup();
    t.backend.readActionsFile = () => Promise.reject(new Error("access denied"));
    await t.handle("noren://action?path=/srv/fresh&id=loop");
    expect(t.notices[0]).toContain("Could not read");
    expect(t.notices[0]).toContain("access denied");
    expect(t.runs).toEqual([]);
  });

  it("two identical links back to back make one space", async () => {
    const t = setup({ files: { "/srv/fresh": FILE } });
    await Promise.all([
      t.handle("noren://action?path=/srv/fresh&id=loop"),
      t.handle("noren://action?path=/srv/fresh&id=loop"),
    ]);
    expect(t.workspace().spaces).toHaveLength(2);
  });
});

describe("deep link handler: refused links", () => {
  it.each([
    "noren://action?path=/srv/proj&id=dev&command=rm%20-rf%20%2F",
    "noren://action?path=/srv/proj&command=pnpm%20dev",
    "noren://open?path=/srv/proj&cmd=calc",
    "noren://run?path=/srv/proj",
    "noren://open?path=../etc",
    "https://example.com",
    "",
  ])("%j: a notice, no space, no read, nothing runs", async (url) => {
    const t = setup({ files: { "/srv/proj": FILE } });
    await t.handle(url);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatch(/^Link refused: /);
    expect(t.runs).toEqual([]);
    expect(t.workspace().spaces).toHaveLength(1);
    expect(t.backend.callsTo("readActionsFile")).toHaveLength(0);
    expect(t.backend.callsTo("runCommand")).toHaveLength(0);
    expect(t.backend.callsTo("write")).toHaveLength(0);
  });
});

describe("deep link entry point", () => {
  it("keeps a link until the handler is registered, then applies it", async () => {
    const seen: string[] = [];
    await handleDeepLink("noren://open?path=/early");
    expect(seen).toEqual([]);
    setDeepLinkHandler((url) => {
      seen.push(url);
      return Promise.resolve();
    });
    expect(seen).toEqual(["noren://open?path=/early"]);
    await handleDeepLink("noren://open?path=/later");
    expect(seen).toEqual(["noren://open?path=/early", "noren://open?path=/later"]);
    setDeepLinkHandler(undefined);
  });

  it("ignores a value that is not text", async () => {
    const seen: string[] = [];
    setDeepLinkHandler((url) => {
      seen.push(url);
      return Promise.resolve();
    });
    await handleDeepLink(42);
    await handleDeepLink(undefined);
    expect(seen).toEqual([]);
    setDeepLinkHandler(undefined);
  });
});
