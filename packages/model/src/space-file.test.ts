import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import { arbWorkspace } from "./arbitraries";
import { checkInvariants } from "./invariants";
import { reduce, reduceStrict } from "./reducer";
import {
  SPACE_FILE_LIMITS,
  exportSpace,
  looksSecret,
  parseSpaceFile,
  planProfiles,
  spaceFromFile,
  validateSpaceFile,
  withoutSecretEnv,
  type SpaceFile,
} from "./space-file";
import { deepFreeze, testContext } from "./test-helpers";
import { treeGroups } from "./tree";
import { DEFAULT_MAX_PANES } from "./types";
import type { Id, Node, Pane, Space, Workspace } from "./types";
import { layoutPanes } from "./sessions";
import type { UserProfile } from "./user-profile-schema";

// The secrets below are made up and built from pieces, so no line of this file looks like a real
// credential to a scanner (and none is one).
const rep = (chunk: string, times: number): string => chunk.repeat(times);
const GITHUB = "gh" + "p_" + rep("a1B2", 9);
const SK = "s" + "k-" + "proj-" + rep("Ab12", 8);
const AWS = "AK" + "IA" + "IOSFODNN7EXAMPLE";
const URL_PASSWORD = "postgres://admin:" + "hunter2hunter2" + "@db.example.com/app";

/** A parsed file the tests spoil field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const terminal = (id: string, extra: Partial<Pane> = {}): Pane => ({
  id,
  type: "terminal",
  profileId: "pwsh",
  cwd: "C:\\work\\app",
  gitBranch: "main",
  status: "running",
  unread: true,
  bell: true,
  unreadAt: 5,
  scrollbackRef: "sb-1.bin",
  runningCommand: { text: "npm run dev" },
  lastCommand: { text: "ls", exitCode: 0, durationMs: 12 },
  sessionId: `session-of-${id}`,
  ...extra,
});

/** A space with a pinned tab, a group (one live) and a split tab, full of what must stay out. */
function sampleSpace(): Space {
  const split: Space["items"][string] = {
    id: "item-split",
    title: "dev server",
    titleLocked: true,
    layout: {
      kind: "split",
      dir: "row",
      sizes: [40, 60],
      children: [
        { kind: "pane", pane: terminal("pane-a") },
        { kind: "pane", pane: terminal("pane-b", { profileId: "dev-shell", cwd: "/srv/app" }) },
      ],
    },
    focusedPaneId: "pane-b",
    zoomedPaneId: "pane-a",
    origin: { cwd: "C:\\work\\app", profileId: "pwsh", command: "npm run dev" },
    lastActivityAt: 123456,
  };
  return {
    id: "space-1",
    name: "Work",
    icon: "rocket",
    color: "#e06c75",
    themeId: "noren-dusk",
    background: { image: "C:\\Users\\me\\sky.png", opacity: 0.5 },
    modIds: ["tweaks.css"],
    defaults: {
      profileId: "dev-shell",
      cwd: "C:\\work",
      env: { EDITOR: "vim", LANG: "en_US.UTF-8" },
      gitIdentity: { name: "Ada", email: "ada@example.com" },
    },
    aiEnabled: false,
    saveScrollback: false,
    pinned: ["item-docs"],
    tree: [
      { kind: "item", id: "item-split" },
      {
        kind: "group",
        id: "group-1",
        name: "Trees",
        color: "teal",
        collapsed: true,
        live: { source: "worktrees", folder: "C:\\work\\app" },
        children: [{ kind: "item", id: "item-tree" }],
      },
    ],
    items: {
      "item-docs": {
        id: "item-docs",
        titleLocked: false,
        title: "title from a program",
        layout: {
          kind: "pane",
          pane: {
            id: "pane-docs",
            type: "browser",
            profileId: "default",
            url: "https://example.com/docs",
            status: "idle",
            unread: false,
            bell: false,
          },
        },
        focusedPaneId: "pane-docs",
        lastActivityAt: 5,
      },
      "item-split": split,
      "item-tree": {
        id: "item-tree",
        titleLocked: false,
        layout: { kind: "pane", pane: terminal("pane-tree") },
        focusedPaneId: "pane-tree",
        liveKey: "C:\\work\\app-feature",
        lastActivityAt: 9,
      },
    },
    activeItemId: "item-split",
  };
}

const devShell: UserProfile = {
  id: "dev-shell",
  name: "Dev shell",
  program: "pwsh.exe",
  args: ["-NoLogo"],
};
const otherShell: UserProfile = { id: "other", name: "Other", program: "bash" };

function exported(space: Space, profiles: readonly UserProfile[] = [devShell, otherShell]) {
  const made = exportSpace(space, { profiles });
  if (!made.ok) throw new Error(made.error);
  return made;
}

/** A parsed copy of a valid file, for a test to spoil. */
function fileOf(space: Space = sampleSpace()): Loose {
  return JSON.parse(exported(space).text) as Loose;
}

const everyId = (ws: Workspace): Id[] =>
  ws.spaces.flatMap((space) => [
    space.id,
    ...Object.keys(space.items),
    ...treeGroups(space.tree).map((group) => group.id),
    ...Object.values(space.items).flatMap((item) =>
      layoutPanes(item.layout).map((pane) => pane.id),
    ),
  ]);

/** The workspace's own ids first, so the reducer meets a collision on every id it asks for. */
function collidingIds(ws: Workspace): () => Id {
  const queue = everyId(ws);
  let next = 1;
  return () => queue.shift() ?? `n${next++}`;
}

function workspaceOf(...spaces: Space[]): Workspace {
  const first = spaces[0];
  if (first === undefined) throw new Error("a workspace needs a space");
  return {
    version: 2,
    spaces,
    activeSpaceId: first.id,
    favorites: [],
    closed: [],
    archive: [],
  };
}

describe("exportSpace", () => {
  it("writes what a space is and none of what only means something on this run", () => {
    const { file, text } = exported(sampleSpace());
    expect(file.format).toBe("noren-space");
    expect(file.version).toBe(1);
    expect(file.space).toMatchObject({
      name: "Work",
      icon: "rocket",
      color: "#e06c75",
      themeId: "noren-dusk",
      modIds: ["tweaks.css"],
      aiEnabled: false,
      saveScrollback: false,
      defaults: {
        profileId: "dev-shell",
        cwd: "C:\\work",
        env: { EDITOR: "vim", LANG: "en_US.UTF-8" },
        gitIdentity: { name: "Ada", email: "ada@example.com" },
      },
      pinned: ["i1"],
    });
    const split = file.space.items.find((item) => item.title === "dev server");
    expect(split).toMatchObject({
      origin: { cwd: "C:\\work\\app", profileId: "pwsh", command: "npm run dev" },
      layout: { kind: "split", dir: "row", sizes: [40, 60] },
    });
    // The group, live, with the tab inside it and the key of its entry.
    expect(file.space.tree[1]).toMatchObject({
      kind: "group",
      name: "Trees",
      collapsed: true,
      live: { source: "worktrees", folder: "C:\\work\\app" },
    });
    expect(file.space.items.some((item) => item.liveKey === "C:\\work\\app-feature")).toBe(true);
    // A title a program asked for is not kept; a title the user locked is.
    expect(text).not.toContain("title from a program");
    expect(text).toContain("dev server");
    // Nothing that belongs to this run or to this computer.
    for (const left of [
      "session-of",
      "gitBranch",
      "unread",
      "bell",
      "scrollbackRef",
      "sb-1.bin",
      "lastCommand",
      "runningCommand",
      "lastActivityAt",
      "zoomed",
      "sky.png",
      "background",
      "status",
    ]) {
      expect(text, left).not.toContain(left);
    }
    expect(text.endsWith("\n")).toBe(true);
  });

  it("numbers its own ids in the order it meets them, never the ones of the workspace", () => {
    const { file, text } = exported(sampleSpace());
    expect(file.space.items.map((item) => item.id)).toEqual(["i1", "i2", "i3"]);
    expect(file.space.activeItemId).toBe("i2");
    for (const id of ["space-1", "item-docs", "item-split", "group-1", "pane-a", "pane-docs"]) {
      expect(text).not.toContain(`"${id}"`);
    }
  });

  it("includes the profiles the space uses and no other", () => {
    expect(exported(sampleSpace()).file.profiles).toEqual([devShell]);
    expect(exported(sampleSpace(), []).file.profiles).toEqual([]);
    const usesBoth = sampleSpace();
    usesBoth.defaults = { ...usesBoth.defaults, profileId: "other" };
    expect(exported(usesBoth).file.profiles).toEqual([devShell, otherShell]);
  });

  it("is checked as an import would check it, so a broken space is not exported", () => {
    const broken = sampleSpace();
    broken.items["item-split"] = { ...must(broken.items["item-split"]), focusedPaneId: "gone" };
    expect(exportSpace(broken)).toEqual({
      ok: false,
      error: "the focused pane of item item-split is not in the item",
    });
    const missing = sampleSpace();
    missing.pinned = ["not-there"];
    expect(exportSpace(missing)).toMatchObject({ ok: false });
    const twice = sampleSpace();
    twice.pinned = ["item-tree"];
    expect(exportSpace(twice)).toMatchObject({
      ok: false,
      error: expect.stringContaining("twice"),
    });
  });
});

describe("secrets", () => {
  it("drops an environment variable whose name says secret, and lists the name", () => {
    const space = sampleSpace();
    space.defaults = {
      ...space.defaults,
      env: {
        EDITOR: "vim",
        GITHUB_TOKEN: "plain",
        db_password: "plain",
        MY_SECRET: "plain",
        OPENAI_API_KEY: "plain",
        AWS_SECRET_ACCESS_KEY: "plain",
        AUTH_APIKEY: "plain",
      },
    };
    const { file, text, removed } = exported(space);
    expect(file.space.defaults.env).toEqual({ EDITOR: "vim" });
    expect(removed.env.toSorted()).toEqual(
      [
        "AUTH_APIKEY",
        "AWS_SECRET_ACCESS_KEY",
        "GITHUB_TOKEN",
        "MY_SECRET",
        "OPENAI_API_KEY",
        "db_password",
      ].toSorted(),
    );
    expect(text).not.toContain("plain");
  });

  it("drops a variable whose value redactSecrets would change, whatever its name", () => {
    const space = sampleSpace();
    space.defaults = {
      ...space.defaults,
      env: {
        EDITOR: "vim",
        DEPLOY_HOOK: GITHUB,
        BUILD_ID: SK,
        REGION_KEY: AWS,
        DATABASE_URL: URL_PASSWORD,
      },
    };
    const { file, text, removed } = exported(space);
    expect(file.space.defaults.env).toEqual({ EDITOR: "vim" });
    expect(removed.env.toSorted()).toEqual(
      ["BUILD_ID", "DATABASE_URL", "DEPLOY_HOOK", "REGION_KEY"].toSorted(),
    );
    for (const secret of [GITHUB, SK, AWS, "hunter2hunter2"]) expect(text).not.toContain(secret);
  });

  it("keeps variables that are not secrets", () => {
    expect(looksSecret("EDITOR", "vim")).toBe(false);
    expect(looksSecret("PATH", "C:\\bin;D:\\tools")).toBe(false);
    expect(looksSecret("GIT_AUTHOR_NAME", "Ada Lovelace")).toBe(false);
    expect(withoutSecretEnv({ A: "1", B_TOKEN: "2" })).toEqual({
      env: { A: "1" },
      removed: ["B_TOKEN"],
    });
  });

  it("drops the command an origin returns to when it holds a secret, and says which tab", () => {
    const space = sampleSpace();
    space.items["item-split"] = {
      ...must(space.items["item-split"]),
      origin: { cwd: "C:\\work", profileId: "pwsh", command: `deploy --token=${GITHUB}` },
    };
    const { file, text, removed } = exported(space);
    expect(text).not.toContain(GITHUB);
    const tab = file.space.items.find((item) => item.title === "dev server");
    expect(tab?.origin).toEqual({ cwd: "C:\\work", profileId: "pwsh" });
    expect(removed.commands).toEqual([tab?.id]);
  });

  it("leaves out a profile that runs something holding a secret, and says so", () => {
    const leaky: UserProfile = {
      id: "dev-shell",
      name: "Leaky",
      program: "tool",
      args: ["--password", "x", `--key=${SK}`],
    };
    const { file, text, removed } = exported(sampleSpace(), [leaky]);
    expect(file.profiles).toEqual([]);
    expect(removed.profiles).toEqual(["dev-shell"]);
    expect(text).not.toContain(SK);
  });

  it("refuses to export a page address that holds a secret", () => {
    const space = sampleSpace();
    const docs = must(space.items["item-docs"]);
    space.items["item-docs"] = {
      ...docs,
      layout: {
        kind: "pane",
        pane: {
          ...terminal("pane-docs"),
          type: "browser",
          url: `https://example.com/?token=${GITHUB}`,
        },
      },
    };
    const made = exportSpace(space);
    expect(made.ok).toBe(false);
    expect(JSON.stringify(made)).not.toContain(GITHUB);
  });

  it("never writes a secret that was put in the environment of a space (property)", () => {
    const names = fc.constantFrom(
      "API_TOKEN",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "client_secret",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "STRIPE_APIKEY",
    );
    const values = fc.stringMatching(/^[A-Za-z0-9]{20,40}$/);
    const odd = fc.constantFrom("EDITOR", "LANG", "BUILD", "HOOK_URL", "REGION");
    fc.assert(
      fc.property(
        fc.array(fc.tuple(names, values), { minLength: 1, maxLength: 4 }),
        fc.array(fc.tuple(odd, fc.constantFrom(GITHUB, SK, AWS, URL_PASSWORD)), { maxLength: 3 }),
        fc.array(fc.tuple(odd, fc.stringMatching(/^[a-z]{1,8}$/)), { maxLength: 3 }),
        (byName, byValue, harmless) => {
          const space = sampleSpace();
          const env = Object.fromEntries([...harmless, ...byValue, ...byName]);
          space.defaults = { ...space.defaults, env };
          const { text, file } = exported(space);
          for (const [, value] of [...byName, ...byValue]) expect(text).not.toContain(value);
          expect(text).not.toContain("hunter2hunter2");
          for (const [name] of byName) expect(file.space.defaults.env).not.toHaveProperty(name);
          // A harmless variable stays, unless a secret took its name.
          const taken = new Set<string>([...byName, ...byValue].map(([name]) => name));
          // (the last of two with the same name is the one the space holds)
          for (const [name, value] of Object.entries(Object.fromEntries(harmless))) {
            if (!taken.has(name)) expect(file.space.defaults.env[name]).toBe(value);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("parseSpaceFile", () => {
  it("reads what exportSpace wrote", () => {
    const made = exported(sampleSpace());
    expect(parseSpaceFile(made.text)).toEqual({ ok: true, file: made.file });
  });

  it("reads a text with a byte order mark", () => {
    expect(parseSpaceFile(`\uFEFF${exported(sampleSpace()).text}`).ok).toBe(true);
  });

  const refused: [string, (file: Loose) => void, RegExp][] = [
    [
      "a version it does not read",
      (f) => (f["version"] = 2),
      /version 2 is not one this build reads/,
    ],
    ["no version", (f) => delete f["version"], /version undefined is not one/],
    ["another format", (f) => (f["format"] = "other"), /not a Noren space file/],
    ["a field the format does not have", (f) => (f["extra"] = 1), /extra/],
    ["a field the space does not have", (f) => (f["space"].extra = 1), /extra/],
    [
      "a field a pane does not have",
      (f) => (f["space"].items[0].layout.pane.sessionId = "s1"),
      /sessionId/,
    ],
    [
      "the background of a space",
      (f) => (f["space"].background = { image: "C:\\a.png" }),
      /background/,
    ],
    ["a blank name", (f) => (f["space"].name = "  "), /name/],
    ["a name that is not text", (f) => (f["space"].name = 4), /name/],
    [
      "an item id used twice",
      (f) => (f["space"].items[1].id = f["space"].items[0].id),
      /"i1" is used more than once/,
    ],
    [
      "a group id that is an item id",
      (f) => (f["space"].tree[1].id = f["space"].items[0].id),
      /is used more than once/,
    ],
    [
      "a pane id used by two tabs",
      (f) => (f["space"].items[2].layout.pane.id = f["space"].items[0].layout.pane.id),
      /is used more than once/,
    ],
    [
      "split sizes that do not make 100",
      (f) => (f["space"].items[1].layout.sizes = [40, 40]),
      /sum to 80, not 100/,
    ],
    [
      "split sizes of the wrong count",
      (f) => (f["space"].items[1].layout.sizes = [100]),
      /1 sizes/,
    ],
    [
      "a split with one child",
      (f) => (
        f["space"].items[1].layout.children.pop(),
        (f["space"].items[1].layout.sizes = [100])
      ),
      /at least 2/,
    ],
    [
      "a focused pane that is not in the tab",
      (f) => (f["space"].items[1].focusedPaneId = "p99"),
      /focused pane p99/,
    ],
    [
      "a tab the tree names but the file lacks",
      (f) => f["space"].pinned.push("i99"),
      /i99 is not an item/,
    ],
    [
      "a tab nobody places",
      (f) => f["space"].pinned.splice(0, 1),
      /neither pinned nor in the tree/,
    ],
    ["a tab placed twice", (f) => f["space"].pinned.push("i2"), /appears 2 times/],
    [
      "an active tab that is not in the space",
      (f) => (f["space"].activeItemId = "i99"),
      /active item i99/,
    ],
    [
      "a browser pane with a page it cannot show",
      (f) => (f["space"].items[0].layout.pane.url = "file:///C:/x"),
      /no usable address/,
    ],
    [
      "a browser pane with no page",
      (f) => delete f["space"].items[0].layout.pane.url,
      /no usable address/,
    ],
    [
      "a page on a terminal",
      (f) => (f["space"].items[2].layout.pane.url = "https://example.com/"),
      /has an address/,
    ],
    [
      "a preview pane with a relative path",
      (f) =>
        Object.assign(f["space"].items[0].layout.pane, {
          type: "preview",
          url: undefined,
          path: "a.md",
        }),
      /no usable path/,
    ],
    [
      "a group nested too deep",
      (f) => {
        const inner = {
          kind: "group",
          id: "g8",
          name: "c",
          color: "red",
          collapsed: false,
          children: [],
        };
        const mid = {
          kind: "group",
          id: "g9",
          name: "b",
          color: "red",
          collapsed: false,
          children: [inner],
        };
        f["space"].tree[1].children.push(mid);
      },
      /depth 3, max 2/,
    ],
    [
      "a live group with no folder",
      (f) => (f["space"].tree[1].live = { source: "worktrees", folder: " " }),
      /live on nothing usable/,
    ],
    [
      "a live source that does not exist",
      (f) => (f["space"].tree[1].live = { source: "ftp" }),
      /tree/,
    ],
    ["a mod that is a path", (f) => (f["space"].modIds = ["../x.css"]), /modIds/],
    ["a mod listed twice", (f) => (f["space"].modIds = ["a.css", "a.css"]), /listed twice/],
    [
      "a variable with a name that cannot be one",
      (f) => (f["space"].defaults.env = { "A=B": "x" }),
      /cannot be one/,
    ],
    ["an id with a space", (f) => (f["space"].items[0].id = "a b"), /an id must be/],
    ["a profile that is not valid", (f) => (f["profiles"][0].program = ""), /program/],
    ["a reserved profile id", (f) => (f["profiles"][0].id = "default"), /reserved/],
    [
      "a profile listed twice",
      (f) => f["profiles"].push({ ...f["profiles"][0] }),
      /used by another profile/,
    ],
    [
      "too many panes in a tab",
      (f) => {
        const pane = (id: string) => ({
          kind: "pane",
          pane: { id, type: "terminal", profileId: "pwsh" },
        });
        f["space"].items[1].layout = {
          kind: "split",
          dir: "row",
          sizes: [12, 11, 11, 11, 11, 11, 11, 11, 11],
          children: ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(pane),
        };
        f["space"].items[1].focusedPaneId = "a";
      },
      /9 panes, max 8/,
    ],
  ];

  it.each(refused)("refuses %s, with a reason and without throwing", (_name, spoil, reason) => {
    const file = fileOf();
    spoil(file);
    const parsed = parseSpaceFile(JSON.stringify(file));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(reason);
      expect(parsed.error.length).toBeLessThan(300);
    }
  });

  it("refuses text that is not JSON, not an object, or too big or deep", () => {
    expect(parseSpaceFile("")).toEqual({ ok: false, error: "it is not valid JSON" });
    expect(parseSpaceFile("{ nope")).toEqual({ ok: false, error: "it is not valid JSON" });
    expect(parseSpaceFile("[]")).toEqual({ ok: false, error: "it is not a Noren space file" });
    expect(parseSpaceFile("null")).toEqual({ ok: false, error: "it is not a Noren space file" });
    expect(parseSpaceFile(`"${"x".repeat(SPACE_FILE_LIMITS.bytes)}"`)).toEqual({
      ok: false,
      error: "the file is larger than 1024 KiB",
    });
    // Few characters, more bytes than the limit.
    expect(parseSpaceFile("é".repeat(SPACE_FILE_LIMITS.bytes / 2 + 1))).toMatchObject({
      ok: false,
      error: "the file is larger than 1024 KiB",
    });
    expect(parseSpaceFile("[".repeat(100_000))).toEqual({
      ok: false,
      error: "the file is nested too deep",
    });
    expect(parseSpaceFile(null as unknown as string)).toEqual({
      ok: false,
      error: "it is not text",
    });
  });

  it("refuses a space with more items than the limit", () => {
    const file = fileOf();
    const item = file["space"].items[2];
    file["space"].items = Array.from({ length: SPACE_FILE_LIMITS.items + 1 }, (_, n) => ({
      ...item,
      id: `t${n}`,
      layout: { kind: "pane", pane: { ...item.layout.pane, id: `q${n}` } },
      focusedPaneId: `q${n}`,
    }));
    expect(parseSpaceFile(JSON.stringify(file)).ok).toBe(false);
  });

  it("never throws, whatever it is given (property)", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc.anything().map((v) => JSON.stringify(v)),
        ),
        (text) => {
          const parsed = parseSpaceFile(text);
          expect(parsed.ok).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(validateSpaceFile(value).ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

describe("space/import", () => {
  const action = (file: SpaceFile, extra: Partial<Action> = {}): Action =>
    ({ type: "space/import", file, ...extra }) as Action;

  it("adds the space at the end with fresh ids, no session and the clock as its date", () => {
    const space = sampleSpace();
    const ws = workspaceOf(space);
    const { ctx } = testContext();
    const next = reduceStrict(deepFreeze(ws), action(exported(space).file), ctx);
    expect(next.spaces).toHaveLength(2);
    const added = must(next.spaces[1]);
    expect(added.id).not.toBe(space.id);
    expect(next.activeSpaceId).toBe(added.id);
    expect(checkInvariants(next)).toEqual([]);
    expect(everyId(next)).toHaveLength(new Set(everyId(next)).size);
    for (const item of Object.values(added.items)) {
      expect(item.lastActivityAt).toBe(1000);
      for (const pane of layoutPanes(item.layout)) {
        expect(pane).toMatchObject({ status: "idle", unread: false, bell: false });
        expect(pane.sessionId).toBeUndefined();
      }
    }
    expect(added.background).toBeUndefined();
    expect(added.items[added.activeItemId ?? ""]?.title).toBe("dev server");
    expect(added.items[added.activeItemId ?? ""]?.titleLocked).toBe(true);
  });

  it("keeps the active space when asked not to activate", () => {
    const space = sampleSpace();
    const next = reduce(
      workspaceOf(space),
      action(exported(space).file, { activate: false }),
      testContext().ctx,
    );
    expect(next.spaces).toHaveLength(2);
    expect(next.activeSpaceId).toBe(space.id);
  });

  it("makes a new space each time, importing the same file twice", () => {
    const space = sampleSpace();
    const file = exported(space).file;
    const { ctx } = testContext();
    let ws = workspaceOf(space);
    ws = reduceStrict(ws, action(file), ctx);
    ws = reduceStrict(ws, action(file), ctx);
    expect(ws.spaces).toHaveLength(3);
    expect(checkInvariants(ws)).toEqual([]);
    expect(new Set(everyId(ws)).size).toBe(everyId(ws).length);
  });

  it("changes nothing for a file that is not valid, or has a tab over maxPanes", () => {
    const space = sampleSpace();
    const ws = workspaceOf(space);
    const file = exported(space).file;
    const { ctx } = testContext();
    const spoiled = { ...file, version: 2 } as unknown as SpaceFile;
    expect(reduce(ws, action(spoiled), ctx)).toBe(ws);
    expect(reduce(ws, action({ ...file, extra: 1 } as unknown as SpaceFile), ctx)).toBe(ws);
    expect(reduce(ws, action(null as unknown as SpaceFile), ctx)).toBe(ws);
    expect(reduce(ws, action(file), { ...ctx, maxPanes: 1 })).toBe(ws);
    expect(reduce(ws, action(file), { ...ctx, maxPanes: 2 })).not.toBe(ws);
  });

  it("skips ids the workspace already has when the generator hands them out", () => {
    const space = sampleSpace();
    const ws = workspaceOf(space);
    const { ctx } = testContext();
    const next = reduceStrict(ws, action(exported(space).file), {
      ...ctx,
      newId: collidingIds(ws),
    });
    expect(next).not.toBe(ws);
    expect(checkInvariants(next)).toEqual([]);
  });

  it("gives back the same file after export, import and export (property)", () => {
    const mods = ["a.css", "b.css", "c.css"];
    const tidy = (space: Space): Space => {
      const fixNodes = (nodes: Node[]): Node[] =>
        nodes.map((node) =>
          node.kind === "group"
            ? {
                ...node,
                name: node.name.trim() === "" ? "Group" : node.name,
                children: fixNodes(node.children),
              }
            : node,
        );
      return {
        ...space,
        name: space.name.trim() === "" ? "Space" : space.name,
        modIds: space.modIds.map((_, index) => mods[index] ?? "d.css"),
        // A space with tabs always shows one; the import settles it, so the file must say it.
        ...(space.activeItemId === undefined && Object.keys(space.items).length > 0
          ? { activeItemId: Object.keys(space.items)[0] }
          : {}),
        tree: fixNodes(space.tree),
      };
    };
    let compared = 0;
    fc.assert(
      fc.property(
        arbWorkspace({ browserPanes: true, previewPanes: true, diffPanes: true }),
        (ws) => {
          for (const original of ws.spaces) {
            const first = exportSpace(tidy(original));
            if (!first.ok)
              throw new Error(`a space of the arbitrary did not export: ${first.error}`);
            const parsed = parseSpaceFile(first.text, Number.POSITIVE_INFINITY);
            expect(parsed).toEqual({ ok: true, file: first.file });
            const { ctx } = testContext();
            const next = reduceStrict(deepFreeze(ws), action(first.file), {
              ...ctx,
              newId: collidingIds(ws),
              maxPanes: DEFAULT_MAX_PANES,
            });
            expect(next).not.toBe(ws);
            expect(checkInvariants(next)).toEqual([]);
            const added = must(next.spaces.at(-1));
            const second = exportSpace(added);
            expect(second.ok && second.text).toBe(first.text);
            // Same shape, new ids: nothing of the original survives.
            const before = new Set(everyId(ws));
            expect(
              [
                added.id,
                ...Object.keys(added.items),
                ...treeGroups(added.tree).map((g) => g.id),
              ].some((id) => before.has(id)),
            ).toBe(false);
            compared++;
          }
        },
      ),
      { numRuns: 100 },
    );
    expect(compared).toBeGreaterThan(100);
  });
});

describe("spaceFromFile", () => {
  it("gives the same new id to the same id of the file, so the references hold", () => {
    const file = exported(sampleSpace()).file;
    let n = 0;
    const made = spaceFromFile(file, () => `x${++n}`, 7);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const space = made.space;
    expect(space.id).toBe("x1");
    for (const id of space.pinned) expect(space.items[id]).toBeDefined();
    expect(space.items[space.activeItemId ?? ""]).toBeDefined();
    for (const item of Object.values(space.items)) {
      expect(layoutPanes(item.layout).map((pane) => pane.id)).toContain(item.focusedPaneId);
      expect(item.lastActivityAt).toBe(7);
    }
  });

  it("refuses a file the schema does not accept, whatever the caller thinks it is", () => {
    const file = exported(sampleSpace()).file;
    const bad = { ...file, space: { ...file.space, items: [] } } as SpaceFile;
    expect(spaceFromFile(bad, () => "x", 0)).toMatchObject({ ok: false });
  });
});

describe("planProfiles", () => {
  const file = (): SpaceFile => exported(sampleSpace(), [devShell, otherShell]).file;

  it("adds a profile nobody has", () => {
    expect(planProfiles(file(), [])).toEqual({ add: [devShell], reused: [], conflicts: [] });
  });

  it("reuses a profile you have that is the same, whatever the order of its keys or the kind", () => {
    const mine: UserProfile = {
      kind: "shell",
      args: ["-NoLogo"],
      program: "pwsh.exe",
      name: "Dev shell",
      id: "dev-shell",
    };
    expect(planProfiles(file(), [mine])).toEqual({ add: [], reused: ["dev-shell"], conflicts: [] });
  });

  it("reports a profile you have that is different, and never replaces it", () => {
    const mine: UserProfile = { ...devShell, program: "cmd.exe" };
    expect(planProfiles(file(), [mine])).toEqual({
      add: [],
      reused: [],
      conflicts: [{ id: "dev-shell", name: "Dev shell", reason: "different" }],
    });
  });

  it("reports a profile whose id is a shell of the machine", () => {
    expect(planProfiles(file(), [], ["dev-shell", "pwsh"])).toEqual({
      add: [],
      reused: [],
      conflicts: [{ id: "dev-shell", name: "Dev shell", reason: "taken" }],
    });
  });
});
