import { FakeBackend, layoutPanes } from "@noren/model";
import type { Item, Pane } from "@noren/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySessionLink,
  failedSessionsOf,
  forgetSessionLink,
  linkOfPane,
  linkOfSession,
  resetSessionLinks,
  retryFailedLinks,
  startSessionLinks,
  subscribeSessionLinks,
} from "./session-link-store";

const pane = (id: string, sessionId?: string): Pane => ({
  id,
  type: "terminal",
  profileId: "build",
  status: "running",
  unread: false,
  bell: false,
  ...(sessionId !== undefined ? { sessionId } : {}),
});

const tab = (...panes: Pane[]): Item => ({
  id: "i1",
  titleLocked: false,
  layout:
    panes.length === 1 && panes[0] !== undefined
      ? { kind: "pane", pane: panes[0] }
      : {
          kind: "split",
          dir: "row",
          sizes: panes.map(() => 100 / panes.length),
          children: panes.map((p) => ({ kind: "pane" as const, pane: p })),
        },
  focusedPaneId: panes[0]?.id ?? "",
  lastActivityAt: 0,
});

async function withSshProfile(): Promise<FakeBackend> {
  const backend = new FakeBackend({
    profiles: [{ id: "pwsh", name: "PowerShell", default: true }],
    home: "/home/me",
  });
  await backend.setUserProfiles([
    { kind: "ssh", id: "build", name: "Build", host: "build.example.org" },
  ]);
  return backend;
}

beforeEach(() => resetSessionLinks());
afterEach(() => resetSessionLinks());

describe("the connection of each session", () => {
  it("is up (no entry) until the backend says otherwise, and keeps what it says", () => {
    expect(linkOfSession(7)).toBeUndefined();
    applySessionLink({ id: 7, state: "reconnecting", attempt: 2, maxAttempts: 10, reason: "lost" });
    expect(linkOfSession(7)).toEqual({
      id: 7,
      state: "reconnecting",
      attempt: 2,
      maxAttempts: 10,
      reason: "lost",
    });
    applySessionLink({ id: 7, state: "failed", reason: "refused" });
    expect(linkOfSession(7)).toEqual({ id: 7, state: "failed", reason: "refused" });
  });

  it("forgets the entry when the connection is back, and does not tell anyone twice about the same fact", () => {
    const seen = vi.fn();
    const stop = subscribeSessionLinks(seen);
    applySessionLink({ id: 7, state: "reconnecting", attempt: 1, maxAttempts: 10 });
    applySessionLink({ id: 7, state: "reconnecting", attempt: 1, maxAttempts: 10 });
    expect(seen).toHaveBeenCalledTimes(1);
    applySessionLink({ id: 7, state: "reconnecting", attempt: 2, maxAttempts: 10 });
    expect(seen).toHaveBeenCalledTimes(2);
    applySessionLink({ id: 7, state: "connected" });
    expect(linkOfSession(7)).toBeUndefined();
    expect(seen).toHaveBeenCalledTimes(3);
    // A session that is up and is told so changes nothing.
    applySessionLink({ id: 7, state: "connected" });
    expect(seen).toHaveBeenCalledTimes(3);
    stop();
    applySessionLink({ id: 8, state: "failed" });
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("keeps the sessions apart and forgets one that ended", () => {
    applySessionLink({ id: 1, state: "failed", reason: "a" });
    applySessionLink({ id: 2, state: "reconnecting" });
    forgetSessionLink(1);
    expect(linkOfSession(1)).toBeUndefined();
    expect(linkOfSession(2)?.state).toBe("reconnecting");
    forgetSessionLink(1);
  });

  it("is read through the session of a pane, as a number", () => {
    applySessionLink({ id: 12, state: "failed" });
    expect(linkOfPane(pane("p1", "12"))?.state).toBe("failed");
    expect(linkOfPane(pane("p2", "13"))).toBeUndefined();
    expect(linkOfPane(pane("p3"))).toBeUndefined();
  });
});

describe("following a backend", () => {
  it("takes the events of the backend, forgets a session that ends, and stops when told", async () => {
    const backend = await withSshProfile();
    const stop = startSessionLinks(backend);
    const id = await backend.createSession({ profileId: "build", cols: 80, rows: 24 });
    backend.setSessionLink(id, { state: "reconnecting", attempt: 1, maxAttempts: 20 });
    expect(linkOfSession(id)?.state).toBe("reconnecting");
    backend.setProfileLink("build", { state: "failed", reason: "no route" });
    expect(linkOfSession(id)).toMatchObject({ state: "failed", reason: "no route" });
    backend.setProfileLink("build", { state: "connected" });
    expect(linkOfSession(id)).toBeUndefined();

    backend.setSessionLink(id, { state: "failed", reason: "x" });
    await backend.kill(id);
    expect(linkOfSession(id)).toBeUndefined();

    const other = await backend.createSession({ profileId: "build", cols: 80, rows: 24 });
    stop();
    backend.setSessionLink(other, { state: "failed" });
    expect(linkOfSession(other)).toBeUndefined();
  });
});

describe("try again", () => {
  it("asks for the sessions of the tab that gave up, and only those", async () => {
    const backend = await withSshProfile();
    const stop = startSessionLinks(backend);
    const a = await backend.createSession({ profileId: "build", cols: 80, rows: 24 });
    const b = await backend.createSession({ profileId: "build", cols: 80, rows: 24 });
    const c = await backend.createSession({ profileId: "build", cols: 80, rows: 24 });
    backend.setSessionLink(a, { state: "failed", reason: "refused" });
    backend.setSessionLink(b, { state: "reconnecting", attempt: 1, maxAttempts: 20 });
    const item = tab(
      pane("pa", String(a)),
      pane("pb", String(b)),
      pane("pc", String(c)),
      pane("pd"),
    );
    expect(failedSessionsOf(item)).toEqual([a]);

    await retryFailedLinks(backend, item);
    expect(backend.callsTo("retrySession").map((call) => call.args[0])).toEqual([a]);
    // The state that follows comes from the backend's event: the fake moves a retry to attempt 1.
    expect(linkOfSession(a)).toMatchObject({ state: "reconnecting", attempt: 1 });
    expect(layoutPanes(item.layout)).toHaveLength(4);
    stop();
  });

  it("does nothing for a tab with no failed connection, and survives a refused call", async () => {
    const calls: number[] = [];
    const backend = {
      retrySession: (id: number) => {
        calls.push(id);
        return Promise.reject(new Error("unknown session"));
      },
    };
    await retryFailedLinks(backend, tab(pane("p1", "5")));
    expect(calls).toEqual([]);
    applySessionLink({ id: 5, state: "failed" });
    await expect(retryFailedLinks(backend, tab(pane("p1", "5")))).resolves.toBeUndefined();
    expect(calls).toEqual([5]);
  });
});
