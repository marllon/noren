import { describe, expect, it } from "vitest";
import { ConfigManager, FakeBackend } from "@noren/model";
import { followKeepSessions } from "./keep-sessions-sync";

// `sessions.keepOnClose` of the file reaches the backend (`setKeepSessions`) when the settings are
// first in force and when the value changes, in order, and a refusal stops nothing.

/** The values the fake backend was handed, in order. */
const handed = (fake: FakeBackend): unknown[] =>
  fake.callsTo("setKeepSessions").map((call) => call.args[0]);

async function started(text: string | null) {
  const fake = new FakeBackend({ config: text });
  const manager = new ConfigManager();
  await manager.start(fake);
  const follow = followKeepSessions(manager, fake);
  await follow.settled();
  return { fake, manager, follow };
}

describe("handing sessions.keepOnClose to the backend", () => {
  it("keeps the shells by default: no file, an empty file, or a file that does not say", async () => {
    for (const text of [null, "{}", '{ "sessions": {} }', '{ "terminal": { "scrollback": 50 } }']) {
      const { fake } = await started(text);
      expect(handed(fake), String(text)).toEqual([true]);
      expect(fake.keepSessions).toBe(true);
    }
  });

  it("hands over false when the file turns it off", async () => {
    const { fake } = await started('{ "sessions": { "keepOnClose": false } }');
    expect(handed(fake)).toEqual([false]);
    expect(fake.keepSessions).toBe(false);
  });

  it("hands over the new value when the file changes it, and not when another setting does", async () => {
    const { fake, follow } = await started('{ "sessions": { "keepOnClose": true } }');

    fake.setConfig('{ "sessions": { "keepOnClose": false } }');
    await follow.settled();
    expect(handed(fake)).toEqual([true, false]);

    // Another setting, a comment, the same value: nothing is handed over.
    fake.setConfig(
      '{ "sessions": { "keepOnClose": false }, "notifications": { "enabled": false } // quiet\n }',
    );
    await follow.settled();
    expect(handed(fake)).toEqual([true, false]);

    // Taking the line out goes back to the default.
    fake.setConfig("{}");
    await follow.settled();
    expect(handed(fake)).toEqual([true, false, true]);
    expect(fake.keepSessions).toBe(true);
  });

  it("hands over the value the settings screen writes (an update of the manager)", async () => {
    const { fake, manager, follow } = await started("{}");
    const result = await manager.update([{ path: ["sessions", "keepOnClose"], value: false }]);
    expect(result.ok).toBe(true);
    await follow.settled();
    expect(handed(fake)).toEqual([true, false]);
  });

  it("keeps the setting of an invalid file: the last valid settings stay in force", async () => {
    const { fake, follow } = await started('{ "sessions": { "keepOnClose": false } }');
    fake.setConfig('{ "sessions": { "keepOnClose": "yes" } }');
    await follow.settled();
    expect(handed(fake)).toEqual([false]);
    expect(fake.keepSessions).toBe(false);
  });

  it("tries a value again at the next change when the backend refused it, and never rejects", async () => {
    const fake = new FakeBackend({ config: '{ "sessions": { "keepOnClose": false } }' });
    const manager = new ConfigManager();
    await manager.start(fake);
    let refuse = true;
    const calls: boolean[] = [];
    const flaky = {
      setKeepSessions: async (keep: boolean) => {
        calls.push(keep);
        if (refuse) throw new Error("the backend would not take it");
      },
    };
    const follow = followKeepSessions(manager, flaky);
    await expect(follow.settled()).resolves.toBeUndefined();
    expect(calls).toEqual([false]);

    refuse = false;
    fake.setConfig(
      '{ "sessions": { "keepOnClose": false }, "notifications": { "enabled": true } }',
    );
    await follow.settled();
    expect(calls, "the same value is handed over again after a refusal").toEqual([false, false]);
  });

  it("stops handing over when it is stopped", async () => {
    const { fake, follow } = await started("{}");
    follow.stop();
    fake.setConfig('{ "sessions": { "keepOnClose": false } }');
    await follow.settled();
    expect(handed(fake)).toEqual([true]);
  });
});
