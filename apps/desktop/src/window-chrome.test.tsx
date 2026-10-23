import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openPaletteFromChrome,
  resetWindowChrome,
  setPaletteOpener,
  setWindowCrumbs,
  subscribeWindowChrome,
  useWindowCrumbs,
} from "./window-chrome";
import { renderToStaticMarkup } from "react-dom/server";

// What the shell tells the title bar of the dense window (where the person is, the way to open the
// palette): kept outside the components, so the title bar, which the page draws outside the shell, can
// read it. How the title bar draws it is in `DenseChrome.test.tsx` and e2e/dense-window.spec.ts.

afterEach(() => resetWindowChrome());

function Probe() {
  const crumbs = useWindowCrumbs();
  return (
    <p>{crumbs === undefined ? "nothing" : [crumbs.space, crumbs.group, crumbs.tab].join("|")}</p>
  );
}

describe("the crumbs", () => {
  it("are nothing until the shell says where the person is", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<p>nothing</p>");
  });

  it("are what the shell last said, and nothing again when it takes them back", () => {
    setWindowCrumbs({ space: "Site", group: "api", tab: "pnpm dev" });
    expect(renderToStaticMarkup(<Probe />)).toBe("<p>Site|api|pnpm dev</p>");
    setWindowCrumbs({ space: "Site", tab: "git" });
    expect(renderToStaticMarkup(<Probe />)).toBe("<p>Site||git</p>");
    setWindowCrumbs(undefined);
    expect(renderToStaticMarkup(<Probe />)).toBe("<p>nothing</p>");
  });

  it("do not wake the title bar when they say the same again, and do when they change", () => {
    const woke = vi.fn();
    const stop = subscribeWindowChrome(woke);
    const crumbs = { space: "Site", group: "api", tab: "pnpm dev" };
    setWindowCrumbs(crumbs);
    expect(woke).toHaveBeenCalledTimes(1);
    // The shell says the same again at every render, and nothing may follow from that.
    setWindowCrumbs({ ...crumbs });
    expect(woke).toHaveBeenCalledTimes(1);
    setWindowCrumbs({ ...crumbs, tab: "git" });
    expect(woke).toHaveBeenCalledTimes(2);
    stop();
    setWindowCrumbs(undefined);
    expect(woke).toHaveBeenCalledTimes(2);
  });
});

describe("the way to open the palette", () => {
  it("does nothing while the shell has not handed it over", () => {
    expect(() => openPaletteFromChrome()).not.toThrow();
  });

  it("runs what the shell handed over, until it takes it back", () => {
    const open = vi.fn();
    setPaletteOpener(open);
    openPaletteFromChrome();
    openPaletteFromChrome();
    expect(open).toHaveBeenCalledTimes(2);
    setPaletteOpener(undefined);
    openPaletteFromChrome();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
