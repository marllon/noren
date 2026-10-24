import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EARLY_READS, resetEarlyReads, startEarlyReads, takeEarlyRead } from "./early-reads";
import { tauriBridge } from "./tauri-backend";

beforeEach(() => resetEarlyReads());
afterEach(() => vi.unstubAllGlobals());

/** A fake app: every command answers its own name, and the calls are kept in order. */
function fakeApp() {
  const calls: string[] = [];
  const call = vi.fn((command: string) => {
    calls.push(command);
    return Promise.resolve(`answer of ${command}`);
  });
  return { call, calls };
}

describe("startEarlyReads", () => {
  it("asks for each read of the boot once, side by side, without waiting for any answer", () => {
    const app = fakeApp();
    startEarlyReads(app.call);
    expect(app.calls).toEqual([...EARLY_READS]);
    startEarlyReads(app.call);
    expect(app.calls).toEqual([...EARLY_READS]);
  });

  it("only reads: the commands are the ones that change nothing in the app", () => {
    expect([...EARLY_READS]).toEqual(["config_load", "theme_list", "mod_list", "state_load"]);
  });

  it("does not ask again once the answers were taken", async () => {
    const app = fakeApp();
    startEarlyReads(app.call);
    for (const command of EARLY_READS) await takeEarlyRead(command);
    startEarlyReads(app.call);
    expect(app.calls).toHaveLength(EARLY_READS.length);
  });
});

describe("takeEarlyRead", () => {
  it("hands over the answer of the early read once, then leaves the command to the app", async () => {
    const app = fakeApp();
    startEarlyReads(app.call);
    await expect(takeEarlyRead("config_load")).resolves.toBe("answer of config_load");
    expect(takeEarlyRead("config_load")).toBeUndefined();
  });

  it("answers nothing for a command that was not started or for one called with arguments", () => {
    const app = fakeApp();
    startEarlyReads(app.call);
    expect(takeEarlyRead("session_create")).toBeUndefined();
    expect(takeEarlyRead("state_load", { content: "x" })).toBeUndefined();
    // The call with arguments did not use up the read.
    expect(takeEarlyRead("state_load")).toBeDefined();
  });

  it("answers nothing when no read was started", () => {
    expect(takeEarlyRead("config_load")).toBeUndefined();
  });

  it("gives the failure of a read to whoever takes it, and reports none for a read nobody takes", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      startEarlyReads((command) =>
        command === "config_load" ? Promise.reject(new Error("no file")) : Promise.resolve(null),
      );
      await new Promise((done) => setTimeout(done, 10));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(takeEarlyRead("config_load")).rejects.toThrow("no file");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("the bridge to the app", () => {
  it("answers the boot from the early reads once and sends every other call to the app", async () => {
    const invoke = vi.fn((command: string) => Promise.resolve(`app:${command}`));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    startEarlyReads();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([...EARLY_READS]);

    const bridge = tauriBridge();
    // The boot's own calls find their answers in, and do not ask the app again.
    await expect(bridge.invoke("config_load")).resolves.toBe("app:config_load");
    await expect(bridge.invoke("state_load")).resolves.toBe("app:state_load");
    expect(invoke).toHaveBeenCalledTimes(EARLY_READS.length);

    // The next call of the same command (the settings read again for an edit) goes to the app, and
    // so does any call with arguments or any other command.
    await bridge.invoke("config_load");
    await bridge.invoke("session_create", { cols: 80 });
    expect(invoke.mock.calls.slice(EARLY_READS.length).map(([command]) => command)).toEqual([
      "config_load",
      "session_create",
    ]);
  });

  it("is the plain call to the app when nothing was started early", async () => {
    const invoke = vi.fn((command: string) => Promise.resolve(`app:${command}`));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(tauriBridge().invoke("config_load")).resolves.toBe("app:config_load");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
