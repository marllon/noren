import { describe, expect, it } from "vitest";
import { THEME_KEY, loadThemeChoice, parseThemeChoice, saveThemeChoice } from "./theme-choice";

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("parseThemeChoice", () => {
  it("reads the id of a known theme", () => {
    expect(parseThemeChoice('{"id":"noren-paper"}')).toBe("noren-paper");
    expect(parseThemeChoice('{"id":"noren-dusk"}')).toBe("noren-dusk");
  });

  it("follows the system for anything else: no value, broken JSON, another shape, an unknown id", () => {
    for (const raw of [
      null,
      "",
      "noren-dusk",
      "{",
      "[]",
      "null",
      "42",
      "{}",
      '{"id":3}',
      '{"id":null}',
      '{"id":"no-such-theme"}',
    ]) {
      expect(parseThemeChoice(raw)).toBeNull();
    }
  });
});

describe("loadThemeChoice and saveThemeChoice", () => {
  it("round-trips a theme and clears the value to follow the system", () => {
    const storage = memory();
    saveThemeChoice(storage, "noren-paper");
    expect(storage.values.get(THEME_KEY)).toBe('{"id":"noren-paper"}');
    expect(loadThemeChoice(storage)).toBe("noren-paper");
    saveThemeChoice(storage, null);
    expect(storage.values.has(THEME_KEY)).toBe(false);
    expect(loadThemeChoice(storage)).toBeNull();
  });

  it("falls back to the system on a corrupt value, a throwing storage or none", () => {
    const storage = memory();
    storage.values.set(THEME_KEY, "{corrupt");
    expect(loadThemeChoice(storage)).toBeNull();
    const throwing = {
      getItem: (): string => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("full");
      },
      removeItem: (): void => {
        throw new Error("blocked");
      },
    };
    expect(loadThemeChoice(throwing)).toBeNull();
    expect(() => saveThemeChoice(throwing, "noren-dusk")).not.toThrow();
    expect(() => saveThemeChoice(throwing, null)).not.toThrow();
    expect(loadThemeChoice(undefined)).toBeNull();
    expect(() => saveThemeChoice(undefined, "noren-dusk")).not.toThrow();
  });
});
