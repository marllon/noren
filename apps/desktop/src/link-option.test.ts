import { FakeBackend } from "@noren/model";
import { describe, expect, it } from "vitest";
import { changeLink } from "./link-option";
import { TauriBackend } from "./tauri-backend";
import type { TauriBridge } from "./tauri-backend";

function bridge() {
  const invocations: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const failing = new Map<string, string>();
  const made: TauriBridge = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      invocations.push({ command, args });
      const failure = failing.get(command);
      // Tauri rejects with the string the command returned.
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve(undefined as T);
    },
    listen: () => Promise.resolve(() => undefined),
    createChannel: () => ({ onmessage: () => undefined }),
  };
  return { made, invocations, failing };
}

describe("the noren:// link option", () => {
  it("asks nothing of the system until the option is changed", () => {
    const backend = new FakeBackend();
    expect(backend.linkRegistered).toBe(false);
    expect(backend.callsTo("setLinkRegistered")).toHaveLength(0);
  });

  it("registers the link when it is turned on and removes it when it is turned off", async () => {
    const backend = new FakeBackend();
    expect(await changeLink(backend, true)).toEqual({ ok: true });
    expect(backend.linkRegistered).toBe(true);
    expect(await changeLink(backend, false)).toEqual({ ok: true });
    expect(backend.linkRegistered).toBe(false);
    expect(backend.callsTo("setLinkRegistered").map((call) => call.args)).toEqual([
      [true],
      [false],
    ]);
  });

  it("answers with the reason, and leaves the link as it was, when the system refuses", async () => {
    const backend = new FakeBackend();
    backend.setLinkFailure(new Error("could not register the noren:// link: access denied"));
    const result = await changeLink(backend, true);
    expect(result).toEqual({
      ok: false,
      reason: "could not register the noren:// link: access denied",
    });
    expect(backend.linkRegistered).toBe(false);
  });

  it("calls deep_link_register_set on the app side, and shows the reason it returns", async () => {
    const fake = bridge();
    const backend = new TauriBackend(fake.made);
    expect(await changeLink(backend, true)).toEqual({ ok: true });
    expect(await changeLink(backend, false)).toEqual({ ok: true });
    fake.failing.set(
      "deep_link_register_set",
      "registering the noren:// link is not supported on this system",
    );
    const refused = await changeLink(backend, true);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("not supported on this system");
    expect(fake.invocations).toEqual([
      { command: "deep_link_register_set", args: { registered: true } },
      { command: "deep_link_register_set", args: { registered: false } },
      { command: "deep_link_register_set", args: { registered: true } },
    ]);
  });
});
