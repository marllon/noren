import { describe, expect, it, vi } from "vitest";
import type { Action } from "./actions";
import type { ApiHost } from "./api-dispatch";
import { createDefaultWorkspace } from "./default-workspace";
import { FakeBackend } from "./fake-backend";
import { createSequentialIds } from "./ids";
import {
  PLUGIN_API_VERSION,
  PLUGIN_LIMITS,
  PLUGIN_METHODS,
  PLUGIN_PERMISSIONS,
  createPluginBroker,
  parsePluginManifest,
} from "./plugins";
import type { PluginManifest, PluginPermission, PluginResponse } from "./plugins";
import { layoutPanes } from "./sessions";
import { TerminalTail } from "./terminal-tail";
import { applyChecked, testContext } from "./test-helpers";
import type { Id, LayoutNode, Workspace } from "./types";

// The manifest and the broker of a plugin (NOR-F18-01a): the manifest as the file is read, and the
// broker over a host made of the real reducer and a `FakeBackend`.

const manifestOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "hello-tabs",
  name: "Hello tabs",
  version: "1.0.0",
  apiVersion: 1,
  main: "main.js",
  permissions: ["terminal.read", "tabs.create"],
  ...over,
});

const errorsOf = (value: unknown): string[] => {
  const parsed = parsePluginManifest(value);
  if (parsed.ok) throw new Error(`expected errors, got ${JSON.stringify(parsed.manifest)}`);
  return parsed.errors;
};

describe("the manifest of a plugin", () => {
  it("accepts a plugin that names every field and asks for each permission", () => {
    const parsed = parsePluginManifest(manifestOf({ permissions: [...PLUGIN_PERMISSIONS] }));
    expect(parsed).toEqual({
      ok: true,
      manifest: manifestOf({ permissions: [...PLUGIN_PERMISSIONS] }),
    });
  });

  it("accepts a plugin that asks for nothing and a main inside a folder", () => {
    expect(parsePluginManifest(manifestOf({ permissions: [] })).ok).toBe(true);
    expect(parsePluginManifest(manifestOf({ main: "dist/index.js" })).ok).toBe(true);
    expect(parsePluginManifest(manifestOf({ main: "./main.js" })).ok).toBe(true);
    expect(parsePluginManifest(manifestOf({ main: "dist\\index.js" })).ok).toBe(true);
    expect(parsePluginManifest(manifestOf({ version: "0.1.0-beta.2" })).ok).toBe(true);
  });

  it.each([
    ["an upper case letter", "Hello"],
    ["a space", "hello tabs"],
    ["an underscore", "hello_tabs"],
    ["a dot", "hello.tabs"],
    ["a slash", "a/b"],
    ["nothing", ""],
    ["more than 32 characters", "a".repeat(PLUGIN_LIMITS.idChars + 1)],
    ["not text", 7],
  ])("refuses an id with %s", (_, id) => {
    const errors = errorsOf(manifestOf({ id }));
    expect(errors.some((e) => e.startsWith("id:"))).toBe(true);
  });

  it("accepts an id of 32 characters", () => {
    expect(parsePluginManifest(manifestOf({ id: "a".repeat(PLUGIN_LIMITS.idChars) })).ok).toBe(
      true,
    );
  });

  it.each([2, 0, "1", null, 1.5])("refuses the API version %j", (apiVersion) => {
    const errors = errorsOf(manifestOf({ apiVersion }));
    expect(errors.some((e) => e.startsWith("apiVersion:"))).toBe(true);
  });

  it("refuses a manifest without an API version", () => {
    const rest = manifestOf();
    delete rest["apiVersion"];
    expect(errorsOf(rest).some((e) => e.startsWith("apiVersion:"))).toBe(true);
  });

  it.each([
    ["a .. segment", "../main.js"],
    ["a .. in the middle", "dist/../../main.js"],
    ["a .. with backslashes", "dist\\..\\..\\main.js"],
    ["only ..", ".."],
    ["a root slash", "/etc/main.js"],
    ["a root backslash", "\\main.js"],
    ["a drive", "C:\\plugins\\main.js"],
    ["a drive and a slash", "c:/main.js"],
    ["a drive with no slash", "C:main.js"],
    ["a network path", "\\\\server\\share\\main.js"],
    ["a control character", "main\u0000.js"],
    ["nothing", ""],
    ["not text", 3],
  ])("refuses a main with %s", (_, main) => {
    const errors = errorsOf(manifestOf({ main }));
    expect(errors.some((e) => e.startsWith("main:"))).toBe(true);
  });

  it("refuses a permission that does not exist and names which one", () => {
    const errors = errorsOf(manifestOf({ permissions: ["terminal.read", "files.write"] }));
    expect(errors.some((e) => e.startsWith("permissions.1:"))).toBe(true);
  });

  it("refuses a permission listed twice and names the second one", () => {
    const errors = errorsOf(manifestOf({ permissions: ["tabs.create", "panel", "tabs.create"] }));
    expect(errors).toEqual(["permissions.2: permission tabs.create is listed twice"]);
  });

  it("refuses permissions that are not a list", () => {
    expect(errorsOf(manifestOf({ permissions: "terminal.read" }))[0]).toMatch(/^permissions:/);
  });

  it("refuses a field the manifest does not have", () => {
    expect(errorsOf(manifestOf({ homepage: "x" })).length).toBeGreaterThan(0);
  });

  it.each([null, "plugin", 3, []])("refuses %j as a manifest", (value) => {
    expect(parsePluginManifest(value).ok).toBe(false);
  });

  it("refuses a name that is blank and a version that is not three numbers", () => {
    expect(errorsOf(manifestOf({ name: "   " })).some((e) => e.startsWith("name:"))).toBe(true);
    expect(errorsOf(manifestOf({ version: "1.0" })).some((e) => e.startsWith("version:"))).toBe(
      true,
    );
  });

  it("lists every problem at once, each with the field it is in", () => {
    const errors = errorsOf(manifestOf({ id: "X", main: "/abs", permissions: ["nope"] }));
    expect(errors.map((e) => e.split(":")[0])).toEqual(["id", "main", "permissions.0"]);
  });
});

// A host over the real reducer and a FakeBackend, with every member watched.
interface Rig {
  host: ApiHost;
  backend: FakeBackend;
  tail: TerminalTail;
  workspace(): Workspace;
  calls: { dispatch: number; workspace: number; attach: number; readLines: number };
}

function rig(): Rig {
  let ws = createDefaultWorkspace({ newId: createSequentialIds("w") });
  const { ctx } = testContext();
  const backend = new FakeBackend({ profiles: [{ id: "fake", name: "Fake", default: true }] });
  const tail = new TerminalTail();
  const calls = { dispatch: 0, workspace: 0, attach: 0, readLines: 0 };
  const withSession = (layout: LayoutNode, paneId: Id, sessionId: Id): LayoutNode =>
    layout.kind === "split"
      ? { ...layout, children: layout.children.map((c) => withSession(c, paneId, sessionId)) }
      : layout.pane.id === paneId
        ? { kind: "pane", pane: { ...layout.pane, sessionId } }
        : layout;
  return {
    backend,
    tail,
    calls,
    workspace: () => ws,
    host: {
      workspace: () => {
        calls.workspace += 1;
        return ws;
      },
      dispatch: (action: Action) => {
        calls.dispatch += 1;
        ws = applyChecked(ws, action, ctx);
      },
      attachSession: (paneId, sessionId) => {
        calls.attach += 1;
        ws = {
          ...ws,
          spaces: ws.spaces.map((space) => ({
            ...space,
            items: Object.fromEntries(
              Object.entries(space.items).map(([id, item]) => [
                id,
                { ...item, layout: withSession(item.layout, paneId, sessionId) },
              ]),
            ),
          })),
        };
      },
      backend: {
        createSession: async (o) => {
          const id = await backend.createSession(o);
          backend.onOutput(id, (bytes) => tail.feed(id, bytes));
          return id;
        },
        write: (id, data) => backend.write(id, data),
        kill: (id) => backend.kill(id),
      },
      readLines: (id, count) => {
        calls.readLines += 1;
        return tail.read(id, count);
      },
    },
  };
}

const request = (method: string, params?: unknown, id: string | number = "r1") => ({
  version: PLUGIN_API_VERSION,
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

function broker(permissions: PluginPermission[], r: Rig = rig()) {
  const parsed = parsePluginManifest(manifestOf({ permissions }));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return { r, b: createPluginBroker(parsed.manifest as PluginManifest, r.host) };
}

function resultOf(response: PluginResponse): Record<string, unknown> {
  if (!("result" in response))
    throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  return response.result as Record<string, unknown>;
}

function errorOf(response: PluginResponse) {
  if (!("error" in response)) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  return response.error;
}

/** Whether anything of the host was touched: its members, the backend or the workspace. */
function untouched(r: Rig, before: Workspace): boolean {
  const c = r.calls;
  return (
    c.dispatch === 0 &&
    c.workspace === 0 &&
    c.attach === 0 &&
    c.readLines === 0 &&
    r.backend.callsTo("createSession").length === 0 &&
    r.backend.callsTo("write").length === 0 &&
    r.workspace() === before
  );
}

// What each permission opens, with a request that would be valid if it were held.
const REQUESTS: Record<PluginPermission, { method: string; params: unknown }> = {
  "terminal.read": { method: "terminal.read", params: { terminal: "any" } },
  "tabs.create": { method: "tabs.create", params: {} },
  "palette.actions": { method: "palette.register", params: { id: "go", label: "Go" } },
  panel: { method: "panel.open", params: { title: "Panel" } },
};

describe("the broker: a permission the manifest does not hold", () => {
  it("maps every method to one of the four permissions, and every permission to one method", () => {
    expect(Object.values(PLUGIN_METHODS).sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    expect(Object.keys(REQUESTS).sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
  });

  it.each(PLUGIN_PERMISSIONS)("denies the method of %s without touching the host", async (held) => {
    // A plugin with the other three permissions only.
    const others = PLUGIN_PERMISSIONS.filter((p) => p !== held);
    const { r, b } = broker([...others]);
    const before = r.workspace();
    const { method, params } = REQUESTS[held];
    const response = await b.handle(request(method, params, "denied-1"));
    expect(response).toEqual({
      version: 1,
      id: "denied-1",
      error: {
        code: "permission_denied",
        message: expect.stringContaining(held) as string,
        permission: held,
      },
    });
    expect(untouched(r, before)).toBe(true);
    expect(b.registry.actions()).toEqual([]);
    expect(b.registry.panel()).toBeNull();
  });

  it("denies every method to a plugin that asks for nothing", async () => {
    const { r, b } = broker([]);
    const before = r.workspace();
    for (const permission of PLUGIN_PERMISSIONS) {
      const { method, params } = REQUESTS[permission];
      const error = errorOf(await b.handle(request(method, params)));
      expect(error.code).toBe("permission_denied");
      expect(error.permission).toBe(permission);
    }
    expect(untouched(r, before)).toBe(true);
  });

  it("denies before it looks at the parameters", async () => {
    const { r, b } = broker([]);
    const error = errorOf(await b.handle(request("tabs.create", { nonsense: true })));
    expect(error.code).toBe("permission_denied");
    expect(r.backend.callsTo("createSession")).toHaveLength(0);
  });

  it("holds only what the manifest names: tabs.create does not open terminal.read", async () => {
    const { b } = broker(["tabs.create"]);
    expect(errorOf(await b.handle(request("terminal.read", { terminal: "x" }))).permission).toBe(
      "terminal.read",
    );
  });
});

describe("the broker: a permission the manifest holds", () => {
  it("makes a tab through the host when tabs.create is held", async () => {
    const { r, b } = broker(["tabs.create"]);
    const spaceId = r.workspace().spaces[0]?.id ?? "";
    const tabsBefore = Object.keys(r.workspace().spaces[0]?.items ?? {}).length;
    const response = await b.handle(request("tabs.create", { space: spaceId }, 7));
    const result = resultOf(response);
    expect(response).toMatchObject({ version: 1, id: 7 });
    expect(result).toMatchObject({ space: spaceId });
    expect(typeof result["item"]).toBe("string");
    expect(typeof result["session"]).toBe("string");
    expect(r.backend.callsTo("createSession")).toHaveLength(1);
    expect(Object.keys(r.workspace().spaces[0]?.items ?? {})).toHaveLength(tabsBefore + 1);
    const item = r.workspace().spaces[0]?.items[result["item"] as string];
    expect(item && layoutPanes(item.layout).map((p) => p.id)).toEqual([result["terminal"]]);
  });

  it("makes a tab with no params at all", async () => {
    const { r, b } = broker(["tabs.create"]);
    expect(resultOf(await b.handle(request("tabs.create")))).toHaveProperty("item");
    expect(r.backend.callsTo("createSession")).toHaveLength(1);
  });

  it("reads the terminal through the host when terminal.read is held", async () => {
    const { r, b } = broker(["tabs.create", "terminal.read"]);
    const tab = resultOf(await b.handle(request("tabs.create", { space: "w1" })));
    r.backend.sendOutput(1, "\u001b[32mone\u001b[0m\r\ntwo\r\n");
    const response = await b.handle(request("terminal.read", { terminal: tab["terminal"] }, "rd"));
    expect(response).toEqual({
      version: 1,
      id: "rd",
      result: { terminal: tab["terminal"], lines: ["fake$ one", "two"], truncated: false },
    });
    expect(r.calls.readLines).toBe(1);
  });

  it("gives the errors of the local API for what the host cannot do", async () => {
    const { b } = broker(["tabs.create", "terminal.read"]);
    expect(errorOf(await b.handle(request("terminal.read", { terminal: "nowhere" }))).code).toBe(
      "not_found",
    );
    expect(errorOf(await b.handle(request("tabs.create", { space: "nowhere" }))).code).toBe(
      "not_found",
    );
    expect(
      errorOf(await b.handle(request("terminal.read", { terminal: "x", lines: 0 }))).code,
    ).toBe("invalid_params");
    expect(errorOf(await b.handle(request("tabs.create", { sneaky: 1 }))).code).toBe(
      "invalid_params",
    );
  });

  it("does not let the plugin reach a method of the local API it was not given", async () => {
    const { r, b } = broker([...PLUGIN_PERMISSIONS]);
    const before = r.workspace();
    for (const method of [
      "terminal.send",
      "items.create",
      "spaces.create",
      "notify",
      "spaces.list",
    ]) {
      expect(errorOf(await b.handle(request(method, { name: "x" }))).code).toBe("unknown_method");
    }
    expect(untouched(r, before)).toBe(true);
  });

  it("keeps a palette action in the registry of the plugin and nowhere else", async () => {
    const { r, b } = broker(["palette.actions"]);
    const before = r.workspace();
    const response = await b.handle(request("palette.register", { id: "say-hi", label: "Say hi" }));
    expect(response).toEqual({ version: 1, id: "r1", result: { id: "say-hi" } });
    expect(b.registry.actions()).toEqual([{ id: "say-hi", label: "Say hi" }]);
    expect(untouched(r, before)).toBe(true);
    // The same id again changes the label and keeps one action.
    await b.handle(request("palette.register", { id: "say-hi", label: "Say hello" }));
    await b.handle(request("palette.register", { id: "other", label: "Other" }));
    expect(b.registry.actions()).toEqual([
      { id: "say-hi", label: "Say hello" },
      { id: "other", label: "Other" },
    ]);
    // What the host reads is a copy.
    (b.registry.actions()[0] as { label: string }).label = "changed";
    expect(b.registry.actions()[0]?.label).toBe("Say hello");
  });

  it("holds at most 64 palette actions per plugin", async () => {
    const { b } = broker(["palette.actions"]);
    for (let i = 0; i < PLUGIN_LIMITS.actions; i += 1) {
      resultOf(await b.handle(request("palette.register", { id: `a${i}`, label: `A ${i}` })));
    }
    expect(
      errorOf(await b.handle(request("palette.register", { id: "extra", label: "x" }))).code,
    ).toBe("failed");
    // An id that is already there can still be changed.
    resultOf(await b.handle(request("palette.register", { id: "a0", label: "Again" })));
    expect(b.registry.actions()).toHaveLength(PLUGIN_LIMITS.actions);
  });

  it("keeps the panel asked for in the registry and nowhere else", async () => {
    const { r, b } = broker(["panel"]);
    const before = r.workspace();
    expect(b.registry.panel()).toBeNull();
    const response = await b.handle(request("panel.open", { title: "Notes" }));
    expect(response).toEqual({ version: 1, id: "r1", result: { title: "Notes" } });
    expect(b.registry.panel()).toEqual({ title: "Notes" });
    await b.handle(request("panel.open", { title: "Other" }));
    expect(b.registry.panel()).toEqual({ title: "Other" });
    expect(untouched(r, before)).toBe(true);
  });

  it("keeps the registry of one plugin apart from another's", async () => {
    const r = rig();
    const one = broker(["palette.actions", "panel"], r).b;
    const two = broker(["palette.actions", "panel"], r).b;
    await one.handle(request("palette.register", { id: "a", label: "A" }));
    await one.handle(request("panel.open", { title: "One" }));
    expect(two.registry.actions()).toEqual([]);
    expect(two.registry.panel()).toBeNull();
  });

  it.each([
    ["palette.register", { id: "Bad Id", label: "x" }],
    ["palette.register", { id: "ok", label: "   " }],
    ["palette.register", { id: "ok" }],
    ["palette.register", { id: "ok", label: "x", extra: 1 }],
    ["palette.register", { id: "ok", label: "x".repeat(PLUGIN_LIMITS.labelChars + 1) }],
    ["palette.register", { id: 5, label: "x" }],
    ["palette.register", "text"],
    ["palette.register", undefined],
    ["panel.open", {}],
    ["panel.open", { title: "" }],
    ["panel.open", { title: "a\nb" }],
    ["panel.open", { title: "a", url: "https://example.com" }],
    ["panel.open", [1]],
  ])("answers invalid_params to %s with %j and keeps nothing", async (method, params) => {
    const { b } = broker(["palette.actions", "panel"]);
    expect(errorOf(await b.handle(request(method, params))).code).toBe("invalid_params");
    expect(b.registry.actions()).toEqual([]);
    expect(b.registry.panel()).toBeNull();
  });
});

describe("the broker: the shape of a request", () => {
  it("answers with the id of the request, text or number", async () => {
    const { b } = broker([...PLUGIN_PERMISSIONS]);
    for (const id of [
      "a",
      "x".repeat(PLUGIN_LIMITS.requestIdChars),
      0,
      41,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const ok = await b.handle(request("panel.open", { title: "T" }, id));
      expect(ok.id).toBe(id);
      const denied = await createPluginBroker(
        { ...(manifestOf({ permissions: [] }) as PluginManifest) },
        rig().host,
      ).handle(request("panel.open", { title: "T" }, id));
      expect(denied.id).toBe(id);
      const bad = await b.handle(request("nope", undefined, id));
      expect(bad.id).toBe(id);
    }
  });

  it("answers unsupported_version to any other version, with the id, and does nothing", async () => {
    const { r, b } = broker([...PLUGIN_PERMISSIONS]);
    const before = r.workspace();
    for (const version of [2, 0, -1, 1.5, 99]) {
      const response = await b.handle({ ...request("tabs.create"), version, id: "v" });
      expect(response).toMatchObject({
        version: 1,
        id: "v",
        error: { code: "unsupported_version" },
      });
    }
    for (const version of ["1", null, undefined]) {
      const response = await b.handle({ ...request("tabs.create"), version, id: "v" });
      expect(errorOf(response).code).toBe("unsupported_version");
    }
    const noVersion: Record<string, unknown> = { ...request("tabs.create") };
    delete noVersion["version"];
    expect(errorOf(await b.handle(noVersion)).code).toBe("unsupported_version");
    expect(untouched(r, before)).toBe(true);
  });

  it("looks at the version before the other fields, since a later version may add some", async () => {
    const { b } = broker([...PLUGIN_PERMISSIONS]);
    const response = await b.handle({ version: 2, id: 1, method: "future", novel: true });
    expect(errorOf(response).code).toBe("unsupported_version");
  });

  it("answers unknown_method to a method that is not in the list, whatever the permissions", async () => {
    const { r, b } = broker([...PLUGIN_PERMISSIONS]);
    const before = r.workspace();
    for (const method of ["", "nope", "terminal.write", "toString", "__proto__", "constructor"]) {
      const response = await b.handle(request(method, {}, "m"));
      expect(response).toMatchObject({ id: "m", error: { code: "unknown_method" } });
    }
    expect(untouched(r, before)).toBe(true);
  });

  it("answers invalid_request, with a null id, to what is not a request", async () => {
    const { b } = broker([...PLUGIN_PERMISSIONS]);
    for (const value of [null, undefined, "text", 3, [], true]) {
      expect(await b.handle(value)).toEqual({
        version: 1,
        id: null,
        error: { code: "invalid_request", message: expect.any(String) as string },
      });
    }
  });

  it.each([
    undefined,
    null,
    "",
    "x".repeat(PLUGIN_LIMITS.requestIdChars + 1),
    -1,
    1.5,
    {},
    [],
    NaN,
  ])("answers invalid_request, with a null id, to the id %j", async (id) => {
    const { r, b } = broker([...PLUGIN_PERMISSIONS]);
    const before = r.workspace();
    const response = await b.handle({ version: 1, id, method: "tabs.create" });
    expect(response).toMatchObject({ version: 1, id: null, error: { code: "invalid_request" } });
    expect(untouched(r, before)).toBe(true);
  });

  it("answers invalid_request to a method that is not text and to a field it does not know", async () => {
    const { b } = broker([...PLUGIN_PERMISSIONS]);
    expect(errorOf(await b.handle({ version: 1, id: 1, method: 5 })).code).toBe("invalid_request");
    expect(errorOf(await b.handle({ version: 1, id: 1 })).code).toBe("invalid_request");
    const extra = await b.handle({ ...request("tabs.create", {}, 3), permissions: ["panel"] });
    expect(extra).toMatchObject({ id: 3, error: { code: "invalid_request" } });
  });

  it("never throws or rejects, even when the host does", async () => {
    const r = rig();
    const spy = vi.spyOn(r.host, "workspace").mockImplementation(() => {
      throw new Error("host is down");
    });
    const { b } = broker(["tabs.create"], r);
    const response = await b.handle(request("tabs.create", { space: "w1" }, "boom"));
    expect(response).toMatchObject({ id: "boom", error: { code: "internal" } });
    spy.mockRestore();
    const hostile = {
      get id(): never {
        throw new Error("no");
      },
    };
    expect(errorOf(await b.handle(hostile)).code).toBe("internal");
  });
});
