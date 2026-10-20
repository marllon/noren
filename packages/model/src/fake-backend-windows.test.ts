import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";

describe("FakeBackend windows", () => {
  it("opens a window on a space and tells it is open", async () => {
    const backend = new FakeBackend();
    expect(backend.windows()).toEqual([]);
    await backend.openWindow("w1", "s2");
    await backend.openWindow("w2", "s3");
    expect(backend.windows()).toEqual([
      { id: "w1", spaceId: "s2", sessions: [] },
      { id: "w2", spaceId: "s3", sessions: [] },
    ]);
    expect(backend.callsTo("openWindow").map((call) => call.args)).toEqual([
      ["w1", "s2"],
      ["w2", "s3"],
    ]);
  });

  it("refuses what the real one refuses: a name that is no window id, a blank space, a window open already", async () => {
    const backend = new FakeBackend();
    await expect(backend.openWindow("a b", "s2")).rejects.toThrow("not a window id");
    await expect(backend.openWindow("", "s2")).rejects.toThrow("not a window id");
    await expect(backend.openWindow("w/1", "s2")).rejects.toThrow("not a window id");
    await expect(backend.openWindow("w1", "  ")).rejects.toThrow("needs the space");
    await backend.openWindow("w1", "s2");
    await expect(backend.openWindow("w1", "s3")).rejects.toThrow("open already");
    expect(backend.windows().map((w) => w.id)).toEqual(["w1"]);
  });

  it("moves a tab by moving its sessions, which stay the same live sessions", async () => {
    const backend = new FakeBackend();
    const a = await backend.createSession({ cols: 80, rows: 24 });
    const b = await backend.createSession({ cols: 80, rows: 24 });
    await backend.openWindow("w1", "s2");
    expect(backend.windowOfSession(a)).toBeUndefined();

    await backend.moveTabToWindow("w1", [a, b]);
    expect(backend.windowOfSession(a)).toBe("w1");
    expect(backend.windowOfSession(b)).toBe("w1");
    expect(backend.windows()[0]?.sessions).toEqual([a, b]);

    // Still running, under the same ids: it takes input and answers.
    const seen: string[] = [];
    backend.onOutput(a, (data) => seen.push(new TextDecoder().decode(data)));
    await backend.write(a, "echo moved\r");
    expect(seen.join("")).toContain("moved");
  });

  it("moves the sessions on to another window, and each one is in one window only", async () => {
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.openWindow("w1", "s2");
    await backend.openWindow("w2", "s3");
    await backend.moveTabToWindow("w1", [id]);
    await backend.moveTabToWindow("w2", [id]);
    expect(backend.windowOfSession(id)).toBe("w2");
    expect(backend.windows().map((w) => w.sessions)).toEqual([[], [id]]);
  });

  it("a tab with no shell has nothing to take, and still needs the window", async () => {
    const backend = new FakeBackend();
    await backend.openWindow("w1", "s2");
    await expect(backend.moveTabToWindow("w1", [])).resolves.toBeUndefined();
    await expect(backend.moveTabToWindow("w9", [])).rejects.toThrow("not open");
  });

  it("refuses a window that is not open and a session that is not alive, moving none", async () => {
    const backend = new FakeBackend();
    const live = await backend.createSession({ cols: 80, rows: 24 });
    const dead = await backend.createSession({ cols: 80, rows: 24 });
    await backend.kill(dead);
    await expect(backend.moveTabToWindow("w1", [live])).rejects.toThrow("not open");
    await backend.openWindow("w1", "s2");
    await expect(backend.moveTabToWindow("w1", [live, dead])).rejects.toThrow("unknown session");
    await expect(backend.moveTabToWindow("w1", [live, 999])).rejects.toThrow("unknown session");
    expect(backend.windowOfSession(live)).toBeUndefined();
  });

  it("closing a window ends no session and tells nobody, and closing one that is not open is fine", async () => {
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.openWindow("w1", "s2");
    await backend.moveTabToWindow("w1", [id]);
    const closed: string[] = [];
    backend.onWindowClosed((windowId) => closed.push(windowId));
    const exits: number[] = [];
    backend.onExit((exit) => exits.push(exit.id));

    await backend.closeWindow("w1");
    expect(backend.windows()).toEqual([]);
    expect(backend.windowOfSession(id)).toBeUndefined();
    expect(closed).toEqual([]);
    expect(exits).toEqual([]);
    await expect(backend.write(id, "echo alive\r")).resolves.toBeUndefined();
    await expect(backend.closeWindow("w1")).resolves.toBeUndefined();
    // The same name can be opened again.
    await expect(backend.openWindow("w1", "s2")).resolves.toBeUndefined();
  });

  it("tells whoever listens when the person closes a window, once, and not after they stop listening", async () => {
    const backend = new FakeBackend();
    await backend.openWindow("w1", "s2");
    await backend.openWindow("w2", "s3");
    const closed: string[] = [];
    const stop = backend.onWindowClosed((windowId) => closed.push(windowId));
    backend.closeWindowByPerson("w1");
    backend.closeWindowByPerson("w1");
    backend.closeWindowByPerson("never");
    expect(closed).toEqual(["w1"]);
    expect(backend.windows().map((w) => w.id)).toEqual(["w2"]);
    stop();
    backend.closeWindowByPerson("w2");
    expect(closed).toEqual(["w1"]);
  });
});

describe("FakeBackend window host", () => {
  function host() {
    const heard: string[] = [];
    let refuse: string | undefined;
    return {
      heard,
      refuseWith(reason: string | undefined) {
        refuse = reason;
      },
      host: {
        opened: (windowId: string, spaceId: string) =>
          void heard.push(`opened ${windowId} ${spaceId}`),
        closed: (windowId: string) => void heard.push(`closed ${windowId}`),
        take: async (windowId: string, sessionIds: readonly number[]) => {
          heard.push(`take ${windowId} ${sessionIds.join(",")}`);
          if (refuse !== undefined) throw new Error(refuse);
        },
      },
    };
  }

  it("hears of a window opened and closed, by the app or by the person, and of the sessions moved to it", async () => {
    const backend = new FakeBackend();
    const { heard, host: standIn } = host();
    backend.setWindowHost(standIn);
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.openWindow("w1", "s2");
    await backend.openWindow("w2", "s3");
    await backend.moveTabToWindow("w1", [id]);
    await backend.closeWindow("w1");
    backend.closeWindowByPerson("w2");
    // A window that is gone is not heard of twice.
    await backend.closeWindow("w1");
    backend.closeWindowByPerson("w2");
    expect(heard).toEqual([
      "opened w1 s2",
      "opened w2 s3",
      `take w1 ${id}`,
      "closed w1",
      "closed w2",
    ]);
  });

  it("fails the move, and leaves the sessions where they were, when the window refuses them", async () => {
    const backend = new FakeBackend();
    const { host: standIn, refuseWith } = host();
    backend.setWindowHost(standIn);
    const id = await backend.createSession({ cols: 80, rows: 24 });
    await backend.openWindow("w1", "s2");
    refuseWith("the page did not answer");
    await expect(backend.moveTabToWindow("w1", [id])).rejects.toThrow("did not answer");
    expect(backend.windowOfSession(id)).toBeUndefined();
    refuseWith(undefined);
    await backend.moveTabToWindow("w1", [id]);
    expect(backend.windowOfSession(id)).toBe("w1");
  });

  it("works with no host, and a host can be taken away", async () => {
    const backend = new FakeBackend();
    const { heard, host: standIn } = host();
    backend.setWindowHost(standIn);
    backend.setWindowHost(undefined);
    await backend.openWindow("w1", "s2");
    await backend.closeWindow("w1");
    expect(heard).toEqual([]);
  });
});
