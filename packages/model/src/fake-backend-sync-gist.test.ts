import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";
import { sha256Hex } from "./sha256";
import { parseSyncGistStatus, parseSyncPull, parseSyncPush } from "./sync";

const TOKEN = "ghp_TestTokenNeverReal0123456789";
const CONFIG = '{ "theme": "lagoon" }\n';
const THEME = '{"id":"lagoon","name":"Lagoon"}';

/** A fake with a token and a few files, connected to a new secret gist. */
async function connected(): Promise<{ backend: FakeBackend; id: string }> {
  const backend = new FakeBackend();
  await backend.syncGistSetToken(TOKEN);
  backend.setSyncLocalFile("config.jsonc", CONFIG);
  backend.setSyncLocalFile("themes/lagoon.json", THEME);
  backend.setSyncLocalFile("mods/tweak.css", ".a { color: red }\n");
  const status = await backend.syncGistConnect();
  if (status.gistId === null) throw new Error("no gist id");
  return { backend, id: status.gistId };
}

describe("FakeBackend sync through a gist: token and status", () => {
  it("starts not connected and without a token", async () => {
    const backend = new FakeBackend();
    expect(await backend.syncGistStatus()).toEqual({
      connected: false,
      gistId: null,
      public: false,
      hasToken: false,
      pending: [],
    });
    await expect(backend.syncGistPull()).rejects.toThrow("no gist is connected");
    await expect(backend.syncGistPush()).rejects.toThrow("no gist is connected");
  });

  it("keeps the token without ever giving it back", async () => {
    const backend = new FakeBackend();
    await backend.syncGistSetToken(`  ${TOKEN}\n`);
    const status = await backend.syncGistStatus();
    expect(status.hasToken).toBe(true);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    // The call is recorded without the token.
    expect(backend.callsTo("syncGistSetToken")).toEqual([{ method: "syncGistSetToken", args: [] }]);
    expect(JSON.stringify(backend.calls)).not.toContain(TOKEN);
    await backend.syncGistClearToken();
    expect((await backend.syncGistStatus()).hasToken).toBe(false);
    await backend.syncGistClearToken();
  });

  it("refuses a token that is not one, with words that do not repeat it", async () => {
    const backend = new FakeBackend();
    for (const bad of ["", "   ", "two words", "ação", "t".repeat(1025)]) {
      const error = await backend.syncGistSetToken(bad).catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("not a usable token");
      if (bad.trim() !== "") expect((error as Error).message).not.toContain(bad.trim());
    }
    expect((await backend.syncGistStatus()).hasToken).toBe(false);
  });

  it("needs a token to connect, pull or push", async () => {
    const backend = new FakeBackend();
    backend.setSyncLocalFile("config.jsonc", CONFIG);
    backend.putSyncGist("abc123", { files: { "config.jsonc": CONFIG } });
    await expect(backend.syncGistConnect("abc123")).rejects.toThrow("no GitHub token");
    await expect(backend.syncGistConnect()).rejects.toThrow("no GitHub token");
    await backend.syncGistSetToken(TOKEN);
    await backend.syncGistConnect("abc123");
    await backend.syncGistClearToken();
    await expect(backend.syncGistPull()).rejects.toThrow("no GitHub token");
    await expect(backend.syncGistPush()).rejects.toThrow("no GitHub token");
  });

  it("answers in the shapes the wire checks accept", async () => {
    const { backend } = await connected();
    expect(parseSyncGistStatus(await backend.syncGistStatus()).ok).toBe(true);
    expect(parseSyncPush(await backend.syncGistPush()).ok).toBe(true);
    backend.putSyncGist("other1", { files: { "themes--new.json": "{}" } });
    await backend.syncGistConnect("other1");
    expect(parseSyncPull(await backend.syncGistPull()).ok).toBe(true);
  });

  it("makes every call reject with the failure it was given", async () => {
    const { backend } = await connected();
    backend.setSyncGistFailure(new Error("the keychain is not available"));
    for (const call of [
      () => backend.syncGistStatus(),
      () => backend.syncGistSetToken(TOKEN),
      () => backend.syncGistClearToken(),
      () => backend.syncGistConnect(),
      () => backend.syncGistPull(),
      () => backend.syncGistPush(),
    ]) {
      await expect(call()).rejects.toThrow("keychain is not available");
    }
    backend.setSyncGistFailure(undefined);
    expect((await backend.syncGistStatus()).connected).toBe(true);
  });
});

describe("FakeBackend sync through a gist: connect", () => {
  it("makes a secret gist of exactly the files that may travel", async () => {
    const backend = new FakeBackend();
    await backend.syncGistSetToken(TOKEN);
    backend.setSyncLocalFile("config.jsonc", CONFIG);
    backend.setSyncLocalFile("spaces/Work.noren-space.json", "{}");
    backend.setSyncLocalFile("state.json", "secret");
    backend.setSyncLocalFile("scrollback/p1.txt", "secret");
    backend.setSyncLocalFile("themes/Bad Id.json", "{}");
    backend.setSyncLocalFile("mods/empty.css", "");
    const status = await backend.syncGistConnect();
    expect(status).toMatchObject({ connected: true, public: false, hasToken: true, pending: [] });
    const id = status.gistId ?? "";
    expect(backend.syncGistIds()).toEqual([id]);
    expect(backend.syncGistFiles(id)).toEqual({
      "config.jsonc": CONFIG,
      "spaces--Work.noren-space.json": "{}",
    });
  });

  it("has nothing to make a gist from when no file may travel", async () => {
    const backend = new FakeBackend();
    await backend.syncGistSetToken(TOKEN);
    backend.setSyncLocalFile("state.json", "x");
    await expect(backend.syncGistConnect()).rejects.toThrow("nothing to send");
    expect(backend.syncGistIds()).toEqual([]);
    expect((await backend.syncGistStatus()).connected).toBe(false);
  });

  it("reads a gist by id, copies nothing, and reports a public one", async () => {
    const backend = new FakeBackend();
    await backend.syncGistSetToken(TOKEN);
    backend.putSyncGist("pub1", { public: true, files: { "config.jsonc": CONFIG } });
    backend.setSyncLocalFile("mods/mine.css", ".m {}\n");
    const status = await backend.syncGistConnect("  pub1 ");
    expect(status).toMatchObject({ connected: true, gistId: "pub1", public: true });
    expect(status.pending).toEqual([{ path: "mods/mine.css", change: "added" }]);
    expect(backend.syncLocalFile("config.jsonc")).toBeUndefined();
  });

  it("refuses an id that is not one, and a gist that is not there", async () => {
    const backend = new FakeBackend();
    await backend.syncGistSetToken(TOKEN);
    for (const bad of ["", "a/b", "../gists", "abc?x=1", "a-b"]) {
      await expect(backend.syncGistConnect(bad), bad).rejects.toThrow("not the id of a gist");
    }
    await expect(backend.syncGistConnect("missing1")).rejects.toThrow("status 404");
    expect((await backend.syncGistStatus()).connected).toBe(false);
  });

  it("keeps what it knows when it connects again to the same gist", async () => {
    const { backend, id } = await connected();
    backend.setSyncLocalFile("config.jsonc", '{ "edited": 1 }\n');
    const again = await backend.syncGistConnect(id);
    expect(again.pending).toEqual([{ path: "config.jsonc", change: "modified" }]);
    backend.putSyncGist("other1", { files: { "config.jsonc": CONFIG } });
    const other = await backend.syncGistConnect("other1");
    expect(other.pending).toHaveLength(3);
  });
});

describe("FakeBackend sync through a gist: push", () => {
  it("sends only what changed, then there is nothing pending", async () => {
    const { backend, id } = await connected();
    backend.setSyncLocalFile("config.jsonc", '{ "theme": "other" }\n');
    backend.setSyncLocalFile("themes/new.json", '{"id":"new"}');
    backend.setSyncLocalFile("state.json", "never");
    expect((await backend.syncGistStatus()).pending).toEqual([
      { path: "config.jsonc", change: "modified" },
      { path: "themes/new.json", change: "added" },
    ]);
    expect(await backend.syncGistPush()).toEqual({
      committed: true,
      pushed: true,
      files: ["config.jsonc", "themes/new.json"],
    });
    expect(backend.syncGistFiles(id)["themes--new.json"]).toBe('{"id":"new"}');
    expect(backend.syncGistFiles(id)["state.json"]).toBeUndefined();
    expect((await backend.syncGistStatus()).pending).toEqual([]);
    expect(await backend.syncGistPush()).toEqual({ committed: false, pushed: false, files: [] });
  });

  it("is refused, sending nothing, when the gist changed since the last sync", async () => {
    const { backend, id } = await connected();
    backend.setSyncLocalFile("config.jsonc", '{ "mine": true }\n');
    backend.setSyncGistFile(id, "themes--lagoon.json", '{"id":"lagoon","v":2}');
    backend.setSyncGistFile(id, "themes--theirs.json", '{"id":"theirs"}');
    await expect(backend.syncGistPush()).rejects.toThrow(
      "pull first, then push again (themes/lagoon.json, themes/theirs.json)",
    );
    expect(backend.syncGistFiles(id)["config.jsonc"]).toBe(CONFIG);
    expect(backend.syncLocalFile("config.jsonc")).toBe('{ "mine": true }\n');
  });

  it("counts a file taken out of the gist as a change, until a pull takes note", async () => {
    const { backend, id } = await connected();
    backend.setSyncGistFile(id, "mods--tweak.css", undefined);
    backend.setSyncLocalFile("config.jsonc", '{ "mine": true }\n');
    await expect(backend.syncGistPush()).rejects.toThrow("mods/tweak.css");
    expect(await backend.syncGistPull()).toEqual({ kind: "up_to_date" });
    expect(backend.syncLocalFile("mods/tweak.css")).toBeDefined();
    const pushed = await backend.syncGistPush();
    expect(pushed.files).toEqual(["config.jsonc", "mods/tweak.css"]);
    expect(backend.syncGistFiles(id)["mods--tweak.css"]).toBeDefined();
  });

  it("leaves the files of someone else in the gist alone, and the first push goes through", async () => {
    const backend = new FakeBackend();
    await backend.syncGistSetToken(TOKEN);
    backend.putSyncGist("notes1", { files: { "README.md": "my notes", "todo.txt": "x" } });
    backend.setSyncLocalFile("config.jsonc", CONFIG);
    await backend.syncGistConnect("notes1");
    expect((await backend.syncGistPush()).pushed).toBe(true);
    expect(Object.keys(backend.syncGistFiles("notes1")).sort()).toEqual([
      "README.md",
      "config.jsonc",
      "todo.txt",
    ]);
  });

  it("refuses the first push to a gist that already has files, until a pull", async () => {
    const backend = new FakeBackend();
    await backend.syncGistSetToken(TOKEN);
    backend.putSyncGist("abc123", { files: { "config.jsonc": '{ "theirs": 1 }\n' } });
    backend.setSyncLocalFile("config.jsonc", CONFIG);
    await backend.syncGistConnect("abc123");
    await expect(backend.syncGistPush()).rejects.toThrow("pull first");
    expect(await backend.syncGistPull()).toEqual({ kind: "conflict", paths: ["config.jsonc"] });
  });

  it("leaves an empty file out and refuses one over the ceiling", async () => {
    const { backend, id } = await connected();
    backend.setSyncLocalFile("mods/empty.css", "");
    backend.setSyncLocalFile("config.jsonc", '{ "a": 1 }\n');
    expect((await backend.syncGistStatus()).pending).toEqual([
      { path: "config.jsonc", change: "modified" },
    ]);
    expect((await backend.syncGistPush()).files).toEqual(["config.jsonc"]);
    expect(backend.syncGistFiles(id)["mods--empty.css"]).toBeUndefined();
    backend.setSyncLocalFile("config.jsonc", "x".repeat(1024 * 1024 + 1));
    await expect(backend.syncGistPush()).rejects.toThrow("larger than 1024 KiB");
  });
});

describe("FakeBackend sync through a gist: pull", () => {
  it("brings the files the gist added or changed, and leaves a local edit alone", async () => {
    const { backend, id } = await connected();
    backend.setSyncLocalFile("config.jsonc", '{ "mine": true }\n');
    backend.setSyncGistFile(id, "themes--lagoon.json", '{"id":"lagoon","v":2}');
    backend.setSyncGistFile(id, "spaces--Work.noren-space.json", "{}");
    expect(await backend.syncGistPull()).toEqual({
      kind: "updated",
      files: ["spaces/Work.noren-space.json", "themes/lagoon.json"],
    });
    expect(backend.syncLocalFile("themes/lagoon.json")).toBe('{"id":"lagoon","v":2}');
    expect(backend.syncLocalFile("config.jsonc")).toBe('{ "mine": true }\n');
    expect(await backend.syncGistPull()).toEqual({ kind: "up_to_date" });
    expect((await backend.syncGistStatus()).pending).toEqual([
      { path: "config.jsonc", change: "modified" },
    ]);
  });

  it("is a conflict that writes nothing at all when a file changed on both sides", async () => {
    const { backend, id } = await connected();
    backend.setSyncLocalFile("config.jsonc", '{ "here": 1 }\n');
    backend.setSyncGistFile(id, "config.jsonc", '{ "there": 2 }\n');
    backend.setSyncGistFile(id, "themes--new.json", '{"id":"new"}');
    backend.setSyncLocalFile("mods/tweak.css", ".local {}\n");
    backend.setSyncGistFile(id, "mods--tweak.css", ".remote {}\n");
    expect(await backend.syncGistPull()).toEqual({
      kind: "conflict",
      paths: ["config.jsonc", "mods/tweak.css"],
    });
    expect(backend.syncLocalFile("config.jsonc")).toBe('{ "here": 1 }\n');
    expect(backend.syncLocalFile("themes/new.json")).toBeUndefined();
    await expect(backend.syncGistPush()).rejects.toThrow("pull first");
    // Settled by hand, the pull goes through.
    backend.setSyncLocalFile("config.jsonc", '{ "there": 2 }\n');
    backend.setSyncGistFile(id, "mods--tweak.css", ".local {}\n");
    expect(await backend.syncGistPull()).toEqual({ kind: "updated", files: ["themes/new.json"] });
    expect((await backend.syncGistStatus()).pending).toEqual([]);
  });

  it("never writes a name of the gist that is off the closed list", async () => {
    const { backend, id } = await connected();
    for (const [name, text] of Object.entries({
      "README.md": "hello",
      "state.json": '{"owned":true}',
      "sync-gist.json": "{}",
      "themes--../../evil.json": "{}",
      "themes--Bad Id.json": "{}",
      "mods--x.js": "alert(1)",
      "plugins--p.js": "alert(2)",
      "themes/lagoon.json": '{"id":"sneaky"}',
    })) {
      backend.setSyncGistFile(id, name, text);
    }
    backend.setSyncGistFile(id, "themes--fine.json", '{"id":"fine"}');
    expect(await backend.syncGistPull()).toEqual({ kind: "updated", files: ["themes/fine.json"] });
    expect(backend.syncLocalFile("state.json")).toBeUndefined();
    expect(backend.syncLocalFile("themes/lagoon.json")).toBe(THEME);
    // The names off the list do not make the gist look changed.
    backend.setSyncLocalFile("config.jsonc", '{ "x": 1 }\n');
    expect((await backend.syncGistPush()).pushed).toBe(true);
  });

  it("goes both ways between two computers through the same gist", async () => {
    const { backend: a, id } = await connected();
    const b = new FakeBackend();
    await b.syncGistSetToken(TOKEN);
    // Both fakes share nothing: b plays the other computer by copying what the gist holds.
    b.putSyncGist(id, { files: a.syncGistFiles(id) });
    b.setSyncLocalFile("mods/b-only.css", ".b {}\n");
    await b.syncGistConnect(id);
    expect(await b.syncGistPull()).toEqual({
      kind: "updated",
      files: ["config.jsonc", "mods/tweak.css", "themes/lagoon.json"],
    });
    expect((await b.syncGistPush()).files).toEqual(["mods/b-only.css"]);
    expect(sha256Hex(b.syncLocalFile("config.jsonc") ?? "")).toBe(sha256Hex(CONFIG));
  });
});
