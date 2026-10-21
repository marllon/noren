import {
  FakeBackend,
  createSequentialIds,
  layoutPanes,
  restoreWorkspace,
  workspaceWindows,
} from "@noren/model";
import type { BrowserBounds, Id, Pane } from "@noren/model";
import { describe, expect, it } from "vitest";
import { BrowserPaneView } from "./browser-view";
import { memoryQuickEvents } from "./quick";
import type { QuickEvents } from "./quick";
import {
  MAX_WINDOW_BROWSER_CALLS,
  WINDOW_BROWSER_EVENT,
  WINDOW_BROWSER_RESULT_EVENT,
  browserAskOfWindowRequest,
  browserPaneOfWindow,
  createWindowBrowsers,
  followWindowBrowsers,
} from "./window-browser";
import { actionOfWindowRequest } from "./window-sync";
import { moveItemToNewWindow, returnWindowTabs } from "./window-service";
import { createWorkspaceStore } from "./workspace-store";

const clock = { now: () => 1000 };

const URL_A = "https://example.com/a";
const URL_B = "https://example.org/b";
const URL_MAIN = "https://example.net/main";
const BOUNDS: BrowserBounds = { x: 12, y: 40, width: 600, height: 400 };

/**
 * A main window with three tabs, each a terminal beside a browser pane. The first (page URL_A) goes
 * to a window "A", the second (URL_B) to a window "B"; the third (URL_MAIN) stays in the main window.
 */
async function openMain(backend = new FakeBackend()) {
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  store.getState().newTab();
  store.getState().newTab();
  const space = () => {
    const ws = store.getState().workspace;
    return ws.spaces.find((s) => s.id === ws.activeSpaceId);
  };
  const [first, second, third] = Object.keys(space()?.items ?? {});
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("three tabs were expected");
  }
  const panesOf = (itemId: Id): Pane[] => {
    for (const s of store.getState().workspace.spaces) {
      const item = s.items[itemId];
      if (item !== undefined) return layoutPanes(item.layout);
    }
    return [];
  };
  const terminalOf = (itemId: Id): Id => {
    const pane = panesOf(itemId).find((p) => p.type === "terminal");
    if (pane === undefined) throw new Error("a terminal was expected");
    return pane.id;
  };
  for (const [itemId, url] of [
    [first, URL_A],
    [second, URL_B],
    [third, URL_MAIN],
  ] as const) {
    store.getState().dispatch({
      type: "pane/split",
      itemId,
      paneId: terminalOf(itemId),
      dir: "row",
      side: "after",
      url,
    });
  }
  for (const [itemId, name] of [
    [first, "A"],
    [second, "B"],
  ] as const) {
    const result = await moveItemToNewWindow(store, backend, itemId, name);
    if (!result.ok) throw new Error(result.reason);
  }
  const [windowA, windowB] = workspaceWindows(store.getState().workspace);
  if (windowA === undefined || windowB === undefined) throw new Error("two windows were expected");
  const browserOf = (itemId: Id): Pane => {
    const pane = panesOf(itemId).find((p) => p.type === "browser");
    if (pane === undefined) throw new Error("a browser pane was expected");
    return pane;
  };
  return {
    backend,
    store,
    windowA: windowA.id,
    windowB: windowB.id,
    first,
    second,
    third,
    browserOf,
    terminalOf,
  };
}

type Main = Awaited<ReturnType<typeof openMain>>;

/** What the page of `windowId` sends to open the web view of the browser pane of `itemId`. */
const openRequest = (main: Main, windowId: Id, itemId: Id, request = 1) => ({
  windowId,
  request,
  op: "open",
  itemId,
  paneId: main.browserOf(itemId).id,
  url: main.browserOf(itemId).url,
  bounds: BOUNDS,
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** The bus plus the answers that went through it. */
function recordingEvents(): { events: QuickEvents; answers: Record<string, unknown>[] } {
  const inner = memoryQuickEvents();
  const answers: Record<string, unknown>[] = [];
  return {
    answers,
    events: {
      listen: inner.listen,
      emit: async (event, payload) => {
        if (event === WINDOW_BROWSER_RESULT_EVENT) answers.push(payload as Record<string, unknown>);
        await inner.emit(event, payload);
      },
    },
  };
}

describe("browserAskOfWindowRequest", () => {
  it("accepts each of the four calls on a browser pane of a tab of the window", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const pane = main.browserOf(main.first);
    const own = openRequest(main, main.windowA, main.first, 3);
    expect(browserAskOfWindowRequest(own, ws)).toEqual({
      windowId: main.windowA,
      request: 3,
      call: { op: "open", paneId: pane.id, url: URL_A, bounds: BOUNDS },
    });
    expect(browserAskOfWindowRequest({ ...own, op: "navigate" }, ws)).toEqual({
      windowId: main.windowA,
      request: 3,
      call: { op: "navigate", paneId: pane.id, url: URL_A },
    });
    expect(browserAskOfWindowRequest({ ...own, op: "bounds" }, ws)).toEqual({
      windowId: main.windowA,
      request: 3,
      call: { op: "bounds", paneId: pane.id, bounds: BOUNDS },
    });
    expect(browserAskOfWindowRequest({ ...own, op: "close" }, ws)).toEqual({
      windowId: main.windowA,
      request: 3,
      call: { op: "close", paneId: pane.id },
    });
  });

  it("makes the call again from what it checked: nothing else the event carried gets through", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const asked = browserAskOfWindowRequest(
      {
        ...openRequest(main, main.windowA, main.first),
        extra: "/etc/passwd",
        bounds: { ...BOUNDS, extra: 1 },
      },
      ws,
    );
    expect(asked).toBeDefined();
    if (asked === undefined || !("call" in asked)) throw new Error("a call was expected");
    expect(Object.keys(asked.call).sort()).toEqual(["bounds", "op", "paneId", "url"]);
    expect(Object.keys(asked.call.op === "open" ? asked.call.bounds : {}).sort()).toEqual([
      "height",
      "width",
      "x",
      "y",
    ]);
  });

  it("ignores a call from a window the workspace does not have", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    for (const windowId of ["nope", "main", "window-x", "", "a b"]) {
      expect(
        browserAskOfWindowRequest({ ...openRequest(main, main.windowA, main.first), windowId }, ws),
        windowId,
      ).toBeUndefined();
    }
  });

  it("ignores a call for a pane of the main window or of the space of another window", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    for (const op of ["open", "navigate", "bounds", "close"]) {
      // The tab that stayed in the main window, asked for by a window.
      expect(
        browserAskOfWindowRequest({ ...openRequest(main, main.windowA, main.third), op }, ws),
        `${op} main`,
      ).toBeUndefined();
      // The tab of window B, asked for by window A.
      expect(
        browserAskOfWindowRequest({ ...openRequest(main, main.windowA, main.second), op }, ws),
        `${op} other window`,
      ).toBeUndefined();
      // Its own tab with the pane of another tab.
      expect(
        browserAskOfWindowRequest(
          {
            ...openRequest(main, main.windowA, main.first),
            op,
            paneId: main.browserOf(main.third).id,
          },
          ws,
        ),
        `${op} pane of another tab`,
      ).toBeUndefined();
    }
  });

  it("ignores a call for a pane that is not a browser pane, or does not exist", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const own = openRequest(main, main.windowA, main.first);
    expect(
      browserAskOfWindowRequest({ ...own, paneId: main.terminalOf(main.first) }, ws),
    ).toBeUndefined();
    expect(browserAskOfWindowRequest({ ...own, paneId: "ghost" }, ws)).toBeUndefined();
    expect(browserAskOfWindowRequest({ ...own, itemId: "ghost" }, ws)).toBeUndefined();
    expect(browserAskOfWindowRequest({ ...own, paneId: 3 }, ws)).toBeUndefined();
    expect(browserAskOfWindowRequest({ ...own, itemId: undefined }, ws)).toBeUndefined();
  });

  it("ignores an operation that is not one of the four, and a request number that is not one", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const own = openRequest(main, main.windowA, main.first);
    for (const op of ["reparent", "eval", "OPEN", "", undefined, 1, null]) {
      expect(browserAskOfWindowRequest({ ...own, op }, ws), String(op)).toBeUndefined();
    }
    for (const request of [0, -1, 1.5, "7", undefined, null, Number.NaN]) {
      expect(browserAskOfWindowRequest({ ...own, request }, ws), String(request)).toBeUndefined();
    }
    for (const payload of [undefined, null, "open", 3, []]) {
      expect(browserAskOfWindowRequest(payload, ws)).toBeUndefined();
    }
  });

  it("ignores an address the browser pane may not show, and bounds the backend would not take", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const own = openRequest(main, main.windowA, main.first);
    for (const url of [
      "javascript:alert(1)",
      "file:///C:/Windows/win.ini",
      "data:text/html,hi",
      "noren://open",
      "http://tauri.localhost/",
      "https://user@example.com/",
      "",
      3,
      undefined,
    ]) {
      for (const op of ["open", "navigate"]) {
        expect(browserAskOfWindowRequest({ ...own, op, url }, ws), `${op} ${url}`).toBeUndefined();
      }
    }
    const refused: unknown[] = [
      { ...BOUNDS, width: -1 },
      { ...BOUNDS, height: -1 },
      { ...BOUNDS, width: 40_000 },
      { ...BOUNDS, x: Number.POSITIVE_INFINITY },
      { ...BOUNDS, y: Number.NaN },
      { ...BOUNDS, x: "12" },
      { x: 1, y: 2, width: 3 },
      "10x10",
      null,
      undefined,
      [],
    ];
    for (const bounds of refused) {
      for (const op of ["open", "bounds"]) {
        expect(browserAskOfWindowRequest({ ...own, op, bounds }, ws), `${op}`).toBeUndefined();
      }
    }
  });

  it("refuses with a reason, and does not ignore, an address that is not the one the pane holds now", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const own = openRequest(main, main.windowA, main.first, 9);
    for (const op of ["open", "navigate"]) {
      expect(
        browserAskOfWindowRequest({ ...own, op, url: "https://example.org/else" }, ws),
      ).toEqual({
        windowId: main.windowA,
        request: 9,
        refusal: "the pane is at another address now",
      });
    }
    // Bounds and close name no address: they are not refused for one.
    expect(
      browserAskOfWindowRequest({ ...own, op: "bounds", url: "https://example.org/else" }, ws),
    ).toMatchObject({ call: { op: "bounds" } });
  });

  it("finds a browser pane only in the space the window shows", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const pane = main.browserOf(main.first);
    expect(browserPaneOfWindow(ws, main.windowA, pane.id)?.id).toBe(pane.id);
    expect(browserPaneOfWindow(ws, main.windowA, pane.id, main.first)?.id).toBe(pane.id);
    expect(browserPaneOfWindow(ws, main.windowA, pane.id, main.second)).toBeUndefined();
    expect(browserPaneOfWindow(ws, main.windowB, pane.id)).toBeUndefined();
    expect(browserPaneOfWindow(ws, "nope", pane.id)).toBeUndefined();
    expect(browserPaneOfWindow(ws, main.windowA, main.terminalOf(main.first))).toBeUndefined();
  });
});

describe("pane/set-url asked by a window", () => {
  it("is accepted for a browser pane of the window and an address the pane may show", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const paneId = main.browserOf(main.first).id;
    const request = {
      windowId: main.windowA,
      action: { type: "pane/set-url", itemId: main.first, paneId, url: "https://example.net/x" },
    };
    expect(actionOfWindowRequest(request, ws)).toEqual({
      type: "pane/set-url",
      itemId: main.first,
      paneId,
      url: "https://example.net/x",
    });
  });

  it("is ignored for anything else: another tab, a terminal, a bad address, extra fields", async () => {
    const main = await openMain();
    const ws = main.store.getState().workspace;
    const paneId = main.browserOf(main.first).id;
    const ask = (action: Record<string, unknown>, windowId: Id = main.windowA) =>
      actionOfWindowRequest({ windowId, action }, ws);
    const own = { type: "pane/set-url", itemId: main.first, paneId, url: "https://example.net/x" };
    expect(ask(own, main.windowB)).toBeUndefined();
    expect(
      ask({ ...own, itemId: main.third, paneId: main.browserOf(main.third).id }),
    ).toBeUndefined();
    expect(ask({ ...own, paneId: main.terminalOf(main.first) })).toBeUndefined();
    expect(ask({ ...own, paneId: "ghost" })).toBeUndefined();
    for (const url of ["javascript:1", "file:///x", "http://tauri.localhost/", "", 4, undefined]) {
      expect(ask({ ...own, url }), String(url)).toBeUndefined();
    }
    const kept = ask({ ...own, spaceId: "s", extra: 1 });
    expect(Object.keys(kept ?? {}).sort()).toEqual(["itemId", "paneId", "type", "url"]);
  });
});

describe("followWindowBrowsers", () => {
  /** Starts the main-window side and returns what the tests need. */
  async function start(main?: Main) {
    const m = main ?? (await openMain());
    const { events, answers } = recordingEvents();
    const stop = followWindowBrowsers(m.store, m.backend, events);
    // Listening is asynchronous.
    await settle();
    const send = (body: Record<string, unknown>) => events.emit(WINDOW_BROWSER_EVENT, body);
    return { m, events, answers, stop, send };
  }

  it("opens the web view as a child of the window that asked, and answers that window", async () => {
    const { m, answers, send, stop } = await start();
    const pane = m.browserOf(m.first);
    await send(openRequest(m, m.windowA, m.first, 5));
    await until(() => answers.length === 1, "the answer");
    expect(answers).toEqual([{ windowId: m.windowA, request: 5, ok: true }]);
    expect(m.backend.browserPane(pane.id)).toEqual({
      url: URL_A,
      bounds: BOUNDS,
      windowId: m.windowA,
    });
    expect(m.backend.browserPaneIds()).toEqual([pane.id]);
    stop();
  });

  it("navigates, moves and closes the web view it opened, each answered", async () => {
    const { m, answers, send, stop } = await start();
    const pane = m.browserOf(m.second);
    await send(openRequest(m, m.windowB, m.second, 1));
    await until(() => answers.length === 1, "open");
    // The address bar of the window changed the pane (the main window carries that out) ...
    m.store.getState().dispatch({
      type: "pane/set-url",
      itemId: m.second,
      paneId: pane.id,
      url: "https://example.net/next",
    });
    await send({
      ...openRequest(m, m.windowB, m.second, 2),
      op: "navigate",
      url: "https://example.net/next",
    });
    await until(() => answers.length === 2, "navigate");
    expect(m.backend.browserPane(pane.id)?.url).toBe("https://example.net/next");
    const moved = { x: 0, y: 8, width: 300, height: 200 };
    await send({ ...openRequest(m, m.windowB, m.second, 3), op: "bounds", bounds: moved });
    await until(() => answers.length === 3, "bounds");
    expect(m.backend.browserPane(pane.id)?.bounds).toEqual(moved);
    await send({ ...openRequest(m, m.windowB, m.second, 4), op: "close" });
    await until(() => answers.length === 4, "close");
    expect(m.backend.browserPane(pane.id)).toBeUndefined();
    expect(answers.every((a) => a["ok"] === true && a["windowId"] === m.windowB)).toBe(true);
    stop();
  });

  it("answers with the reason when the backend refuses, and when the address is not the pane's any more", async () => {
    const { m, answers, send, stop } = await start();
    await send({ ...openRequest(m, m.windowA, m.first, 1), op: "navigate" });
    await until(() => answers.length === 1, "navigate without a web view");
    expect(answers[0]).toEqual({
      windowId: m.windowA,
      request: 1,
      failed: `pane ${m.browserOf(m.first).id} has no web view`,
    });
    await send({ ...openRequest(m, m.windowA, m.first, 2), url: "https://example.org/else" });
    await until(() => answers.length === 2, "the stale address");
    expect(answers[1]).toEqual({
      windowId: m.windowA,
      request: 2,
      failed: "the pane is at another address now",
    });
    expect(m.backend.browserPaneIds()).toEqual([]);
    stop();
  });

  it("does nothing, and does not answer, for a call that is not the window's own", async () => {
    const { m, answers, send, stop } = await start();
    const before = m.backend.calls.length;
    const own = openRequest(m, m.windowA, m.first, 1);
    for (const body of [
      // A pane of the main window, and of the other window.
      openRequest(m, m.windowA, m.third, 2),
      openRequest(m, m.windowA, m.second, 3),
      { ...openRequest(m, m.windowB, m.second, 4), windowId: m.windowA },
      // A window that is not one, a terminal, an address it may not show, bounds it may not have.
      { ...own, request: 5, windowId: "main" },
      { ...own, request: 6, windowId: "ghost" },
      { ...own, request: 7, paneId: m.terminalOf(m.first) },
      { ...own, request: 8, url: "javascript:alert(1)" },
      { ...own, request: 9, bounds: { ...BOUNDS, width: -5 } },
      { ...own, request: 10, op: "reparent" },
      { ...own, request: 0 },
    ]) {
      await send(body);
    }
    // The right one, last: when it is answered the ones before it were heard and passed over.
    await send({ ...own, request: 11 });
    await until(() => answers.length === 1, "the right call");
    expect(answers).toEqual([{ windowId: m.windowA, request: 11, ok: true }]);
    expect(m.backend.calls.slice(before).map((c) => c.method)).toEqual(["openBrowserPane"]);
    expect(m.backend.browserPane(m.browserOf(m.first).id)?.windowId).toBe(m.windowA);
    expect(m.backend.browserPane(m.browserOf(m.third).id)).toBeUndefined();
    stop();
  });

  it("makes the calls of a pane one at a time and in order, and refuses past the limit", async () => {
    const { m, answers, send, stop } = await start();
    const pane = m.browserOf(m.first);
    await send(openRequest(m, m.windowA, m.first, 1));
    await until(() => answers.length === 1, "open");
    // The backend holds the moves of the web view until it is let go.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = m.backend.setBrowserPaneBounds.bind(m.backend);
    const order: number[] = [];
    m.backend.setBrowserPaneBounds = async (id, bounds) => {
      order.push(bounds.width);
      await gate;
      await real(id, bounds);
    };
    for (let n = 0; n < MAX_WINDOW_BROWSER_CALLS + 1; n++) {
      await send({
        ...openRequest(m, m.windowA, m.first, 100 + n),
        op: "bounds",
        bounds: { ...BOUNDS, width: 100 + n },
      });
    }
    await until(() => answers.length === 2, "the one past the limit");
    expect(answers[1]).toEqual({
      windowId: m.windowA,
      request: 100 + MAX_WINDOW_BROWSER_CALLS,
      failed: "too many calls at once",
    });
    // Only the first has reached the backend: the others wait behind it for the same pane.
    expect(order).toEqual([100]);
    release();
    await until(() => answers.length === MAX_WINDOW_BROWSER_CALLS + 2, "all of them");
    expect(order).toEqual(Array.from({ length: MAX_WINDOW_BROWSER_CALLS }, (_, n) => 100 + n));
    expect(m.backend.browserPane(pane.id)?.bounds.width).toBe(100 + MAX_WINDOW_BROWSER_CALLS - 1);
    stop();
  });

  it("closes the web view when the window gives its tab back, and the pane can then be opened in the main window", async () => {
    const { m, answers, send, stop } = await start();
    const pane = m.browserOf(m.first);
    await send(openRequest(m, m.windowA, m.first, 1));
    await until(() => answers.length === 1, "open");
    expect(m.backend.browserPane(pane.id)?.windowId).toBe(m.windowA);
    await returnWindowTabs(m.store, m.backend, m.windowA);
    await until(() => m.backend.browserPane(pane.id) === undefined, "the web view to close");
    // The pane is in the main window now: it opens there, as it always did.
    await m.backend.openBrowserPane(pane.id, URL_A, BOUNDS);
    expect(m.backend.browserPane(pane.id)).toEqual({ url: URL_A, bounds: BOUNDS });
    // And a late call of the window that is gone changes nothing.
    const calls = m.backend.calls.length;
    await send({ ...openRequest(m, m.windowA, m.first, 2), op: "close" });
    await settle();
    expect(m.backend.calls.length).toBe(calls);
    stop();
  });

  it("closes the web view when the tab is closed in the window, and when the person closes the window", async () => {
    const { m, answers, send, stop } = await start();
    const paneA = m.browserOf(m.first).id;
    const paneB = m.browserOf(m.second).id;
    await send(openRequest(m, m.windowA, m.first, 1));
    await send(openRequest(m, m.windowB, m.second, 2));
    await until(() => answers.length === 2, "both web views");
    expect(m.backend.browserPaneIds().sort()).toEqual([paneA, paneB].sort());
    // The tab of window A is closed from its sidebar.
    m.store.getState().dispatch({ type: "item/close", itemId: m.first });
    await until(() => m.backend.browserPane(paneA) === undefined, "the closed tab's web view");
    expect(m.backend.browserPane(paneB)?.windowId).toBe(m.windowB);
    // The person closes window B: the web view goes with the window, and the workspace lets go of it.
    m.backend.closeWindowByPerson(m.windowB);
    expect(m.backend.browserPane(paneB)).toBeUndefined();
    stop();
  });

  it("closes a web view that was being made when its pane left the window", async () => {
    const { m, answers, send, stop } = await start();
    const pane = m.browserOf(m.first);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = m.backend.openBrowserPane.bind(m.backend);
    m.backend.openBrowserPane = async (id, url, bounds, options) => {
      await gate;
      await real(id, url, bounds, options);
    };
    await send(openRequest(m, m.windowA, m.first, 1));
    await settle();
    // The tab leaves while the web view is on its way.
    m.store.getState().dispatch({ type: "item/close", itemId: m.first });
    release();
    await until(() => answers.length === 1, "the answer");
    await until(() => m.backend.browserPane(pane.id) === undefined, "no web view left over");
    stop();
  });

  it("stops listening when it is stopped", async () => {
    const { m, answers, send, stop } = await start();
    stop();
    await settle();
    await send(openRequest(m, m.windowA, m.first, 1));
    await settle();
    expect(answers).toEqual([]);
    expect(m.backend.browserPaneIds()).toEqual([]);
  });
});

describe("createWindowBrowsers", () => {
  it("asks the main window for each call with the tab and the pane it is for, and waits for the answer", async () => {
    const events = memoryQuickEvents();
    const sent: Record<string, unknown>[] = [];
    await events.listen(WINDOW_BROWSER_EVENT, (payload) => {
      const body = payload as Record<string, unknown>;
      sent.push(body);
      void events.emit(WINDOW_BROWSER_RESULT_EVENT, {
        windowId: body["windowId"],
        request: body["request"],
        ok: true,
      });
    });
    const browsers = createWindowBrowsers(events, "wA");
    const view = browsers.forPane("i1", "p1");
    await view.openBrowserPane("p1", URL_A, BOUNDS);
    await view.navigateBrowserPane("p1", URL_B);
    await view.setBrowserPaneBounds("p1", BOUNDS);
    await view.closeBrowserPane("p1");
    expect(sent).toEqual([
      {
        windowId: "wA",
        request: 1,
        op: "open",
        itemId: "i1",
        paneId: "p1",
        url: URL_A,
        bounds: BOUNDS,
      },
      { windowId: "wA", request: 2, op: "navigate", itemId: "i1", paneId: "p1", url: URL_B },
      { windowId: "wA", request: 3, op: "bounds", itemId: "i1", paneId: "p1", bounds: BOUNDS },
      { windowId: "wA", request: 4, op: "close", itemId: "i1", paneId: "p1" },
    ]);
    expect(browsers.forPane("i1", "p1")).toBe(view);
    expect(browsers.forPane("i1", "p2")).not.toBe(view);
    browsers.stop();
  });

  it("rejects a call about another pane than its own without asking anyone", async () => {
    const events = memoryQuickEvents();
    let asked = 0;
    await events.listen(WINDOW_BROWSER_EVENT, () => {
      asked++;
    });
    const view = createWindowBrowsers(events, "wA").forPane("i1", "p1");
    await expect(view.openBrowserPane("p2", URL_A, BOUNDS)).rejects.toThrow("not the pane");
    await expect(view.navigateBrowserPane("p2", URL_A)).rejects.toThrow("not the pane");
    await expect(view.setBrowserPaneBounds("p2", BOUNDS)).rejects.toThrow("not the pane");
    await expect(view.closeBrowserPane("p2")).rejects.toThrow("not the pane");
    await settle();
    expect(asked).toBe(0);
  });

  it("rejects with the reason the main window gave, and keeps only answers meant for it", async () => {
    const events = memoryQuickEvents();
    await events.listen(WINDOW_BROWSER_EVENT, (payload) => {
      const body = payload as Record<string, unknown>;
      // An answer for another window and one for another request come first; they are not its own.
      void events.emit(WINDOW_BROWSER_RESULT_EVENT, {
        windowId: "wB",
        request: body["request"],
        ok: true,
      });
      void events.emit(WINDOW_BROWSER_RESULT_EVENT, { windowId: "wA", request: 999, ok: true });
      void events.emit(WINDOW_BROWSER_RESULT_EVENT, {
        windowId: "wA",
        request: body["request"],
        failed: "no room for another web view",
      });
    });
    const view = createWindowBrowsers(events, "wA").forPane("i1", "p1");
    await expect(view.openBrowserPane("p1", URL_A, BOUNDS)).rejects.toThrow(
      "no room for another web view",
    );
  });

  it("does not take an answer that is neither a success nor a failure, and gives up on the time", async () => {
    const events = memoryQuickEvents();
    await events.listen(WINDOW_BROWSER_EVENT, (payload) => {
      const body = payload as Record<string, unknown>;
      void events.emit(WINDOW_BROWSER_RESULT_EVENT, { windowId: "wA", request: body["request"] });
      void events.emit(WINDOW_BROWSER_RESULT_EVENT, {
        windowId: "wA",
        request: body["request"],
        ok: "yes",
      });
    });
    const view = createWindowBrowsers(events, "wA", { timeoutMs: 20 }).forPane("i1", "p1");
    await expect(view.closeBrowserPane("p1")).rejects.toThrow("did not answer");
  });

  it("fails what is waiting when it is stopped", async () => {
    const events = memoryQuickEvents();
    const browsers = createWindowBrowsers(events, "wA", { timeoutMs: 60_000 });
    const waiting = browsers.forPane("i1", "p1").closeBrowserPane("p1");
    const failed = expect(waiting).rejects.toThrow("stopped");
    await settle();
    browsers.stop();
    await failed;
  });

  it("works with a BrowserPaneView against the main window side, over the same events", async () => {
    const main = await openMain();
    const { events, answers } = recordingEvents();
    const stop = followWindowBrowsers(main.store, main.backend, events);
    // Listening is asynchronous.
    await settle();
    const browsers = createWindowBrowsers(events, main.windowA);
    const pane = main.browserOf(main.first);
    const problems: (string | undefined)[] = [];
    const view = new BrowserPaneView(browsers.forPane(main.first, pane.id), pane.id, (problem) =>
      problems.push(problem),
    );
    view.want({ url: URL_A, bounds: BOUNDS });
    await until(() => main.backend.browserPane(pane.id) !== undefined, "the web view");
    await view.settled();
    expect(main.backend.browserPane(pane.id)).toEqual({
      url: URL_A,
      bounds: BOUNDS,
      windowId: main.windowA,
    });
    // Out of view: the same place with no area.
    view.want({ url: URL_A, bounds: undefined });
    await until(() => main.backend.browserPane(pane.id)?.bounds.width === 0, "the hidden bounds");
    // The pane goes away: the view closes it through the main window.
    view.close();
    await until(() => main.backend.browserPane(pane.id) === undefined, "the closed web view");
    expect(problems.every((p) => p === undefined)).toBe(true);
    expect(answers.every((a) => a["ok"] === true)).toBe(true);
    browsers.stop();
    stop();
  });
});
