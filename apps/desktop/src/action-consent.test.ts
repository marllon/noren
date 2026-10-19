import { describe, expect, it } from "vitest";
import type { ProjectAction } from "@noren/model";
import {
  ACTION_CONSENT_KEY,
  confirmAction,
  consentText,
  isConfirmed,
  loadConsent,
  parseConsent,
  saveConsent,
} from "./action-consent";

const loop: ProjectAction = {
  id: "loop",
  label: "Loop",
  command: "loop",
  stop: "loop parar",
  tab: "loop",
};
const dev: ProjectAction = { id: "dev", label: "Dev", command: "pnpm dev", tab: "dev" };

describe("action consent", () => {
  it("asks until the action is confirmed in the space, then no more", () => {
    let consent = parseConsent(null);
    expect(isConfirmed(consent, "s1", dev)).toBe(false);
    consent = confirmAction(consent, "s1", dev);
    expect(isConfirmed(consent, "s1", dev)).toBe(true);
  });

  it("is per space and per action", () => {
    const consent = confirmAction({}, "s1", dev);
    expect(isConfirmed(consent, "s2", dev)).toBe(false);
    expect(isConfirmed(consent, "s1", loop)).toBe(false);
  });

  it("asks again when the command or the stop command changed", () => {
    const consent = confirmAction({}, "s1", loop);
    expect(isConfirmed(consent, "s1", { ...loop, command: "loop --fast" })).toBe(false);
    expect(isConfirmed(consent, "s1", { ...loop, stop: "rm -rf /" })).toBe(false);
    const withoutStop: ProjectAction = { id: "loop", label: "Loop", command: "loop", tab: "loop" };
    expect(isConfirmed(consent, "s1", withoutStop)).toBe(false);
    // The label and the tab do not run anything.
    expect(isConfirmed(consent, "s1", { ...loop, label: "Other", tab: "other" })).toBe(true);
  });

  it("confirming keeps the other answers", () => {
    const consent = confirmAction(confirmAction({}, "s1", dev), "s1", loop);
    expect(isConfirmed(consent, "s1", dev)).toBe(true);
    expect(isConfirmed(consent, "s1", loop)).toBe(true);
  });

  it("shows the stop command next to the command", () => {
    expect(consentText(dev)).toBe("pnpm dev");
    expect(consentText(loop)).toBe("loop\nloop parar");
  });

  it("falls back to no consent for broken text and drops entries of the wrong type", () => {
    expect(parseConsent("{")).toEqual({});
    expect(parseConsent("[1]")).toEqual({});
    expect(parseConsent('"text"')).toEqual({});
    expect(
      parseConsent(JSON.stringify({ s1: { dev: "pnpm dev", bad: 3 }, s2: 5, s3: [1] })),
    ).toEqual({
      s1: { dev: "pnpm dev" },
    });
  });

  it("saves and loads through the storage, and survives one that throws", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    saveConsent(storage, confirmAction({}, "s1", dev));
    expect(values.has(ACTION_CONSENT_KEY)).toBe(true);
    expect(isConfirmed(loadConsent(storage), "s1", dev)).toBe(true);

    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadConsent(blocked)).toEqual({});
    expect(() => saveConsent(blocked, {})).not.toThrow();
    expect(loadConsent(undefined)).toEqual({});
  });
});
