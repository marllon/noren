import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend } from "@noren/model";
import {
  appliedWindowEffect,
  getWindowEffectReport,
  requestWindowEffect,
  requestedWindowEffect,
  resetWindowEffect,
  windowEffectNote,
  windowEffectSettled,
} from "./window-effect-store";

afterEach(() => resetWindowEffect());

describe("requestedWindowEffect", () => {
  it("is the effect of the settings, and none without one", () => {
    expect(requestedWindowEffect({})).toBe("none");
    expect(requestedWindowEffect({ appearance: {} })).toBe("none");
    expect(requestedWindowEffect({ appearance: { window: { opacity: 0.8 } } })).toBe("none");
    expect(requestedWindowEffect({ appearance: { window: { effect: "acrylic" } } })).toBe(
      "acrylic",
    );
  });
});

describe("requestWindowEffect", () => {
  it("does not call the backend for a window that has no effect and is asked for none", async () => {
    const backend = new FakeBackend({ windowEffects: ["mica"] });
    requestWindowEffect(backend, "none", "dark");
    await windowEffectSettled();
    expect(backend.callsTo("setWindowEffect")).toHaveLength(0);
    expect(appliedWindowEffect()).toBe("none");
    expect(getWindowEffectReport()).toBeUndefined();
  });

  it("asks for the effect with the scheme of the theme and keeps what came back", async () => {
    const backend = new FakeBackend({ windowEffects: ["mica"] });
    requestWindowEffect(backend, "mica", "dark");
    await windowEffectSettled();
    expect(backend.callsTo("setWindowEffect").map((call) => call.args)).toEqual([["mica", "dark"]]);
    expect(appliedWindowEffect()).toBe("mica");
    expect(getWindowEffectReport()).toEqual({ requested: "mica", applied: "mica" });
    expect(windowEffectNote(getWindowEffectReport())).toBe("");
  });

  it("falls back to opaque with the reason when the system cannot paint the effect", async () => {
    const backend = new FakeBackend();
    requestWindowEffect(backend, "mica", "dark");
    await windowEffectSettled();
    expect(appliedWindowEffect()).toBe("none");
    expect(getWindowEffectReport()).toMatchObject({ requested: "mica", applied: "none" });
    const note = windowEffectNote(getWindowEffectReport());
    expect(note).toMatch(/^Mica was not applied, so the window stays opaque\./);
    expect(note).toContain("Mica is not available on this system.");
  });

  it("asks again when the effect or the scheme changes, and not for the same request twice", async () => {
    const backend = new FakeBackend({ windowEffects: ["mica", "acrylic"] });
    requestWindowEffect(backend, "mica", "dark");
    requestWindowEffect(backend, "mica", "dark");
    requestWindowEffect(backend, "mica", "light");
    requestWindowEffect(backend, "acrylic", "light");
    requestWindowEffect(backend, "acrylic", "light");
    await windowEffectSettled();
    expect(backend.callsTo("setWindowEffect").map((call) => call.args)).toEqual([
      ["mica", "dark"],
      ["mica", "light"],
      ["acrylic", "light"],
    ]);
    expect(appliedWindowEffect()).toBe("acrylic");
  });

  it("tells a theme that follows the system from one that was chosen: the look changes, so it asks again", async () => {
    const backend = new FakeBackend({ windowEffects: ["mica"] });
    requestWindowEffect(backend, "mica", "system");
    requestWindowEffect(backend, "mica", "dark");
    requestWindowEffect(backend, "mica", "system");
    await windowEffectSettled();
    expect(backend.callsTo("setWindowEffect").map((call) => call.args)).toEqual([
      ["mica", "system"],
      ["mica", "dark"],
      ["mica", "system"],
    ]);
  });

  it("takes the effect away when the settings go back to none, whatever the scheme", async () => {
    const backend = new FakeBackend({ windowEffects: ["mica"] });
    requestWindowEffect(backend, "mica", "dark");
    requestWindowEffect(backend, "none", "dark");
    requestWindowEffect(backend, "none", "light");
    await windowEffectSettled();
    expect(backend.callsTo("setWindowEffect").map((call) => call.args)).toEqual([
      ["mica", "dark"],
      ["none", "dark"],
    ]);
    expect(appliedWindowEffect()).toBe("none");
  });

  it("answers in the order of the requests, so the last one is what the window has", async () => {
    const backend = new FakeBackend({ windowEffects: ["mica", "acrylic"] });
    requestWindowEffect(backend, "mica", "dark");
    requestWindowEffect(backend, "acrylic", "dark");
    requestWindowEffect(backend, "none", "dark");
    await windowEffectSettled();
    expect(appliedWindowEffect()).toBe("none");
    expect(backend.appliedWindowEffect).toBe("none");
  });

  it("turns a rejected request into an opaque window with the reason", async () => {
    const backend = new FakeBackend({ windowEffects: ["mica"] });
    const refusing = {
      setWindowEffect: () => Promise.reject(new Error("the window did not answer")),
    };
    requestWindowEffect(refusing, "mica", "dark");
    await windowEffectSettled();
    expect(getWindowEffectReport()).toEqual({
      requested: "mica",
      applied: "none",
      reason: "the window did not answer",
    });
    expect(backend.callsTo("setWindowEffect")).toHaveLength(0);
    expect(windowEffectNote(getWindowEffectReport())).toContain("the window did not answer");
  });
});

describe("windowEffectNote", () => {
  it("is empty for no answer and for an answer that is what was asked", () => {
    expect(windowEffectNote(undefined)).toBe("");
    expect(windowEffectNote({ requested: "none", applied: "none" })).toBe("");
    expect(windowEffectNote({ requested: "acrylic", applied: "acrylic" })).toBe("");
  });

  it("names the effect and gives the reason when there is one", () => {
    expect(windowEffectNote({ requested: "vibrancy", applied: "none" })).toBe(
      "Vibrancy was not applied, so the window stays opaque.",
    );
    expect(
      windowEffectNote({ requested: "mica", applied: "none", reason: "Only on Windows 11." }),
    ).toBe("Mica was not applied, so the window stays opaque. Only on Windows 11.");
  });
});
