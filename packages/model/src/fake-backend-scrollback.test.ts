import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";
import { MAX_SCROLLBACK_BYTES } from "./scrollback";

// The scrollback snapshots of the fake computer, which answer the way the real store promises.

const UUID = "3f2b8c1e-9d4a-4c7b-8e21-0a5d6f7b9c11";

describe("FakeBackend scrollback snapshots", () => {
  it("has no snapshot for a pane until one is saved", async () => {
    const backend = new FakeBackend();
    expect(await backend.loadScrollback(UUID)).toBeNull();
    expect(backend.scrollbackFiles).toEqual({});
  });

  it("saves, loads and deletes a snapshot as given, and records each call in order", async () => {
    const backend = new FakeBackend();
    const text = "\x1b[2mold é\x1b[0m\nlines";
    await backend.saveScrollback(UUID, text);
    expect(await backend.loadScrollback(UUID)).toBe(text);
    expect(backend.scrollbackFiles).toEqual({ [UUID]: text });
    await backend.saveScrollback(UUID, "second");
    expect(await backend.loadScrollback(UUID)).toBe("second");
    await backend.deleteScrollback(UUID);
    expect(await backend.loadScrollback(UUID)).toBeNull();
    expect(backend.scrollbackFiles).toEqual({});
    expect(backend.calls.map((call) => [call.method, call.args[0]])).toEqual([
      ["saveScrollback", UUID],
      ["loadScrollback", UUID],
      ["saveScrollback", UUID],
      ["loadScrollback", UUID],
      ["deleteScrollback", UUID],
      ["loadScrollback", UUID],
    ]);
    expect(backend.callsTo("saveScrollback")[0]?.args).toEqual([UUID, text]);
  });

  it("keeps the snapshot of one pane apart from the others", async () => {
    const backend = new FakeBackend();
    await backend.saveScrollback("pane-1", "one");
    await backend.saveScrollback("pane-2", "two");
    await backend.deleteScrollback("pane-1");
    expect(backend.scrollbackFiles).toEqual({ "pane-2": "two" });
  });

  it("deleting a pane that has none is not an error", async () => {
    const backend = new FakeBackend();
    await expect(backend.deleteScrollback("pane-9")).resolves.toBeUndefined();
  });

  it("refuses an id that is not a file name, for every method, and keeps nothing", async () => {
    const backend = new FakeBackend();
    for (const id of [
      "",
      "../escape",
      "a/b",
      "a\\b",
      "..",
      "con",
      "a.txt",
      "a b",
      "a".repeat(65),
    ]) {
      const message = `'${id}' is not a valid pane id`;
      await expect(backend.saveScrollback(id, "x"), id).rejects.toThrow(message);
      await expect(backend.loadScrollback(id), id).rejects.toThrow(message);
      await expect(backend.deleteScrollback(id), id).rejects.toThrow(message);
    }
    expect(backend.scrollbackFiles).toEqual({});
  });

  it("refuses a text over the limit of bytes and takes one exactly at it", async () => {
    const backend = new FakeBackend();
    await expect(
      backend.saveScrollback("pane-1", "x".repeat(MAX_SCROLLBACK_BYTES + 1)),
    ).rejects.toThrow("a snapshot is at most");
    expect(backend.scrollbackFiles).toEqual({});
    await backend.saveScrollback("pane-1", "x".repeat(MAX_SCROLLBACK_BYTES));
    expect(Object.keys(backend.scrollbackFiles)).toEqual(["pane-1"]);
    // The limit counts bytes of UTF-8, not characters.
    await expect(
      backend.saveScrollback("pane-2", "é".repeat(MAX_SCROLLBACK_BYTES / 2 + 1)),
    ).rejects.toThrow("a snapshot is at most");
  });

  it("starts with the files it was given and takes a file placed by hand", async () => {
    const backend = new FakeBackend({ scrollback: { "pane-1": "from before" } });
    expect(await backend.loadScrollback("pane-1")).toBe("from before");
    backend.setScrollback("pane-2", "by hand");
    expect(await backend.loadScrollback("pane-2")).toBe("by hand");
    backend.setScrollback("pane-2", null);
    expect(await backend.loadScrollback("pane-2")).toBeNull();
    // Placing a file is not a call of the backend.
    expect(backend.callsTo("saveScrollback")).toEqual([]);
  });

  it("rejects when the disk refuses, and keeps what it had", async () => {
    const backend = new FakeBackend({ scrollback: { "pane-1": "kept" } });
    backend.setScrollbackFailure(new Error("disk full"));
    await expect(backend.saveScrollback("pane-1", "new")).rejects.toThrow("disk full");
    await expect(backend.deleteScrollback("pane-1")).rejects.toThrow("disk full");
    expect(backend.scrollbackFiles).toEqual({ "pane-1": "kept" });
    // Reading still works, and the failure goes away.
    expect(await backend.loadScrollback("pane-1")).toBe("kept");
    backend.setScrollbackFailure(undefined);
    await backend.saveScrollback("pane-1", "new");
    expect(backend.scrollbackFiles).toEqual({ "pane-1": "new" });
  });

  it("touches nothing else it keeps: no state, no config, no theme", async () => {
    const backend = new FakeBackend();
    await backend.saveScrollback("pane-1", "x");
    expect(backend.stateContent).toBeNull();
    expect(backend.configContent).toBeNull();
    expect(backend.userThemeFiles).toEqual({});
  });
});
