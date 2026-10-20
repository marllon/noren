import { describe, expect, it } from "vitest";
import { MAX_BROWSER_EXTENT, type BrowserBounds } from "./browser";
import { FakeBackend } from "./fake-backend";

const BOUNDS: BrowserBounds = { x: 10, y: 20, width: 400, height: 300 };

describe("FakeBackend web views of browser panes", () => {
  it("opens one at a place with a page, and tells where it is", async () => {
    const backend = new FakeBackend();
    expect(backend.browserPane("p1")).toBeUndefined();
    await backend.openBrowserPane("p1", "https://example.com/", BOUNDS);
    expect(backend.browserPane("p1")).toEqual({ url: "https://example.com/", bounds: BOUNDS });
    expect(backend.browserPaneIds()).toEqual(["p1"]);
    expect(backend.callsTo("openBrowserPane").map((call) => call.args)).toEqual([
      ["p1", "https://example.com/", BOUNDS],
    ]);
  });

  it("keeps its own copy of the bounds, so a caller that changes them changes nothing", async () => {
    const backend = new FakeBackend();
    const bounds = { ...BOUNDS };
    await backend.openBrowserPane("p1", "https://example.com/", bounds);
    bounds.width = 1;
    const seen = backend.browserPane("p1");
    expect(seen?.bounds.width).toBe(400);
    if (seen) seen.bounds.width = 2;
    expect(backend.browserPane("p1")?.bounds.width).toBe(400);
  });

  it("goes to another page and moves, and the other web views do not follow", async () => {
    const backend = new FakeBackend();
    await backend.openBrowserPane("p1", "https://example.com/", BOUNDS);
    await backend.openBrowserPane("p2", "http://localhost:3000/", BOUNDS);
    await backend.navigateBrowserPane("p1", "https://example.org/docs");
    await backend.setBrowserPaneBounds("p1", { x: 0, y: 0, width: 800, height: 600 });
    expect(backend.browserPane("p1")).toEqual({
      url: "https://example.org/docs",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    expect(backend.browserPane("p2")).toEqual({ url: "http://localhost:3000/", bounds: BOUNDS });
    expect(backend.browserPaneIds()).toEqual(["p1", "p2"]);
  });

  it("closes one, and closing a pane that has none is not an error", async () => {
    const backend = new FakeBackend();
    await backend.openBrowserPane("p1", "https://example.com/", BOUNDS);
    await backend.closeBrowserPane("p1");
    expect(backend.browserPane("p1")).toBeUndefined();
    await expect(backend.closeBrowserPane("p1")).resolves.toBeUndefined();
    await expect(backend.closeBrowserPane("never")).resolves.toBeUndefined();
    // The pane can have a web view again.
    await backend.openBrowserPane("p1", "https://example.com/", BOUNDS);
    expect(backend.browserPaneIds()).toEqual(["p1"]);
  });

  it.each([
    "file:///C:/Windows/win.ini",
    "javascript:alert(1)",
    "data:text/html,hi",
    "noren://open?path=/tmp",
    "http://tauri.localhost/",
    "https://user@example.com/",
    "",
  ])("refuses to open %s, and opens nothing", async (url) => {
    const backend = new FakeBackend();
    await expect(backend.openBrowserPane("p1", url, BOUNDS)).rejects.toThrow();
    expect(backend.browserPane("p1")).toBeUndefined();
    expect(backend.browserPaneIds()).toEqual([]);
  });

  it("refuses to go to an address the pane may not show, and stays where it was", async () => {
    const backend = new FakeBackend();
    await backend.openBrowserPane("p1", "https://example.com/", BOUNDS);
    for (const url of ["file:///etc/passwd", "javascript:1", "data:text/plain,x", "noren://x"]) {
      await expect(backend.navigateBrowserPane("p1", url), url).rejects.toThrow();
    }
    expect(backend.browserPane("p1")?.url).toBe("https://example.com/");
  });

  it("refuses bounds that are not a place, on opening and on moving", async () => {
    const backend = new FakeBackend();
    for (const bad of [
      { ...BOUNDS, width: -1 },
      { ...BOUNDS, x: Number.NaN },
      { ...BOUNDS, height: MAX_BROWSER_EXTENT + 1 },
    ]) {
      await expect(backend.openBrowserPane("p1", "https://example.com/", bad)).rejects.toThrow();
    }
    expect(backend.browserPaneIds()).toEqual([]);
    await backend.openBrowserPane("p1", "https://example.com/", BOUNDS);
    await expect(backend.setBrowserPaneBounds("p1", { ...BOUNDS, width: -5 })).rejects.toThrow();
    expect(backend.browserPane("p1")?.bounds).toEqual(BOUNDS);
  });

  it("refuses a name that is not a pane id", async () => {
    const backend = new FakeBackend();
    for (const id of ["", "a b", "../x", "p/1", "p:1", "é", "x".repeat(65)]) {
      await expect(backend.openBrowserPane(id, "https://example.com/", BOUNDS), id).rejects.toThrow(
        "is not a pane id",
      );
    }
    await backend.openBrowserPane("x".repeat(64), "https://example.com/", BOUNDS);
    await backend.openBrowserPane("0f8f-AA_1", "https://example.com/", BOUNDS);
    expect(backend.browserPaneIds()).toHaveLength(2);
  });

  it("refuses a second web view for a pane, and to navigate or move one that does not exist", async () => {
    const backend = new FakeBackend();
    await backend.openBrowserPane("p1", "https://example.com/", BOUNDS);
    await expect(backend.openBrowserPane("p1", "https://example.org/", BOUNDS)).rejects.toThrow(
      "has a web view already",
    );
    expect(backend.browserPane("p1")?.url).toBe("https://example.com/");
    await expect(backend.navigateBrowserPane("p9", "https://example.com/")).rejects.toThrow(
      "has no web view",
    );
    await expect(backend.setBrowserPaneBounds("p9", BOUNDS)).rejects.toThrow("has no web view");
  });
});
