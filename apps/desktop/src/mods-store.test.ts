import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend } from "@noren/model";
import type { Backend, ModFile, Unsubscribe } from "@noren/model";
import { getModFiles, resetMods, setModFiles, startMods } from "./mods-store";

afterEach(() => {
  resetMods();
});

const file = (name: string, text = ""): ModFile => ({ name, text });

describe("the mod files", () => {
  it("start empty and take a list", () => {
    expect(getModFiles()).toEqual([]);
    setModFiles([file("a.css")]);
    expect(getModFiles()).toEqual([file("a.css")]);
  });

  it("keep the same list object when a list equal to it arrives", () => {
    setModFiles([file("a.css", "x")]);
    const held = getModFiles();
    setModFiles([file("a.css", "x")]);
    expect(getModFiles()).toBe(held);
    setModFiles([file("a.css", "y")]);
    expect(getModFiles()).not.toBe(held);
  });
});

describe("startMods", () => {
  it("lists the folder before it resolves, so the first frame has the mods", async () => {
    const backend = new FakeBackend({ mods: { "b.css": "b", "a.css": "a" } });
    await startMods(backend);
    expect(getModFiles()).toEqual([file("a.css", "a"), file("b.css", "b")]);
  });

  it("watches first and lists after, so a change in between is not lost", async () => {
    const backend = new FakeBackend({ mods: { "a.css": "1" } });
    await startMods(backend);
    expect(backend.calls.map((call) => call.method)).toEqual(["watchMods", "listMods"]);
  });

  it("follows the folder: an added, edited and removed file reach the list", async () => {
    const backend = new FakeBackend({ mods: { "a.css": "1" } });
    await startMods(backend);
    backend.setMod("b.css", "2");
    expect(getModFiles().map((f) => f.name)).toEqual(["a.css", "b.css"]);
    backend.setMod("a.css", "1 edited");
    expect(getModFiles()[0]).toEqual(file("a.css", "1 edited"));
    backend.setMod("a.css", null);
    expect(getModFiles()).toEqual([file("b.css", "2")]);
  });

  it("lets a change that arrives while the first list is on its way win over that list", async () => {
    // The watcher hears about `b.css` before `listMods` answers with the older list.
    class Racing extends FakeBackend {
      override async listMods(): Promise<ModFile[]> {
        const older = await super.listMods();
        this.setMod("b.css", "newer");
        return older;
      }
    }
    const backend = new Racing({ mods: { "a.css": "" } });
    await startMods(backend);
    expect(getModFiles().map((f) => f.name)).toEqual(["a.css", "b.css"]);
  });

  it("goes on without mods when the folder cannot be read, and still follows it", async () => {
    const backend = new FakeBackend({ mods: { "a.css": "" } });
    backend.setModListFailure(new Error("no permission"));
    await expect(startMods(backend)).resolves.toBeUndefined();
    expect(getModFiles()).toEqual([]);
    backend.setModListFailure(undefined);
    backend.setMod("b.css", "ok");
    expect(getModFiles().map((f) => f.name)).toEqual(["a.css", "b.css"]);
  });

  it("drops the watching of the backend it followed before", async () => {
    const first = new FakeBackend({ mods: { "a.css": "" } });
    await startMods(first);
    const second = new FakeBackend({ mods: { "z.css": "" } });
    await startMods(second);
    first.setMod("late.css", "x");
    expect(getModFiles().map((f) => f.name)).toEqual(["z.css"]);
  });

  it("stops following when reset", async () => {
    let stopped = 0;
    const backend: Pick<Backend, "listMods" | "watchMods"> = {
      listMods: () => Promise.resolve([]),
      watchMods: (): Unsubscribe => () => {
        stopped++;
      },
    };
    await startMods(backend);
    resetMods();
    expect(stopped).toBe(1);
    expect(getModFiles()).toEqual([]);
  });
});
