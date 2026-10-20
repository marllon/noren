import { describe, expect, it, vi } from "vitest";
import { AI_ERROR_KINDS, decodeUtf8 } from "@noren/model";
import type { AiChatEvent, AiChatMessage, AiChatRequest, SessionExit } from "@noren/model";
import { AI_END_GRACE_MS, TauriBackend } from "./tauri-backend";
import type { ChannelLike, TauriBridge } from "./tauri-backend";

interface Invocation {
  command: string;
  args: Record<string, unknown> | undefined;
}

/** A bridge whose `invoke` answers from a table and whose events are fired by the test. */
function fakeBridge(
  answers: Record<string, unknown> = {},
  /** Runs when a command is invoked, instead of answering from the table; what it returns is the answer. */
  behaviors: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {},
) {
  const invocations: Invocation[] = [];
  const channels: ChannelLike<ArrayBuffer>[] = [];
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const failing = new Set<string>();
  /** Every `listen` and `invoke`, in order, to tell which came first. */
  const log: string[] = [];
  let unlistened = 0;
  const bridge: TauriBridge = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      log.push(`invoke ${command}`);
      invocations.push({ command, args });
      if (failing.has(command)) return Promise.reject(new Error(`${command} failed`));
      const behavior = behaviors[command];
      if (behavior !== undefined) return Promise.resolve(behavior(args) as T);
      return Promise.resolve(answers[command] as T);
    },
    listen: (event, handler) => {
      log.push(`listen ${event}`);
      handlers.set(event, handler as (event: { payload: unknown }) => void);
      return Promise.resolve(() => {
        unlistened++;
      });
    },
    createChannel: <T>() => {
      const channel: ChannelLike<T> = { onmessage: () => undefined };
      channels.push(channel as ChannelLike<ArrayBuffer>);
      return channel;
    },
  };
  return {
    bridge,
    invocations,
    channels,
    failing,
    log,
    unlistened: () => unlistened,
    emitExit: (payload: unknown) => handlers.get("session-exit")?.({ payload }),
    emitConfig: (payload: unknown) => handlers.get("config-changed")?.({ payload }),
    callsTo: (command: string) => invocations.filter((i) => i.command === command),
  };
}

const buffer = (...bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

describe("TauriBackend", () => {
  it("lists profiles through profiles_list", async () => {
    const profiles = [{ id: "pwsh", name: "PowerShell", default: true }];
    const fake = fakeBridge({ profiles_list: profiles });
    await expect(new TauriBackend(fake.bridge).listProfiles()).resolves.toEqual(profiles);
    expect(fake.invocations).toEqual([{ command: "profiles_list", args: undefined }]);
  });

  it("hands the profiles of the user over through profiles_set_user, as the list given", async () => {
    const profiles = [
      {
        id: "dev-shell",
        name: "Dev Shell",
        program: "pwsh.exe",
        args: ["-NoLogo"],
        cwd: "C:\\work",
      },
      { id: "plain", name: "Plain", program: "sh" },
    ];
    const fake = fakeBridge();
    await expect(new TauriBackend(fake.bridge).setUserProfiles(profiles)).resolves.toBeUndefined();
    expect(fake.invocations).toEqual([{ command: "profiles_set_user", args: { profiles } }]);
  });

  it("lets the reason profiles_set_user refused with reach the caller", async () => {
    const fake = fakeBridge();
    fake.failing.add("profiles_set_user");
    await expect(new TauriBackend(fake.bridge).setUserProfiles([])).rejects.toThrow(
      "profiles_set_user failed",
    );
  });

  it("creates a session with camelCase arguments and a binary channel", async () => {
    const fake = fakeBridge({ session_create: 7 });
    const backend = new TauriBackend(fake.bridge);
    const id = await backend.createSession({ profileId: "pwsh", cols: 100, rows: 30 });
    expect(id).toBe(7);
    const [call] = fake.callsTo("session_create");
    expect(call?.args).toEqual({
      profileId: "pwsh",
      cols: 100,
      rows: 30,
      onOutput: fake.channels[0],
    });
  });

  it("leaves optional fields out instead of sending undefined", async () => {
    const fake = fakeBridge({ session_create: 1 });
    await new TauriBackend(fake.bridge).createSession({ cols: 80, rows: 24 });
    const args = fake.callsTo("session_create")[0]?.args ?? {};
    expect(Object.keys(args).sort()).toEqual(["cols", "onOutput", "rows"]);
  });

  it("passes cwd and env along", async () => {
    const fake = fakeBridge({ session_create: 1 });
    await new TauriBackend(fake.bridge).createSession({
      cols: 80,
      rows: 24,
      cwd: "C:\\work",
      env: { A: "1" },
    });
    expect(fake.callsTo("session_create")[0]?.args).toMatchObject({
      cwd: "C:\\work",
      env: { A: "1" },
    });
  });

  it("turns channel ArrayBuffers into Uint8Array for onOutput, holding early output", async () => {
    const fake = fakeBridge({ session_create: 3 });
    const backend = new TauriBackend(fake.bridge);
    const id = await backend.createSession({ cols: 80, rows: 24 });
    const channel = fake.channels[0];
    channel?.onmessage(buffer(104, 105));

    const seen: Uint8Array[] = [];
    const stop = backend.onOutput(id, (data) => seen.push(data));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Uint8Array);
    expect(decodeUtf8(seen[0] ?? new Uint8Array())).toBe("hi");

    channel?.onmessage(buffer(33));
    expect(decodeUtf8(seen[1] ?? new Uint8Array())).toBe("!");
    stop();
    channel?.onmessage(buffer(63));
    expect(seen).toHaveLength(2);
  });

  it("sends text as a string and bytes as an array to session_write", async () => {
    const fake = fakeBridge({ session_create: 3 });
    const backend = new TauriBackend(fake.bridge);
    await backend.write(3, "echo hi\r");
    await backend.write(3, new Uint8Array([1, 2, 3]));
    expect(fake.callsTo("session_write").map((c) => c.args)).toEqual([
      { id: 3, data: "echo hi\r" },
      { id: 3, data: [1, 2, 3] },
    ]);
  });

  it("resizes and kills through session_resize and session_kill", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    await backend.resize(3, 120, 40);
    await backend.kill(3);
    expect(fake.invocations).toEqual([
      { command: "session_resize", args: { id: 3, cols: 120, rows: 40 } },
      { command: "session_kill", args: { id: 3 } },
    ]);
  });

  it("turns session-exit into onExit and releases the id with session_kill", async () => {
    const fake = fakeBridge({ session_create: 5 });
    const backend = new TauriBackend(fake.bridge);
    const exits: SessionExit[] = [];
    backend.onExit((exit) => exits.push(exit));
    const id = await backend.createSession({ cols: 80, rows: 24 });

    fake.emitExit({ id, code: 3, signal: null });
    expect(exits).toEqual([{ id: 5, code: 3 }]);
    expect(fake.callsTo("session_kill").map((c) => c.args)).toEqual([{ id: 5 }]);
  });

  it("includes the signal when there is one", async () => {
    const fake = fakeBridge({ session_create: 5 });
    const backend = new TauriBackend(fake.bridge);
    const exits: SessionExit[] = [];
    backend.onExit((exit) => exits.push(exit));
    const id = await backend.createSession({ cols: 80, rows: 24 });
    fake.emitExit({ id, code: 1, signal: "SIGTERM" });
    expect(exits).toEqual([{ id: 5, code: 1, signal: "SIGTERM" }]);
  });

  it("releases the id even when nobody listens to onExit", async () => {
    const fake = fakeBridge({ session_create: 5 });
    const backend = new TauriBackend(fake.bridge);
    const id = await backend.createSession({ cols: 80, rows: 24 });
    fake.emitExit({ id, code: 0, signal: null });
    expect(fake.callsTo("session_kill")).toHaveLength(1);
  });

  it("does not kill twice when kill() caused the exit", async () => {
    const fake = fakeBridge({ session_create: 5 });
    const backend = new TauriBackend(fake.bridge);
    const exits: SessionExit[] = [];
    backend.onExit((exit) => exits.push(exit));
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.kill(id);
    fake.emitExit({ id, code: 1, signal: null });
    expect(exits).toHaveLength(1);
    expect(fake.callsTo("session_kill")).toHaveLength(1);
  });

  it("handles an exit that arrives before session_create returns", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    const exits: SessionExit[] = [];
    backend.onExit((exit) => exits.push(exit));
    // The event for session 9 reaches the interface before the command answers.
    const original = fake.bridge.invoke;
    fake.bridge.invoke = <T>(command: string, args?: Record<string, unknown>) => {
      if (command === "session_create") fake.emitExit({ id: 9, code: 0, signal: null });
      return original<T>(command, args).then((value) =>
        command === "session_create" ? (9 as T) : value,
      );
    };
    const id = await backend.createSession({ cols: 80, rows: 24 });
    expect(id).toBe(9);
    expect(exits).toEqual([{ id: 9, code: 0 }]);
    expect(fake.callsTo("session_kill").map((c) => c.args)).toEqual([{ id: 9 }]);
  });

  it("ignores a failing session_kill after an exit", async () => {
    const fake = fakeBridge({ session_create: 5 });
    fake.failing.add("session_kill");
    const backend = new TauriBackend(fake.bridge);
    const id = await backend.createSession({ cols: 80, rows: 24 });
    expect(() => fake.emitExit({ id, code: 0, signal: null })).not.toThrow();
  });

  it("stops listening to exits on dispose", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    backend.onExit(() => undefined);
    await backend.dispose();
    expect(fake.unlistened()).toBe(1);
  });

  it("loads the state through state_load, as text or null", async () => {
    const fake = fakeBridge({ state_load: '{"version":1}' });
    await expect(new TauriBackend(fake.bridge).loadState()).resolves.toBe('{"version":1}');
    expect(fake.invocations).toEqual([{ command: "state_load", args: undefined }]);

    const none = fakeBridge({ state_load: null });
    await expect(new TauriBackend(none.bridge).loadState()).resolves.toBeNull();
  });

  it("saves the state through state_save with the content", async () => {
    const fake = fakeBridge();
    await new TauriBackend(fake.bridge).saveState('{"version":1}');
    expect(fake.invocations).toEqual([
      { command: "state_save", args: { content: '{"version":1}' } },
    ]);
  });

  it("quarantines through state_quarantine and returns the path of the copy", async () => {
    const fake = fakeBridge({ state_quarantine: "C:\\data\\state.broken-20261018T120000Z.json" });
    await expect(new TauriBackend(fake.bridge).quarantineState()).resolves.toBe(
      "C:\\data\\state.broken-20261018T120000Z.json",
    );
    expect(fake.invocations).toEqual([{ command: "state_quarantine", args: undefined }]);
  });

  it("lets state command failures reach the caller", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    fake.failing.add("state_load").add("state_save").add("state_quarantine");
    await expect(backend.loadState()).rejects.toThrow("state_load failed");
    await expect(backend.saveState("x")).rejects.toThrow("state_save failed");
    await expect(backend.quarantineState()).rejects.toThrow("state_quarantine failed");
  });

  it("reads the actions file through project_actions_read, as text or null", async () => {
    const fake = fakeBridge({ project_actions_read: '{"actions":[]}' });
    await expect(new TauriBackend(fake.bridge).readActionsFile("D:\\proj")).resolves.toBe(
      '{"actions":[]}',
    );
    expect(fake.invocations).toEqual([
      { command: "project_actions_read", args: { cwd: "D:\\proj" } },
    ]);

    const none = fakeBridge({ project_actions_read: null });
    await expect(new TauriBackend(none.bridge).readActionsFile("D:\\proj")).resolves.toBeNull();
  });

  it("runs a command through project_command_run and returns its exit code", async () => {
    const fake = fakeBridge({ project_command_run: 3 });
    await expect(new TauriBackend(fake.bridge).runCommand("D:\\proj", "loop parar")).resolves.toBe(
      3,
    );
    expect(fake.invocations).toEqual([
      { command: "project_command_run", args: { cwd: "D:\\proj", command: "loop parar" } },
    ]);
  });

  it("reads the git branch of a folder through git_info, or null outside a repository", async () => {
    const fake = fakeBridge({ git_info: { branch: "feature/x", detached: false } });
    await expect(new TauriBackend(fake.bridge).gitInfo("D:\\proj\\src")).resolves.toEqual({
      branch: "feature/x",
      detached: false,
    });
    expect(fake.invocations).toEqual([{ command: "git_info", args: { cwd: "D:\\proj\\src" } }]);

    const detached = fakeBridge({ git_info: { branch: "0123456", detached: true } });
    await expect(new TauriBackend(detached.bridge).gitInfo("/p")).resolves.toEqual({
      branch: "0123456",
      detached: true,
    });

    const none = fakeBridge({ git_info: null });
    await expect(new TauriBackend(none.bridge).gitInfo("/tmp")).resolves.toBeNull();
  });

  it("asks agents_scan for the agents under the sessions, sending the catalog as plain entries", async () => {
    const fake = fakeBridge({ agents_scan: [{ sessionId: 3, agentId: "claude", extra: 1 }] });
    const hits = await new TauriBackend(fake.bridge).scanAgents(
      [3, 4],
      [
        { id: "claude", executables: ["claude"] },
        { id: "aider", executables: ["aider"], packages: ["aider"] },
      ],
    );
    expect(hits).toEqual([{ sessionId: 3, agentId: "claude" }]);
    expect(fake.invocations).toEqual([
      {
        command: "agents_scan",
        args: {
          sessionIds: [3, 4],
          catalog: [
            { id: "claude", executables: ["claude"], packages: [] },
            { id: "aider", executables: ["aider"], packages: ["aider"] },
          ],
        },
      },
    ]);
  });

  it("lets an agents_scan failure reach the caller", async () => {
    const fake = fakeBridge();
    fake.failing.add("agents_scan");
    await expect(new TauriBackend(fake.bridge).scanAgents([1], [])).rejects.toThrow(
      "agents_scan failed",
    );
  });

  it("lets a git_info failure reach the caller", async () => {
    const fake = fakeBridge();
    fake.failing.add("git_info");
    await expect(new TauriBackend(fake.bridge).gitInfo("/p")).rejects.toThrow("git_info failed");
  });

  it("shows a notification through notify_show with plain text arguments", async () => {
    const fake = fakeBridge();
    await new TauriBackend(fake.bridge).notify("Build", "Bell");
    expect(fake.invocations).toEqual([
      { command: "notify_show", args: { title: "Build", body: "Bell" } },
    ]);
  });

  it("reads the focus of the window through window_is_focused", async () => {
    const focused = fakeBridge({ window_is_focused: true });
    await expect(new TauriBackend(focused.bridge).isWindowFocused()).resolves.toBe(true);
    expect(focused.invocations).toEqual([{ command: "window_is_focused", args: undefined }]);
    const away = fakeBridge({ window_is_focused: false });
    await expect(new TauriBackend(away.bridge).isWindowFocused()).resolves.toBe(false);
  });

  it("lets a notification or focus failure reach the caller", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    fake.failing.add("notify_show").add("window_is_focused");
    await expect(backend.notify("a", "b")).rejects.toThrow("notify_show failed");
    await expect(backend.isWindowFocused()).rejects.toThrow("window_is_focused failed");
  });

  it("lets project command failures reach the caller", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    fake.failing.add("project_actions_read").add("project_command_run");
    await expect(backend.readActionsFile("x")).rejects.toThrow("project_actions_read failed");
    await expect(backend.runCommand("x", "y")).rejects.toThrow("project_command_run failed");
  });

  it("loads the settings through config_load, as text or null", async () => {
    const text = '// mine\n{ "appearance": { "tabs": "top" } }';
    const fake = fakeBridge({ config_load: text });
    await expect(new TauriBackend(fake.bridge).loadConfig()).resolves.toBe(text);
    expect(fake.invocations).toEqual([{ command: "config_load", args: undefined }]);
    const none = fakeBridge({ config_load: null });
    await expect(new TauriBackend(none.bridge).loadConfig()).resolves.toBeNull();
  });

  it("saves the settings through config_save with the text untouched", async () => {
    const text = '﻿// mine, with ação\r\n{ "appearance": { "tabs": "top", }, }\r\n';
    const fake = fakeBridge();
    await expect(new TauriBackend(fake.bridge).saveConfig(text)).resolves.toBeUndefined();
    expect(fake.invocations).toEqual([{ command: "config_save", args: { content: text } }]);
  });

  it("lets a config_save failure reach the caller", async () => {
    const fake = fakeBridge();
    fake.failing.add("config_save");
    await expect(new TauriBackend(fake.bridge).saveConfig("{}")).rejects.toThrow(
      "config_save failed",
    );
  });

  it("lets a config_load failure reach the caller", async () => {
    const fake = fakeBridge();
    fake.failing.add("config_load");
    await expect(new TauriBackend(fake.bridge).loadConfig()).rejects.toThrow("config_load failed");
  });

  it("lists the theme files of the user through theme_list, as text", async () => {
    const files = ['{ "id": "a" }', '{ "id": "b" }'];
    const fake = fakeBridge({ theme_list: files });
    await expect(new TauriBackend(fake.bridge).listUserThemes()).resolves.toEqual(files);
    expect(fake.invocations).toEqual([{ command: "theme_list", args: undefined }]);
  });

  it("saves a theme file through theme_save with the id and the text untouched", async () => {
    const text = '{\r\n  "id": "lagoon", "name": "Lagoon ação"\r\n}\r\n';
    const fake = fakeBridge();
    await expect(
      new TauriBackend(fake.bridge).saveUserTheme("lagoon", text),
    ).resolves.toBeUndefined();
    expect(fake.invocations).toEqual([
      { command: "theme_save", args: { id: "lagoon", content: text } },
    ]);
  });

  it("loads, saves and deletes a scrollback snapshot through the scrollback commands, by pane id", async () => {
    const fake = fakeBridge({ scrollback_load: "old text\nlines" });
    const backend = new TauriBackend(fake.bridge);
    await expect(backend.loadScrollback("pane-1")).resolves.toBe("old text\nlines");
    await expect(backend.saveScrollback("pane-1", "new text")).resolves.toBeUndefined();
    await expect(backend.deleteScrollback("pane-1")).resolves.toBeUndefined();
    expect(fake.invocations).toEqual([
      { command: "scrollback_load", args: { paneId: "pane-1" } },
      { command: "scrollback_save", args: { paneId: "pane-1", content: "new text" } },
      { command: "scrollback_delete", args: { paneId: "pane-1" } },
    ]);
  });

  it("lists the snapshots through the scrollback_list command", async () => {
    const fake = fakeBridge({ scrollback_list: ["pane-1", "pane-2"] });
    await expect(new TauriBackend(fake.bridge).listScrollback()).resolves.toEqual([
      "pane-1",
      "pane-2",
    ]);
    expect(fake.invocations).toEqual([{ command: "scrollback_list", args: undefined }]);
    fake.failing.add("scrollback_list");
    await expect(new TauriBackend(fake.bridge).listScrollback()).rejects.toThrow(
      "scrollback_list failed",
    );
  });

  it("answers null for a pane with no snapshot", async () => {
    const fake = fakeBridge({ scrollback_load: null });
    await expect(new TauriBackend(fake.bridge).loadScrollback("pane-1")).resolves.toBeNull();
  });

  it("lets a refusal of the scrollback commands reach the caller", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    fake.failing.add("scrollback_load").add("scrollback_save").add("scrollback_delete");
    await expect(backend.loadScrollback("../x")).rejects.toThrow("scrollback_load failed");
    await expect(backend.saveScrollback("../x", "t")).rejects.toThrow("scrollback_save failed");
    await expect(backend.deleteScrollback("../x")).rejects.toThrow("scrollback_delete failed");
  });

  it("lets a theme_list and a theme_save failure reach the caller", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    fake.failing.add("theme_list").add("theme_save");
    await expect(backend.listUserThemes()).rejects.toThrow("theme_list failed");
    await expect(backend.saveUserTheme("a", "{}")).rejects.toThrow("theme_save failed");
  });

  it("lists the monospaced fonts through fonts_list_monospace, as the names the Rust side sent", async () => {
    const fake = fakeBridge({ fonts_list_monospace: ["Cascadia Mono", "Consolas", "Courier New"] });
    await expect(new TauriBackend(fake.bridge).listMonospaceFonts()).resolves.toEqual([
      "Cascadia Mono",
      "Consolas",
      "Courier New",
    ]);
    expect(fake.invocations).toEqual([{ command: "fonts_list_monospace", args: undefined }]);
  });

  it("does not take the word of the Rust side that a name is a font name", async () => {
    // A font file with a name like a rule of CSS must not reach the page as a name.
    const fake = fakeBridge({
      fonts_list_monospace: [
        "Consolas",
        "consolas",
        'Evil"; background: url(http://example.com)',
        "a;b",
        42,
        null,
        "Courier New",
      ],
    });
    await expect(new TauriBackend(fake.bridge).listMonospaceFonts()).resolves.toEqual([
      "Consolas",
      "Courier New",
    ]);
  });

  it("lets a fonts_list_monospace failure reach the caller", async () => {
    const fake = fakeBridge();
    fake.failing.add("fonts_list_monospace");
    await expect(new TauriBackend(fake.bridge).listMonospaceFonts()).rejects.toThrow(
      "fonts_list_monospace failed",
    );
  });

  it("hears config-changed before it asks for the watching, once however many callbacks", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    const first: (string | null)[] = [];
    const second: (string | null)[] = [];
    backend.watchConfig((text) => first.push(text));
    backend.watchConfig((text) => second.push(text));
    await vi.waitFor(() => expect(fake.callsTo("config_watch")).toHaveLength(1));

    expect(fake.log).toEqual(["listen config-changed", "invoke config_watch"]);
    fake.emitConfig('{ "a": 1 }');
    fake.emitConfig(null);
    expect(first).toEqual(['{ "a": 1 }', null]);
    expect(second).toEqual(['{ "a": 1 }', null]);
  });

  it("stops delivering to a callback that unsubscribed", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    const heard: (string | null)[] = [];
    const stop = backend.watchConfig((text) => heard.push(text));
    await vi.waitFor(() => expect(fake.callsTo("config_watch")).toHaveLength(1));
    fake.emitConfig("{}");
    stop();
    fake.emitConfig("{ }");
    expect(heard).toEqual(["{}"]);
  });

  it("does not break when the watching cannot start, and tries again for the next callback", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    fake.failing.add("config_watch");
    backend.watchConfig(() => undefined);
    await vi.waitFor(() => expect(fake.unlistened()).toBe(1));

    fake.failing.delete("config_watch");
    const heard: (string | null)[] = [];
    backend.watchConfig((text) => heard.push(text));
    await vi.waitFor(() => expect(fake.callsTo("config_watch")).toHaveLength(2));
    fake.emitConfig("{}");
    expect(heard).toEqual(["{}"]);
  });

  it("stops listening to config-changed on dispose", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    backend.watchConfig(() => undefined);
    await vi.waitFor(() => expect(fake.callsTo("config_watch")).toHaveLength(1));
    await backend.dispose();
    expect(fake.unlistened()).toBe(1);
  });

  it("gives onOutput of an unknown session a harmless unsubscribe", () => {
    const backend = new TauriBackend(fakeBridge().bridge);
    expect(() => backend.onOutput(99, () => undefined)()).not.toThrow();
  });
});

describe("TauriBackend ai", () => {
  const KEY = "sk-test-0123456789abcdef";
  const OPENAI = {
    id: "my-openai",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  } as const;

  it("lists the providers through ai_providers, with hasKey and nothing else", async () => {
    const fake = fakeBridge({
      ai_providers: [
        {
          id: "ollama",
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          model: "",
          hasKey: false,
          surprise: KEY,
        },
        { ...OPENAI, hasKey: true },
      ],
    });
    const providers = await new TauriBackend(fake.bridge).ai.providers();
    expect(providers).toEqual([
      {
        id: "ollama",
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        model: "",
        hasKey: false,
      },
      { ...OPENAI, hasKey: true },
    ]);
    expect(JSON.stringify(providers)).not.toContain(KEY);
    expect(fake.invocations).toEqual([{ command: "ai_providers", args: undefined }]);
  });

  it("hands the providers over through ai_configure with only their four fields", async () => {
    const fake = fakeBridge();
    const withKey = { ...OPENAI, apiKey: KEY } as typeof OPENAI;
    await expect(new TauriBackend(fake.bridge).ai.configure([withKey])).resolves.toBeUndefined();
    expect(fake.invocations).toEqual([{ command: "ai_configure", args: { providers: [OPENAI] } }]);
    expect(JSON.stringify(fake.invocations)).not.toContain(KEY);
  });

  it("lets the reason ai_configure refused with reach the caller", async () => {
    const fake = fakeBridge();
    fake.failing.add("ai_configure");
    await expect(new TauriBackend(fake.bridge).ai.configure([])).rejects.toThrow(
      "ai_configure failed",
    );
  });

  it("stores a key through ai_set_key, the only command that carries one", async () => {
    const fake = fakeBridge();
    await expect(
      new TauriBackend(fake.bridge).ai.setKey("my-openai", KEY),
    ).resolves.toBeUndefined();
    expect(fake.invocations).toEqual([
      { command: "ai_set_key", args: { providerId: "my-openai", key: KEY } },
    ]);
  });

  it("lists the models of Ollama through ai_ollama_models, found or not", async () => {
    const found = fakeBridge({ ai_ollama_models: { found: true, models: ["llama3.2", "qwen"] } });
    await expect(new TauriBackend(found.bridge).ai.listOllamaModels()).resolves.toEqual({
      found: true,
      models: ["llama3.2", "qwen"],
    });
    expect(found.invocations).toEqual([{ command: "ai_ollama_models", args: undefined }]);
    const absent = fakeBridge({ ai_ollama_models: { found: false, models: [] } });
    await expect(new TauriBackend(absent.bridge).ai.listOllamaModels()).resolves.toEqual({
      found: false,
    });
  });

  it("tests a connection through ai_test_connection: ok, or a failure with its kind and message", async () => {
    const ok = fakeBridge({ ai_test_connection: { ok: true } });
    await expect(new TauriBackend(ok.bridge).ai.testConnection("my-openai")).resolves.toEqual({
      ok: true,
    });
    expect(ok.invocations).toEqual([
      { command: "ai_test_connection", args: { providerId: "my-openai" } },
    ]);

    const failed = fakeBridge({
      ai_test_connection: {
        ok: false,
        kind: "auth",
        message: "the provider rejected the API key (HTTP 401)",
      },
    });
    await expect(new TauriBackend(failed.bridge).ai.testConnection("my-openai")).resolves.toEqual({
      ok: false,
      kind: "auth",
      message: "the provider rejected the API key (HTTP 401)",
    });

    // An answer that lacks the reason still reads as a failure with words.
    const odd = fakeBridge({ ai_test_connection: { ok: false } });
    const result = await new TauriBackend(odd.bridge).ai.testConnection("my-openai");
    expect(result).toMatchObject({ ok: false, kind: "protocol" });
  });

  it("lets a test that could not start reach the caller as a rejection", async () => {
    const fake = fakeBridge();
    fake.failing.add("ai_test_connection");
    await expect(new TauriBackend(fake.bridge).ai.testConnection("nobody")).rejects.toThrow(
      "ai_test_connection failed",
    );
  });
});

describe("TauriBackend ai.chat and ai.cancel", () => {
  const KEY = "sk-test-0123456789abcdef";
  const REQUEST: AiChatRequest = {
    requestId: "ask-1",
    providerId: "my-openai",
    model: "gpt-4o",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ],
  };

  /** The channel `ai_chat_stream` was given, to speak into as the Rust side does. */
  const channelOf = (args: Record<string, unknown> | undefined): ChannelLike<unknown> =>
    args?.["onEvent"] as ChannelLike<unknown>;

  /** A bridge whose `ai_chat_stream` says each of `events` into the channel before it returns. */
  function streaming(events: readonly unknown[]) {
    return fakeBridge(
      {},
      {
        ai_chat_stream: (args) => {
          for (const event of events) channelOf(args).onmessage(event);
        },
      },
    );
  }

  async function chatAll(fake: ReturnType<typeof fakeBridge>, request: AiChatRequest = REQUEST) {
    const events: AiChatEvent[] = [];
    await new TauriBackend(fake.bridge).ai.chat(request, (event) => events.push(event));
    return events;
  }

  it("calls ai_chat_stream with camelCase arguments and a channel, and no key", async () => {
    const fake = streaming([{ type: "done" }]);
    await chatAll(fake);
    const [call] = fake.callsTo("ai_chat_stream");
    expect(call?.args).toEqual({
      providerId: "my-openai",
      requestId: "ask-1",
      model: "gpt-4o",
      messages: REQUEST.messages,
      onEvent: expect.anything(),
    });
    expect(JSON.stringify(call?.args)).not.toContain(KEY);
    expect(fake.channels).toHaveLength(1);
  });

  it("leaves the model out when there is none or it is blank", async () => {
    for (const model of [undefined, "", "  "]) {
      const fake = streaming([{ type: "done" }]);
      await chatAll(fake, { ...REQUEST, model });
      expect(Object.keys(fake.callsTo("ai_chat_stream")[0]?.args ?? {}).sort()).toEqual([
        "messages",
        "onEvent",
        "providerId",
        "requestId",
      ]);
    }
  });

  it("sends the role and content of each message and nothing else", async () => {
    const fake = streaming([{ type: "done" }]);
    const odd = { role: "user", content: "hi", apiKey: KEY } as AiChatMessage;
    await chatAll(fake, { ...REQUEST, messages: [odd] });
    expect(fake.callsTo("ai_chat_stream")[0]?.args?.["messages"]).toEqual([
      { role: "user", content: "hi" },
    ]);
    expect(JSON.stringify(fake.invocations)).not.toContain(KEY);
  });

  it("hands over the deltas in order and then the end, and resolves after it", async () => {
    const fake = streaming([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done" },
    ]);
    await expect(chatAll(fake)).resolves.toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done" },
    ]);
  });

  it("waits for events that come after the command has returned", async () => {
    let channel: ChannelLike<unknown> | undefined;
    const fake = fakeBridge(
      {},
      {
        ai_chat_stream: (args) => {
          channel = channelOf(args);
        },
      },
    );
    const events: AiChatEvent[] = [];
    let resolved = false;
    const chat = new TauriBackend(fake.bridge).ai
      .chat(REQUEST, (event) => events.push(event))
      .then(() => {
        resolved = true;
      });
    await vi.waitFor(() => expect(channel).toBeDefined());
    channel?.onmessage({ type: "delta", text: "late" });
    await Promise.resolve();
    expect(resolved).toBe(false);
    channel?.onmessage({ type: "done" });
    await chat;
    expect(events).toEqual([{ type: "delta", text: "late" }, { type: "done" }]);
  });

  it("hands over an error with its kind and its message", async () => {
    const fake = streaming([
      { type: "delta", text: "par" },
      { type: "error", kind: "auth", message: "the provider refused the key" },
    ]);
    await expect(chatAll(fake)).resolves.toEqual([
      { type: "delta", text: "par" },
      { type: "error", kind: "auth", message: "the provider refused the key" },
    ]);
  });

  it("reads every kind of error the Rust side has, and calls an unknown one protocol", async () => {
    for (const kind of AI_ERROR_KINDS) {
      const events = await chatAll(streaming([{ type: "error", kind, message: "m" }]));
      expect(events).toEqual([{ type: "error", kind, message: "m" }]);
    }
    const odd = await chatAll(streaming([{ type: "error", kind: "weird", message: "m" }]));
    expect(odd).toEqual([{ type: "error", kind: "protocol", message: "m" }]);
    const bare = await chatAll(streaming([{ type: "error" }]));
    expect(bare[0]).toMatchObject({ type: "error", kind: "protocol" });
  });

  it("hands over one end only, and nothing that comes after it", async () => {
    const fake = streaming([
      { type: "delta", text: "a" },
      { type: "done" },
      { type: "delta", text: "ghost" },
      { type: "done" },
      { type: "error", kind: "network", message: "late" },
    ]);
    await expect(chatAll(fake)).resolves.toEqual([{ type: "delta", text: "a" }, { type: "done" }]);
  });

  it("ignores what is not an event", async () => {
    const fake = streaming([
      { type: "other" },
      { type: "delta" },
      { type: "delta", text: 3 },
      { type: "delta", text: "ok" },
      { type: "done" },
    ]);
    await expect(chatAll(fake)).resolves.toEqual([{ type: "delta", text: "ok" }, { type: "done" }]);
  });

  it("rejects, with the reason and no event, when ai_chat_stream could not start", async () => {
    const fake = fakeBridge();
    fake.failing.add("ai_chat_stream");
    const events: AiChatEvent[] = [];
    await expect(
      new TauriBackend(fake.bridge).ai.chat(REQUEST, (event) => events.push(event)),
    ).rejects.toThrow("ai_chat_stream failed");
    expect(events).toEqual([]);
  });

  it("ends with a protocol error if the command returned and no end came", async () => {
    vi.useFakeTimers();
    try {
      const fake = streaming([{ type: "delta", text: "half" }]);
      const events: AiChatEvent[] = [];
      const chat = new TauriBackend(fake.bridge).ai.chat(REQUEST, (event) => events.push(event));
      await vi.advanceTimersByTimeAsync(AI_END_GRACE_MS - 1);
      expect(events).toEqual([{ type: "delta", text: "half" }]);
      await vi.advanceTimersByTimeAsync(1);
      await chat;
      expect(events).toEqual([
        { type: "delta", text: "half" },
        { type: "error", kind: "protocol", message: "the answer ended without a final event" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave the grace timer behind when the end came", async () => {
    vi.useFakeTimers();
    try {
      const fake = streaming([{ type: "done" }]);
      await expect(chatAll(fake)).resolves.toEqual([{ type: "done" }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels through ai_cancel with the request id and answers what it says", async () => {
    const running = fakeBridge({ ai_cancel: true });
    await expect(new TauriBackend(running.bridge).ai.cancel("ask-1")).resolves.toBe(true);
    expect(running.invocations).toEqual([{ command: "ai_cancel", args: { requestId: "ask-1" } }]);
    const gone = fakeBridge({ ai_cancel: false });
    await expect(new TauriBackend(gone.bridge).ai.cancel("nobody")).resolves.toBe(false);
  });

  it("lets the reason ai_cancel refused with reach the caller", async () => {
    const fake = fakeBridge();
    fake.failing.add("ai_cancel");
    await expect(new TauriBackend(fake.bridge).ai.cancel("x")).rejects.toThrow("ai_cancel failed");
  });
});
