import { describe, expect, it } from "vitest";
import { ConfigSchema, configJsonSchema, editConfigText, parseConfigText } from "./index";

// `appearance.favorites` of config.jsonc: where the favorites bar is, at the top of the sidebar (the
// default) or in a bar at the top of the window. The app reads it into the layout (`layoutOf`); this
// is the part the schema owns: the two values, the refusal of any other, the JSON Schema and the
// edit of the file.

const appearanceOf = (text: string) => {
  const parsed = parseConfigText(text);
  if (!parsed.ok) throw new Error(`not valid: ${parsed.errors.map((e) => e.message).join("; ")}`);
  return parsed.config.appearance;
};

describe("appearance.favorites", () => {
  it("is not set when the file says nothing (the app then keeps the bar in the sidebar)", () => {
    expect(appearanceOf("{}")).toBeUndefined();
    expect(appearanceOf('{ "appearance": { "tabs": "top" } }')?.favorites).toBeUndefined();
  });

  it("takes sidebar and top, and nothing else", () => {
    expect(appearanceOf('{ "appearance": { "favorites": "sidebar" } }')?.favorites).toBe("sidebar");
    expect(appearanceOf('{ "appearance": { "favorites": "top" } }')?.favorites).toBe("top");
    expect(ConfigSchema.safeParse({ appearance: { favorites: "top" } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ appearance: { favorites: "sidebar" } }).success).toBe(true);
  });

  it("is refused for any other value, naming the setting and saying why", () => {
    for (const value of [
      '"bottom"',
      '"Top"',
      '"left"',
      '"window"',
      '""',
      "true",
      "1",
      "null",
      "[]",
      "{}",
    ]) {
      const result = parseConfigText(`{ "appearance": { "favorites": ${value} } }`);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.path, value).toBe("appearance.favorites");
      expect(result.errors[0]?.message.length, value).toBeGreaterThan(0);
    }
  });

  it("is an own key: a name the schema does not have is still refused", () => {
    for (const key of ["favoritesBar", "favoritesPosition", "bookmarks"]) {
      const result = parseConfigText(`{ "appearance": { "${key}": "top" } }`);
      expect(result.ok, key).toBe(false);
    }
  });

  it("does not change what the tabs setting takes", () => {
    expect(appearanceOf('{ "appearance": { "tabs": "top", "favorites": "top" } }')).toEqual({
      tabs: "top",
      favorites: "top",
    });
    expect(parseConfigText('{ "appearance": { "tabs": "top", "favorites": "x" } }').ok).toBe(false);
    expect(parseConfigText('{ "appearance": { "tabs": "x", "favorites": "top" } }').ok).toBe(false);
  });

  it("is in the JSON Schema with its two choices, its default and its description", () => {
    const schema = configJsonSchema() as {
      properties: {
        appearance: {
          properties: Record<string, { default?: unknown; description?: string; enum?: string[] }>;
        };
      };
    };
    const entry = schema.properties.appearance.properties["favorites"];
    expect(entry?.enum).toEqual(["sidebar", "top"]);
    expect(entry?.default).toBe("sidebar");
    expect(entry?.description).toContain("favorites bar");
    // Next to the setting of the tabs, which it is modelled on.
    expect(schema.properties.appearance.properties["tabs"]?.enum).toEqual(["sidebar", "top"]);
  });

  it("is written into the file at its own place, keeping the comments and the rest", () => {
    const text = `{
  "appearance": {
    "tabs": "top", // mine
    "density": "compact",
  },
}
`;
    const edited = editConfigText(text, [{ path: ["appearance", "favorites"], value: "top" }]);
    expect(edited).toContain("// mine");
    expect(edited).toContain('"favorites": "top"');
    expect(appearanceOf(edited)).toEqual({ tabs: "top", density: "compact", favorites: "top" });
    // And taken back, again by writing the one setting.
    const back = editConfigText(edited, [{ path: ["appearance", "favorites"], value: "sidebar" }]);
    expect(appearanceOf(back)?.favorites).toBe("sidebar");
    expect(back).toContain("// mine");
  });
});
