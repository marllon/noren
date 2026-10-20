import { FakeBackend } from "@noren/model";
import type { BrowserBounds } from "@noren/model";
import { describe, expect, it } from "vitest";
import { BrowserPaneView, hiddenBounds, isHiddenBounds } from "./browser-view";
import type { BrowserViewBackend } from "./browser-view";

const PAGE = "https://example.com/docs";
const OTHER = "https://example.org/";
const AREA: BrowserBounds = { x: 240, y: 52, width: 600, height: 400 };

const calls = (backend: FakeBackend): string[] =>
  backend.calls
    .filter((call) => call.method.endsWith("BrowserPane"))
    .map((call) => `${call.method}:${String(call.args[0])}`);

/** A view for pane `p1` on `backend`, and the problems it reported (`undefined`: it recovered). */
function setup(backend: BrowserViewBackend) {
  const problems: (string | undefined)[] = [];
  const view = new BrowserPaneView(backend, "p1", (problem) => problems.push(problem));
  return { view, problems };
}

describe("the web view of a browser pane", () => {
  it("is not opened while the pane has not been seen", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: undefined });
    await view.settled();
    expect(calls(fake)).toEqual([]);
  });

  it("opens when the pane shows, at the page and the bounds of the pane", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    await view.settled();
    expect(fake.browserPaneIds()).toEqual(["p1"]);
    expect(fake.browserPane("p1")).toEqual({ url: PAGE, bounds: AREA });
  });

  it("starts from no web view, so a page that was reloaded does not collide with its old one", async () => {
    const fake = new FakeBackend();
    // The old page left its view in the shell and was torn down without closing it.
    await fake.openBrowserPane("p1", PAGE, AREA);
    const { view, problems } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    await view.settled();
    expect(fake.browserPaneIds()).toEqual(["p1"]);
    expect(problems).toEqual([undefined]);
  });

  it("follows the bounds of the pane", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    const moved = { ...AREA, x: 300, width: 500 };
    view.want({ url: PAGE, bounds: moved });
    await view.settled();
    expect(fake.browserPane("p1")?.bounds).toEqual(moved);
  });

  it("sends nothing for a wish the web view already has", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    await view.settled();
    const before = fake.calls.length;
    view.want({ url: PAGE, bounds: { ...AREA } });
    await view.settled();
    expect(fake.calls.length).toBe(before);
  });

  it("goes to another page without reopening the view", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    await view.settled();
    view.want({ url: OTHER, bounds: AREA });
    await view.settled();
    expect(fake.browserPane("p1")).toEqual({ url: OTHER, bounds: AREA });
    expect(fake.callsTo("openBrowserPane")).toHaveLength(1);
    expect(fake.callsTo("navigateBrowserPane")).toHaveLength(1);
  });

  it("steps out of view with no area and keeps its page, then comes back where it was", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    await view.settled();

    view.want({ url: PAGE, bounds: undefined });
    await view.settled();
    const hidden = fake.browserPane("p1");
    expect(hidden?.url).toBe(PAGE);
    expect(hidden?.bounds).toEqual(hiddenBounds(AREA));
    expect(hidden && isHiddenBounds(hidden.bounds)).toBe(true);
    // Not closed, not opened again: the page is still there.
    expect(fake.callsTo("closeBrowserPane")).toHaveLength(1); // the clean start of the first open
    expect(fake.callsTo("openBrowserPane")).toHaveLength(1);

    view.want({ url: PAGE, bounds: AREA });
    await view.settled();
    expect(fake.browserPane("p1")?.bounds).toEqual(AREA);
    expect(fake.callsTo("openBrowserPane")).toHaveLength(1);
  });

  it("takes the page it was asked for while it is out of view", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    view.want({ url: OTHER, bounds: undefined });
    await view.settled();
    const placed = fake.browserPane("p1");
    expect(placed?.url).toBe(OTHER);
    expect(placed && isHiddenBounds(placed.bounds)).toBe(true);
  });

  it("closes the web view when the pane goes away, and never opens it again", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    await view.settled();
    view.close();
    await view.settled();
    expect(fake.browserPaneIds()).toEqual([]);

    view.want({ url: PAGE, bounds: AREA });
    await view.settled();
    expect(fake.browserPaneIds()).toEqual([]);
  });

  it("closes the web view of a pane that is out of view when it goes away", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    view.want({ url: PAGE, bounds: undefined });
    await view.settled();
    view.close();
    await view.settled();
    expect(fake.browserPaneIds()).toEqual([]);
  });

  it("asks the shell for nothing when a pane that never showed goes away", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: undefined });
    view.close();
    await view.settled();
    expect(calls(fake)).toEqual([]);
  });

  it("sends the last of a burst of changes and not every one", async () => {
    const fake = new FakeBackend();
    const { view } = setup(fake);
    view.want({ url: PAGE, bounds: AREA });
    for (let width = 601; width <= 640; width++)
      view.want({ url: PAGE, bounds: { ...AREA, width } });
    await view.settled();
    expect(fake.browserPane("p1")?.bounds.width).toBe(640);
    // The open, and at most the one move that was already on its way.
    expect(fake.callsTo("setBrowserPaneBounds").length).toBeLessThanOrEqual(1);
  });

  describe("when the shell answers slowly and out of order", () => {
    /** Every call takes a while, and the first (open) takes the longest. */
    function slow(fake: FakeBackend): BrowserViewBackend {
      const later = <T>(ms: number, run: () => Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => setTimeout(() => run().then(resolve, reject), ms));
      return {
        openBrowserPane: (id, url, bounds) =>
          later(30, () => fake.openBrowserPane(id, url, bounds)),
        navigateBrowserPane: (id, url) => later(5, () => fake.navigateBrowserPane(id, url)),
        setBrowserPaneBounds: (id, bounds) => later(5, () => fake.setBrowserPaneBounds(id, bounds)),
        closeBrowserPane: (id) => later(1, () => fake.closeBrowserPane(id)),
      };
    }

    it("leaves no web view behind when the pane goes away while it is being opened", async () => {
      const fake = new FakeBackend();
      const { view } = setup(slow(fake));
      view.want({ url: PAGE, bounds: AREA });
      // The open is on its way; the pane is closed before it lands.
      await new Promise((resolve) => setTimeout(resolve, 5));
      view.close();
      await view.settled();
      expect(fake.browserPaneIds()).toEqual([]);
    });

    it("does not move the web view before it is open", async () => {
      const fake = new FakeBackend();
      const { view, problems } = setup(slow(fake));
      view.want({ url: PAGE, bounds: AREA });
      view.want({ url: PAGE, bounds: { ...AREA, width: 300 } });
      view.want({ url: OTHER, bounds: undefined });
      await view.settled();
      expect(problems.filter((problem) => problem !== undefined)).toEqual([]);
      expect(fake.browserPane("p1")?.url).toBe(OTHER);
    });
  });

  describe("when the shell refuses", () => {
    it("tells why, does not try the same wish again, and tries a new one", async () => {
      const fake = new FakeBackend();
      let refusing = true;
      const refusingBackend: BrowserViewBackend = {
        openBrowserPane: (id, url, bounds) =>
          refusing ? Promise.reject(new Error("no room")) : fake.openBrowserPane(id, url, bounds),
        navigateBrowserPane: (id, url) => fake.navigateBrowserPane(id, url),
        setBrowserPaneBounds: (id, bounds) => fake.setBrowserPaneBounds(id, bounds),
        closeBrowserPane: (id) => fake.closeBrowserPane(id),
      };
      const { view, problems } = setup(refusingBackend);
      view.want({ url: PAGE, bounds: AREA });
      await view.settled();
      expect(problems).toEqual(["no room"]);
      // The same wish again (a render that changed nothing) is not a new try.
      view.want({ url: PAGE, bounds: { ...AREA } });
      await view.settled();
      expect(problems).toEqual(["no room"]);
      expect(fake.browserPaneIds()).toEqual([]);

      refusing = false;
      view.want({ url: PAGE, bounds: { ...AREA, width: 500 } });
      await view.settled();
      expect(fake.browserPane("p1")?.bounds.width).toBe(500);
      expect(problems.at(-1)).toBeUndefined();
    });

    it("still closes the view of a pane it could not open", async () => {
      const fake = new FakeBackend();
      const { view } = setup(fake);
      view.want({ url: "file:///C:/Windows/win.ini", bounds: AREA });
      await view.settled();
      expect(fake.browserPaneIds()).toEqual([]);
      view.close();
      await view.settled();
      expect(fake.callsTo("closeBrowserPane").length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("hidden bounds", () => {
  it("keep the place and have no area", () => {
    expect(hiddenBounds(AREA)).toEqual({ x: 240, y: 52, width: 0, height: 0 });
    expect(isHiddenBounds(hiddenBounds(AREA))).toBe(true);
    expect(isHiddenBounds(AREA)).toBe(false);
    expect(isHiddenBounds({ ...AREA, height: 0 })).toBe(true);
  });
});
