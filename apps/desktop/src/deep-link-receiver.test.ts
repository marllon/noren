import { describe, expect, it } from "vitest";
import {
  APPLIED_COMMAND,
  LINK_EVENT,
  TAKE_WAITING_COMMAND,
  startDeepLinkReceiver,
} from "./deep-link-receiver";

/** A bridge that answers `deep_link_take_waiting` from `waiting` and lets the test fire events. */
function setup(waiting: unknown = [], folder: string | null = "/srv/proj") {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const applied: string[] = [];
  let handler: ((event: { payload: unknown }) => void) | undefined;
  let unlistened = 0;
  let failApply = false;
  const bridge = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return Promise.resolve((command === TAKE_WAITING_COMMAND ? waiting : undefined) as T);
    },
    listen: <T>(event: string, h: (event: { payload: T }) => void) => {
      expect(event).toBe(LINK_EVENT);
      handler = h as (event: { payload: unknown }) => void;
      return Promise.resolve(() => {
        unlistened++;
      });
    },
  };
  const stop = startDeepLinkReceiver({
    bridge,
    apply: (url) => {
      applied.push(url);
      return failApply ? Promise.reject(new Error("boom")) : Promise.resolve();
    },
    activeFolder: () => folder ?? undefined,
  });
  return {
    calls,
    applied,
    stop,
    fire: (payload: unknown) => handler?.({ payload }),
    unlistened: () => unlistened,
    failApply: () => {
      failApply = true;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("startDeepLinkReceiver", () => {
  it("applies the links that waited, in order, and reports the active folder after each", async () => {
    const r = setup(["noren://open?path=%2Fa", "noren://open?path=%2Fb"]);
    await settle();
    expect(r.applied).toEqual(["noren://open?path=%2Fa", "noren://open?path=%2Fb"]);
    expect(r.calls.filter((c) => c.command === APPLIED_COMMAND)).toEqual([
      { command: APPLIED_COMMAND, args: { folder: "/srv/proj" } },
      { command: APPLIED_COMMAND, args: { folder: "/srv/proj" } },
    ]);
  });

  it("listens before it asks for the waiting links", async () => {
    const r = setup(["noren://open?path=%2Fa"]);
    await settle();
    // The take-waiting call is the first invoke; the listener was registered by then.
    expect(r.calls[0]?.command).toBe(TAKE_WAITING_COMMAND);
    r.fire("noren://open?path=%2Fb");
    await settle();
    expect(r.applied).toEqual(["noren://open?path=%2Fa", "noren://open?path=%2Fb"]);
  });

  it("hands a link to the entry point as the text it got", async () => {
    const raw = "noren://open?path=C%3A%5CUsers%5CJo%C3%A3o%5CMeus%20Projetos";
    const r = setup();
    await settle();
    r.fire(raw);
    await settle();
    expect(r.applied).toEqual([raw]);
  });

  it("ignores a payload that is not text", async () => {
    const r = setup([42, null, { url: "noren://open?path=%2Fa" }]);
    await settle();
    r.fire(undefined);
    r.fire(["noren://open?path=%2Fa"]);
    await settle();
    expect(r.applied).toEqual([]);
    expect(r.calls.some((c) => c.command === APPLIED_COMMAND)).toBe(false);
  });

  it("ignores a waiting list that is not a list", async () => {
    const r = setup("noren://open?path=%2Fa");
    await settle();
    expect(r.applied).toEqual([]);
  });

  it("reports no folder as null", async () => {
    const r = setup(["noren://open?path=%2Fa"], null);
    await settle();
    expect(r.calls.find((c) => c.command === APPLIED_COMMAND)?.args).toEqual({ folder: null });
  });

  it("keeps going after a link that fails to apply", async () => {
    const r = setup();
    await settle();
    r.failApply();
    r.fire("noren://open?path=%2Fa");
    r.fire("noren://open?path=%2Fb");
    await settle();
    expect(r.applied).toEqual(["noren://open?path=%2Fa", "noren://open?path=%2Fb"]);
  });

  it("stops listening when stopped", async () => {
    const r = setup();
    await settle();
    r.stop();
    expect(r.unlistened()).toBe(1);
    r.stop();
    expect(r.unlistened()).toBe(1);
  });

  it("stopped before the listener was ready: unlistens and takes nothing", async () => {
    const r = setup(["noren://open?path=%2Fa"]);
    r.stop();
    await settle();
    expect(r.unlistened()).toBe(1);
    expect(r.applied).toEqual([]);
    expect(r.calls.some((c) => c.command === TAKE_WAITING_COMMAND)).toBe(false);
  });
});
