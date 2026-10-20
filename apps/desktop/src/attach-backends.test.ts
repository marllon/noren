import { FakeBackend, decodeUtf8 } from "@noren/model";
import type { Backend, SessionExit } from "@noren/model";
import { describe, expect, it } from "vitest";
import { TauriBackend } from "./tauri-backend";
import type { ChannelLike, TauriBridge } from "./tauri-backend";
import { WebBackend } from "./web-backend";
import type { StateStorage } from "./web-backend";

// `attachSession`: a window takes over the output of a session another window started (the quick
// terminal being promoted). The in-memory backends answer it for any session they run; the Tauri
// one moves the channel behind the session on the Rust side.

function memoryStorage(): StateStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const text = (data: Uint8Array[]): string => data.map((chunk) => decodeUtf8(chunk)).join("");

describe.each<[string, () => Backend]>([
  ["FakeBackend", () => new FakeBackend()],
  ["WebBackend", () => new WebBackend(memoryStorage())],
])("%s.attachSession", (_name, make) => {
  it("takes over a session that is running, and leaves it running", async () => {
    const backend = make();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await expect(backend.attachSession(id)).resolves.toBeUndefined();

    const heard: Uint8Array[] = [];
    backend.onOutput(id, (data) => heard.push(data));
    await backend.write(id, "echo promoted\r");
    expect(text(heard)).toContain("promoted");
  });

  it("rejects for a session that was never started", async () => {
    await expect(make().attachSession(404)).rejects.toThrow("unknown session 404");
  });

  it("rejects for a session that ended", async () => {
    const backend = make();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.kill(id);
    await expect(backend.attachSession(id)).rejects.toThrow(`unknown session ${id}`);
  });
});

function fakeBridge(answers: Record<string, unknown> = {}) {
  const invocations: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const channels: ChannelLike<ArrayBuffer>[] = [];
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const failing = new Map<string, string>();
  /** Every `listen` and `invoke`, in order, to tell which came first. */
  const log: string[] = [];
  const bridge: TauriBridge = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      log.push(`invoke ${command}`);
      invocations.push({ command, args });
      const failure = failing.get(command);
      if (failure !== undefined) return Promise.reject(new Error(failure));
      return Promise.resolve(answers[command] as T);
    },
    listen: (event, handler) => {
      log.push(`listen ${event}`);
      handlers.set(event, handler as (event: { payload: unknown }) => void);
      return Promise.resolve(() => undefined);
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
    emitExit: (payload: unknown) => handlers.get("session-exit")?.({ payload }),
    callsTo: (command: string) => invocations.filter((call) => call.command === command),
  };
}

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

describe("TauriBackend.attachSession", () => {
  it("asks session_attach for the session with a channel of its own", async () => {
    const fake = fakeBridge();
    await new TauriBackend(fake.bridge).attachSession(7);
    expect(fake.invocations).toEqual([
      { command: "session_attach", args: { id: 7, onOutput: fake.channels[0] } },
    ]);
    expect(fake.channels).toHaveLength(1);
  });

  it("hears the exits before it asks, so a shell that ends at once is not missed", async () => {
    const fake = fakeBridge();
    await new TauriBackend(fake.bridge).attachSession(7);
    expect(fake.log).toEqual(["listen session-exit", "invoke session_attach"]);
  });

  it("delivers what the session prints from then on through onOutput, holding the first chunks", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    await backend.attachSession(7);
    // Printed between the move and the terminal of the new tab subscribing.
    fake.channels[0]?.onmessage(bytes(104, 105));

    const heard: Uint8Array[] = [];
    backend.onOutput(7, (data) => heard.push(data));
    expect(text(heard)).toBe("hi");
    fake.channels[0]?.onmessage(bytes(33));
    expect(text(heard)).toBe("hi!");
  });

  it("rejects with the reason of the Rust side and keeps nothing for a session that is gone", async () => {
    const fake = fakeBridge();
    fake.failing.set("session_attach", "unknown session 7");
    const backend = new TauriBackend(fake.bridge);
    await expect(backend.attachSession(7)).rejects.toThrow("unknown session 7");

    const heard: Uint8Array[] = [];
    backend.onOutput(7, (data) => heard.push(data));
    fake.channels[0]?.onmessage(bytes(1));
    expect(heard).toEqual([]);
  });

  it("reports the end of the session and releases its id, like a session it started itself", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    const exits: SessionExit[] = [];
    backend.onExit((exit) => exits.push(exit));
    await backend.attachSession(7);

    fake.emitExit({ id: 7, code: 2, signal: null });

    expect(exits).toEqual([{ id: 7, code: 2 }]);
    expect(fake.callsTo("session_kill").map((call) => call.args)).toEqual([{ id: 7 }]);
  });

  it("handles an exit that arrived before the move was answered", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    const exits: SessionExit[] = [];
    backend.onExit((exit) => exits.push(exit));
    // The session ends while session_attach is on its way.
    const original = fake.bridge.invoke;
    fake.bridge.invoke = <T>(command: string, args?: Record<string, unknown>) => {
      if (command === "session_attach") fake.emitExit({ id: 7, code: 0, signal: null });
      return original<T>(command, args);
    };

    await backend.attachSession(7);

    expect(exits).toEqual([{ id: 7, code: 0 }]);
    expect(fake.callsTo("session_kill")).toHaveLength(1);
  });
});

describe("TauriBackend.reattachSession (NOR-F14-02b)", () => {
  it("asks session_reattach for the pane with a channel of its own, and answers with the session", async () => {
    const fake = fakeBridge({ session_reattach: 12 });
    await expect(new TauriBackend(fake.bridge).reattachSession("pane-a")).resolves.toBe(12);
    expect(fake.invocations).toEqual([
      { command: "session_reattach", args: { paneId: "pane-a", onOutput: fake.channels[0] } },
    ]);
    expect(fake.log).toEqual(["listen session-exit", "invoke session_reattach"]);
  });

  it("answers with nothing, and keeps nothing, for a pane that has no shell to come back to", async () => {
    const fake = fakeBridge({ session_reattach: null });
    const backend = new TauriBackend(fake.bridge);
    await expect(backend.reattachSession("pane-a")).resolves.toBeUndefined();

    const heard: Uint8Array[] = [];
    backend.onOutput(12, (data) => heard.push(data));
    fake.channels[0]?.onmessage(bytes(1));
    expect(heard).toEqual([]);
  });

  it("delivers what the shell printed meanwhile, then what it prints, through onOutput", async () => {
    const fake = fakeBridge({ session_reattach: 12 });
    const backend = new TauriBackend(fake.bridge);
    await backend.reattachSession("pane-a");
    // The buffer of the daemon arrives before the terminal of the pane subscribes.
    fake.channels[0]?.onmessage(bytes(104, 105));

    const heard: Uint8Array[] = [];
    backend.onOutput(12, (data) => heard.push(data));
    expect(text(heard)).toBe("hi");
    fake.channels[0]?.onmessage(bytes(33));
    expect(text(heard)).toBe("hi!");
  });

  it("reports the end of the shell and releases its id, like a session it started itself", async () => {
    const fake = fakeBridge({ session_reattach: 12 });
    const backend = new TauriBackend(fake.bridge);
    const exits: SessionExit[] = [];
    backend.onExit((exit) => exits.push(exit));
    await backend.reattachSession("pane-a");

    fake.emitExit({ id: 12, code: 3, signal: null });

    expect(exits).toEqual([{ id: 12, code: 3 }]);
    expect(fake.callsTo("session_kill").map((call) => call.args)).toEqual([{ id: 12 }]);
  });

  it("rejects with the reason of the Rust side", async () => {
    const fake = fakeBridge();
    fake.failing.set("session_reattach", "the daemon would not answer");
    await expect(new TauriBackend(fake.bridge).reattachSession("pane-a")).rejects.toThrow(
      "the daemon would not answer",
    );
  });
});

describe("TauriBackend.setKeepSessions and the pane of a new shell (NOR-F14-02b)", () => {
  it("hands the setting to sessions_keep_set", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    await backend.setKeepSessions(false);
    await backend.setKeepSessions(true);
    expect(fake.callsTo("sessions_keep_set").map((call) => call.args)).toEqual([
      { keep: false },
      { keep: true },
    ]);
  });

  it("rejects when the Rust side would not take it", async () => {
    const fake = fakeBridge();
    fake.failing.set("sessions_keep_set", "no");
    await expect(new TauriBackend(fake.bridge).setKeepSessions(true)).rejects.toThrow("no");
  });

  it("names the pane in session_create when the shell is for one, and only then", async () => {
    const fake = fakeBridge({ session_create: 3 });
    const backend = new TauriBackend(fake.bridge);
    await backend.createSession({ cols: 80, rows: 24, paneId: "pane-a" });
    await backend.createSession({ cols: 80, rows: 24 });
    const [forPane, forNone] = fake.callsTo("session_create").map((call) => call.args);
    expect(forPane).toMatchObject({ cols: 80, rows: 24, paneId: "pane-a" });
    expect(forNone).not.toHaveProperty("paneId");
  });
});
