import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_OPTIONS, FakeBackend, MAX_FONT_SIZE, MIN_FONT_SIZE } from "@noren/model";
import { configManager } from "./config-store";
import {
  getTerminalOptions,
  resetTerminalOptionsStore,
  subscribeTerminalOptions,
  terminalFontZoom,
  zoomTerminalFont,
} from "./terminal-options-store";

// The options the terminals have: the `terminal` settings of the file over the defaults, with the
// zoom of the font over the size. The file is the one a `FakeBackend` keeps in memory.

async function started(config: string | null = null): Promise<FakeBackend> {
  const backend = new FakeBackend({ config });
  await configManager.start(backend);
  return backend;
}

beforeEach(() => {
  resetTerminalOptionsStore();
  configManager.stop();
  configManager.apply(null);
});

describe("terminal options store", () => {
  it("is what the terminal had before the options existed, with no file", () => {
    expect(getTerminalOptions()).toEqual(DEFAULT_TERMINAL_OPTIONS);
  });

  it("is the file over the defaults, and follows the file", async () => {
    const backend = await started('{ "terminal": { "font": { "size": 18 }, "scrollback": 500 } }');
    expect(getTerminalOptions()).toEqual({
      ...DEFAULT_TERMINAL_OPTIONS,
      fontSize: 18,
      scrollback: 500,
    });
    backend.setConfig('{ "terminal": { "cursor": { "style": "bar", "blink": false } } }');
    expect(getTerminalOptions()).toEqual({
      ...DEFAULT_TERMINAL_OPTIONS,
      cursorStyle: "bar",
      cursorBlink: false,
    });
    backend.setConfig(null);
    expect(getTerminalOptions()).toEqual(DEFAULT_TERMINAL_OPTIONS);
  });

  it("keeps the options when the file turns invalid", async () => {
    const backend = await started('{ "terminal": { "font": { "size": 18 } } }');
    const before = getTerminalOptions();
    backend.setConfig('{ "terminal": { "font": { "size": 5000 } } }');
    expect(getTerminalOptions()).toBe(before);
  });

  it("is the same object while the terminal settings do not change, so a view can compare it", async () => {
    const backend = await started('{ "terminal": { "font": { "size": 18 } } }');
    const before = getTerminalOptions();
    backend.setConfig(
      '{ "terminal": { "font": { "size": 18 } }, "appearance": { "density": "compact" } }',
    );
    expect(getTerminalOptions()).toBe(before);
  });

  it("hands the font to xterm as names only", async () => {
    await started(
      '{ "terminal": { "font": { "family": "Fira Code, JetBrains Mono, monospace" } } }',
    );
    expect(getTerminalOptions().fontFamily).toBe('"Fira Code", "JetBrains Mono", monospace');
  });
});

describe("the zoom of the font", () => {
  it("makes the font one pixel bigger or smaller at a time, and 0 goes back", () => {
    expect(getTerminalOptions().fontSize).toBe(14);
    zoomTerminalFont("in");
    expect(getTerminalOptions().fontSize).toBe(15);
    zoomTerminalFont("in");
    expect(getTerminalOptions().fontSize).toBe(16);
    zoomTerminalFont("out");
    expect(getTerminalOptions().fontSize).toBe(15);
    zoomTerminalFont("reset");
    expect(getTerminalOptions().fontSize).toBe(14);
    expect(terminalFontZoom()).toBe(0);
  });

  it("goes back to the size of the file, not to the default", async () => {
    await started('{ "terminal": { "font": { "size": 20 } } }');
    zoomTerminalFont("out");
    zoomTerminalFont("out");
    expect(getTerminalOptions().fontSize).toBe(18);
    zoomTerminalFont("reset");
    expect(getTerminalOptions().fontSize).toBe(20);
  });

  it("stops at the smallest and the largest size", () => {
    for (let i = 0; i < 200; i++) zoomTerminalFont("in");
    expect(getTerminalOptions().fontSize).toBe(MAX_FONT_SIZE);
    // One press back moves one step at once: the presses at the limit piled up nothing.
    zoomTerminalFont("out");
    expect(getTerminalOptions().fontSize).toBe(MAX_FONT_SIZE - 1);
    zoomTerminalFont("reset");
    for (let i = 0; i < 200; i++) zoomTerminalFont("out");
    expect(getTerminalOptions().fontSize).toBe(MIN_FONT_SIZE);
    zoomTerminalFont("in");
    expect(getTerminalOptions().fontSize).toBe(MIN_FONT_SIZE + 1);
  });

  it("tells the listeners when the zoom changes and not when it would change nothing", () => {
    const listener = vi.fn();
    const stop = subscribeTerminalOptions(listener);
    zoomTerminalFont("in");
    expect(listener).toHaveBeenCalledTimes(1);
    // Back to the size of the settings it already has: Ctrl+0 at the settings size is no change.
    zoomTerminalFont("reset");
    expect(listener).toHaveBeenCalledTimes(2);
    zoomTerminalFont("reset");
    expect(listener).toHaveBeenCalledTimes(2);
    // At the limit, going further changes nothing.
    for (let i = 0; i < 200; i++) zoomTerminalFont("in");
    const calls = listener.mock.calls.length;
    zoomTerminalFont("in");
    expect(listener).toHaveBeenCalledTimes(calls);
    stop();
    zoomTerminalFont("out");
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("keeps the zoom over a size that the file changes", async () => {
    const backend = await started('{ "terminal": { "font": { "size": 14 } } }');
    zoomTerminalFont("in");
    zoomTerminalFont("in");
    expect(getTerminalOptions().fontSize).toBe(16);
    backend.setConfig('{ "terminal": { "font": { "size": 20 } } }');
    expect(getTerminalOptions().fontSize).toBe(22);
    zoomTerminalFont("reset");
    expect(getTerminalOptions().fontSize).toBe(20);
  });

  it("writes nothing to the file", async () => {
    const backend = await started('{ "terminal": { "font": { "size": 14 } } }');
    zoomTerminalFont("in");
    zoomTerminalFont("out");
    zoomTerminalFont("reset");
    expect(backend.callsTo("saveConfig")).toEqual([]);
    expect(backend.configContent).toBe('{ "terminal": { "font": { "size": 14 } } }');
  });

  it("leaves the other options alone", async () => {
    await started('{ "terminal": { "cursor": { "style": "underline" }, "scrollback": 99 } }');
    zoomTerminalFont("in");
    expect(getTerminalOptions()).toEqual({
      ...DEFAULT_TERMINAL_OPTIONS,
      fontSize: 15,
      cursorStyle: "underline",
      scrollback: 99,
    });
  });
});
