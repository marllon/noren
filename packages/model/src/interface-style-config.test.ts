import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  DEFAULT_INTERFACE_STYLE,
  INTERFACE_STYLES,
  configJsonSchema,
  editConfigText,
  isInterfaceStyle,
  parseConfigText,
} from "./index";

// `appearance.style` of config.jsonc: which look the interface has, "glass" (the default) or
// "dense". The app turns it into an attribute on the root element and the token set of that
// attribute (`apps/desktop/src/interface-style.ts`); this is the part the schema owns: the two
// values, the default, the refusal of any other, the JSON Schema and the edit of the file.

const appearanceOf = (text: string) => {
  const parsed = parseConfigText(text);
  if (!parsed.ok) throw new Error(`not valid: ${parsed.errors.map((e) => e.message).join("; ")}`);
  return parsed.config.appearance;
};

describe("the interface styles", () => {
  it("are glass and dense, and glass is the default", () => {
    expect([...INTERFACE_STYLES]).toEqual(["glass", "dense"]);
    expect(DEFAULT_INTERFACE_STYLE).toBe("glass");
    expect(INTERFACE_STYLES).toContain(DEFAULT_INTERFACE_STYLE);
  });

  it("are told apart from any other value by isInterfaceStyle", () => {
    expect(isInterfaceStyle("glass")).toBe(true);
    expect(isInterfaceStyle("dense")).toBe(true);
    for (const value of [
      "Glass",
      "DENSE",
      "",
      "technical",
      " glass",
      undefined,
      null,
      1,
      true,
      {},
    ]) {
      expect(isInterfaceStyle(value), String(value)).toBe(false);
    }
  });
});

describe("appearance.style", () => {
  it("is not set when the file says nothing (the app then draws the default style)", () => {
    expect(appearanceOf("{}")).toBeUndefined();
    expect(appearanceOf('{ "appearance": { "tabs": "top" } }')?.style).toBeUndefined();
  });

  it("takes glass and dense, and nothing else", () => {
    expect(appearanceOf('{ "appearance": { "style": "glass" } }')?.style).toBe("glass");
    expect(appearanceOf('{ "appearance": { "style": "dense" } }')?.style).toBe("dense");
    expect(ConfigSchema.safeParse({ appearance: { style: "glass" } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ appearance: { style: "dense" } }).success).toBe(true);
  });

  it("is refused for any other value, naming the setting and saying why", () => {
    for (const value of [
      '"Glass"',
      '"DENSE"',
      '"technical"',
      '"vidro"',
      '"flat"',
      '""',
      "true",
      "1",
      "null",
      "[]",
      "{}",
    ]) {
      const result = parseConfigText(`{ "appearance": { "style": ${value} } }`);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.path, value).toBe("appearance.style");
      expect(result.errors[0]?.message.length, value).toBeGreaterThan(0);
    }
  });

  it("is an own key: a name the schema does not have is still refused", () => {
    for (const key of ["interfaceStyle", "look", "styles"]) {
      const result = parseConfigText(`{ "appearance": { "${key}": "dense" } }`);
      expect(result.ok, key).toBe(false);
    }
  });

  it("does not change what its neighbours take", () => {
    expect(
      appearanceOf('{ "appearance": { "theme": "noren-dusk", "style": "dense", "tabs": "top" } }'),
    ).toEqual({ theme: "noren-dusk", style: "dense", tabs: "top" });
    expect(parseConfigText('{ "appearance": { "tabs": "top", "style": "x" } }').ok).toBe(false);
    expect(parseConfigText('{ "appearance": { "tabs": "x", "style": "dense" } }').ok).toBe(false);
  });

  it("is in the JSON Schema with its two choices, its default and its description", () => {
    const schema = configJsonSchema() as {
      properties: {
        appearance: {
          properties: Record<string, { default?: unknown; description?: string; enum?: string[] }>;
        };
      };
    };
    const entry = schema.properties.appearance.properties["style"];
    expect(entry?.enum).toEqual(["glass", "dense"]);
    expect(entry?.default).toBe("glass");
    expect(entry?.description).toContain("look of the interface");
  });

  it("is written into the file at its own place, keeping the comments and the rest", () => {
    const text = `{
  "appearance": {
    "theme": "noren-dusk", // mine
    "density": "compact",
  },
}
`;
    const edited = editConfigText(text, [{ path: ["appearance", "style"], value: "dense" }]);
    expect(edited).toContain("// mine");
    expect(edited).toContain('"style": "dense"');
    expect(appearanceOf(edited)).toEqual({
      theme: "noren-dusk",
      density: "compact",
      style: "dense",
    });
    // And taken back, again by writing the one setting.
    const back = editConfigText(edited, [{ path: ["appearance", "style"], value: "glass" }]);
    expect(appearanceOf(back)?.style).toBe("glass");
    expect(back).toContain("// mine");
  });
});
