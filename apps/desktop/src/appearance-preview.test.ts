import { afterEach, describe, expect, it, vi } from "vitest";
import { appearancePreview, onAppearancePreview, setAppearancePreview } from "./appearance-preview";

afterEach(() => setAppearancePreview(undefined));

describe("the preview of the numbers a screen is trying out", () => {
  it("holds the numbers until it is cleared", () => {
    expect(appearancePreview()).toBeUndefined();
    setAppearancePreview({ windowOpacity: 0.5, backgroundBlur: 8 });
    expect(appearancePreview()).toEqual({ windowOpacity: 0.5, backgroundBlur: 8 });
    setAppearancePreview(undefined);
    expect(appearancePreview()).toBeUndefined();
  });

  it("tells the ones that listen when it changes, and only then", () => {
    const listener = vi.fn();
    const stop = onAppearancePreview(listener);
    setAppearancePreview({ windowOpacity: 0.5 });
    expect(listener).toHaveBeenCalledTimes(1);
    // The same numbers in a new object are not a change: no render for nothing while a slider rests.
    const held = appearancePreview();
    setAppearancePreview({ windowOpacity: 0.5 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(appearancePreview()).toBe(held);
    setAppearancePreview({ windowOpacity: 0.6 });
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    setAppearancePreview(undefined);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("is none when no number is tried out, and null (not set) is a number tried out", () => {
    const listener = vi.fn();
    const stop = onAppearancePreview(listener);
    setAppearancePreview({ windowOpacity: undefined, backgroundBlur: undefined });
    expect(appearancePreview()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    setAppearancePreview({ windowOpacity: null });
    expect(appearancePreview()).toEqual({ windowOpacity: null });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });
});
