import { describe, expect, it } from "vitest";
import { FAKE_REPLAY_BYTES, FakeBackend } from "./fake-backend";

// `attachSession(id, { replay: true })`: the terminal that is about to be drawn for a session that
// printed already (a window that got the tab, the main window getting it back) is shown what the
// session printed before, ahead of what it prints next (NOR-F15-04c).

const text = (chunks: Uint8Array[]): string =>
  chunks.map((c) => new TextDecoder().decode(c)).join("");

/** Subscribes to a session and collects what it delivers. */
function listen(backend: FakeBackend, id: number): Uint8Array[] {
  const seen: Uint8Array[] = [];
  backend.onOutput(id, (data) => seen.push(data));
  return seen;
}

describe("FakeBackend attachSession with replay", () => {
  it("gives the new subscriber what the session printed before, then what it prints next", async () => {
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    // The first page draws a terminal and works in it.
    const first = listen(backend, id);
    await backend.write(id, "echo before\r");
    expect(text(first)).toContain("before");

    await backend.attachSession(id, { replay: true });
    const second = listen(backend, id);
    // Everything the session printed so far, in order, is the first thing the new page gets.
    expect(text(second)).toBe(text(first));

    await backend.write(id, "echo after\r");
    expect(text(second)).toContain("after");
    expect(text(second).indexOf("before")).toBeLessThan(text(second).indexOf("after"));
    // The page that had the session gets nothing more: its output moved.
    expect(text(first)).not.toContain("after");
  });

  it("holds what comes in before the new page subscribes, and shows it once", async () => {
    // A control session that nobody takes over shows what the page should end up showing.
    const control = new FakeBackend();
    const controlId = await control.createSession({ cols: 80, rows: 24 });
    await control.write(controlId, "echo between\r");
    const expected = text(listen(control, controlId));

    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    listen(backend, id);
    await backend.attachSession(id, { replay: true });
    await backend.write(id, "echo between\r");
    const second = listen(backend, id);
    expect(text(second)).toBe(expected);
  });

  it("without the option the output moves and nothing earlier comes with it", async () => {
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    const first = listen(backend, id);
    await backend.write(id, "echo before\r");
    await backend.attachSession(id);
    const second = listen(backend, id);
    expect(second).toEqual([]);
    await backend.write(id, "echo after\r");
    expect(text(second)).toContain("after");
    expect(text(first)).toContain("before");
  });

  it("is on record with its options, and the call without options as before", async () => {
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.attachSession(id);
    await backend.attachSession(id, { replay: true });
    expect(backend.callsTo("attachSession").map((call) => call.args)).toEqual([
      [id],
      [id, { replay: true }],
    ]);
  });

  it("still rejects a session that is not alive", async () => {
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.kill(id);
    await expect(backend.attachSession(id, { replay: true })).rejects.toThrow();
    await expect(backend.attachSession(999, { replay: true })).rejects.toThrow();
  });

  it("keeps the latest megabyte, whole chunks, and drops the oldest", async () => {
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    const filler = "x".repeat(60 * 1024);
    const lines = Math.ceil((FAKE_REPLAY_BYTES * 2) / filler.length);
    for (let i = 0; i < lines; i++) backend.sendOutput(id, `${i}:${filler}\n`);
    backend.sendOutput(id, "the-last-line\n");
    await backend.attachSession(id, { replay: true });
    const seen = text(listen(backend, id));
    expect(seen.length).toBeLessThanOrEqual(FAKE_REPLAY_BYTES + filler.length + 16);
    expect(seen.endsWith("the-last-line\n")).toBe(true);
    expect(seen.startsWith("0:")).toBe(false);
  });
});
