import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ManualClock } from "@noren/model";
import {
  CLOSE_LISTENING_COMMAND,
  CLOSE_READY_COMMAND,
  CLOSE_REQUESTED_EVENT,
  CLOSE_PUSH_LIMIT_MS,
  CLOSE_SAVE_LIMIT_MS,
  closeLimitMs,
  followWindowClose,
  saveWithin,
} from "./close-handler";
import type { CloseBridge } from "./close-handler";

// The page's half of closing the window: it listens, saves, and tells the Rust side to close.

function fakeBridge() {
  const log: string[] = [];
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const failing = new Set<string>();
  let unlistened = 0;
  const bridge: CloseBridge = {
    invoke: <T>(command: string) => {
      log.push(`invoke ${command}`);
      if (failing.has(command)) return Promise.reject(new Error(`${command} failed`));
      return Promise.resolve(undefined as T);
    },
    listen: (event, handler) => {
      log.push(`listen ${event}`);
      handlers.set(event, handler as (event: { payload: unknown }) => void);
      return Promise.resolve(() => {
        unlistened++;
      });
    },
  };
  return {
    bridge,
    log,
    failing,
    unlistened: () => unlistened,
    ask: () => handlers.get(CLOSE_REQUESTED_EVENT)?.({ payload: null }),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("followWindowClose", () => {
  it("listens first and only then tells the Rust side the page listens", async () => {
    const fake = fakeBridge();
    await followWindowClose(fake.bridge, () => Promise.resolve(), new ManualClock());
    expect(fake.log).toEqual([
      `listen ${CLOSE_REQUESTED_EVENT}`,
      `invoke ${CLOSE_LISTENING_COMMAND}`,
    ]);
  });

  it("saves when the window is asked to close and tells the Rust side it is done", async () => {
    const fake = fakeBridge();
    const steps: string[] = [];
    await followWindowClose(
      fake.bridge,
      async () => {
        steps.push("saving");
        await settle();
        steps.push("saved");
      },
      new ManualClock(),
    );
    fake.ask();
    await settle();
    await settle();
    expect(steps).toEqual(["saving", "saved"]);
    expect(fake.log.at(-1)).toBe(`invoke ${CLOSE_READY_COMMAND}`);
    expect(fake.log.filter((line) => line === `invoke ${CLOSE_READY_COMMAND}`)).toHaveLength(1);
  });

  it("does not tell the Rust side it is done while the save is still running", async () => {
    const fake = fakeBridge();
    const gate: { release?: () => void } = {};
    await followWindowClose(
      fake.bridge,
      () =>
        new Promise<void>((resolve) => {
          gate.release = resolve;
        }),
      new ManualClock(),
    );
    fake.ask();
    await settle();
    expect(fake.log).not.toContain(`invoke ${CLOSE_READY_COMMAND}`);
    gate.release?.();
    await settle();
    expect(fake.log.at(-1)).toBe(`invoke ${CLOSE_READY_COMMAND}`);
  });

  it("lets the window close after the limit when the save is too slow", async () => {
    const fake = fakeBridge();
    const clock = new ManualClock();
    await followWindowClose(fake.bridge, () => new Promise<void>(() => undefined), clock);
    fake.ask();
    await settle();
    clock.advance(CLOSE_SAVE_LIMIT_MS - 1);
    await settle();
    expect(fake.log).not.toContain(`invoke ${CLOSE_READY_COMMAND}`);
    clock.advance(1);
    await settle();
    expect(fake.log.at(-1)).toBe(`invoke ${CLOSE_READY_COMMAND}`);
  });

  it("reads the limit when the window is asked to close, so a setting changed since counts", async () => {
    const fake = fakeBridge();
    const clock = new ManualClock();
    let pushOnClose = false;
    await followWindowClose(
      fake.bridge,
      () => new Promise<void>(() => undefined),
      clock,
      () => closeLimitMs(pushOnClose),
    );
    pushOnClose = true;
    fake.ask();
    await settle();
    clock.advance(CLOSE_SAVE_LIMIT_MS);
    await settle();
    expect(fake.log).not.toContain(`invoke ${CLOSE_READY_COMMAND}`);
    clock.advance(CLOSE_PUSH_LIMIT_MS);
    await settle();
    expect(fake.log.at(-1)).toBe(`invoke ${CLOSE_READY_COMMAND}`);
  });

  it("lets the window close when the save fails", async () => {
    const fake = fakeBridge();
    await followWindowClose(
      fake.bridge,
      () => Promise.reject(new Error("disk full")),
      new ManualClock(),
    );
    fake.ask();
    await settle();
    expect(fake.log.at(-1)).toBe(`invoke ${CLOSE_READY_COMMAND}`);
  });

  it("answers a request once, however many times it is heard", async () => {
    const fake = fakeBridge();
    let saves = 0;
    await followWindowClose(
      fake.bridge,
      () => {
        saves++;
        return Promise.resolve();
      },
      new ManualClock(),
    );
    fake.ask();
    fake.ask();
    await settle();
    expect(saves).toBe(1);
    expect(fake.log.filter((line) => line === `invoke ${CLOSE_READY_COMMAND}`)).toHaveLength(1);
  });

  it("stops listening when asked, and when the Rust side cannot be told", async () => {
    const fake = fakeBridge();
    const stop = await followWindowClose(fake.bridge, () => Promise.resolve(), new ManualClock());
    stop();
    expect(fake.unlistened()).toBe(1);

    const broken = fakeBridge();
    broken.failing.add(CLOSE_LISTENING_COMMAND);
    await expect(
      followWindowClose(broken.bridge, () => Promise.resolve(), new ManualClock()),
    ).rejects.toThrow("failed");
    // Not left listening for a close that nobody waits for.
    expect(broken.unlistened()).toBe(1);
  });

  it("uses the names the Rust side has", () => {
    const rust = readFileSync(new URL("../src-tauri/src/lifecycle.rs", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
    expect(rust).toContain(`pub const CLOSE_REQUESTED_EVENT: &str = "${CLOSE_REQUESTED_EVENT}";`);
    expect(rust).toContain(`fn ${CLOSE_LISTENING_COMMAND}(`);
    expect(rust).toContain(`fn ${CLOSE_READY_COMMAND}(`);
    expect(main).toContain(`lifecycle::${CLOSE_LISTENING_COMMAND},`);
    expect(main).toContain(`lifecycle::${CLOSE_READY_COMMAND},`);
    // The page gives up before the window does, even with the push on close on.
    const wait = /CLOSE_WAIT: Duration = Duration::from_secs\((\d+)\)/.exec(rust);
    expect(Number(wait?.[1]) * 1000).toBeGreaterThan(closeLimitMs(true));
    expect(closeLimitMs(false)).toBe(CLOSE_SAVE_LIMIT_MS);
  });
});

describe("saveWithin", () => {
  it("resolves when the save is done, and cancels the timer", async () => {
    const clock = new ManualClock();
    await saveWithin(() => Promise.resolve(), clock, 1000);
    expect(clock.pending).toBe(0);
  });

  it("resolves after the limit for a save that never ends, and when the save fails", async () => {
    const clock = new ManualClock();
    let done = false;
    void saveWithin(() => new Promise<void>(() => undefined), clock, 1000).then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    clock.advance(1000);
    await settle();
    expect(done).toBe(true);
    await expect(
      saveWithin(() => Promise.reject(new Error("no")), new ManualClock(), 1000),
    ).resolves.toBeUndefined();
  });
});
