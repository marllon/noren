import { describe, expect, it } from "vitest";
import { NOREN_DUSK } from "./builtin-themes";
import { configJsonSchema, editConfigText, parseConfigText, parseTheme } from "./index";

// The window and the background in `config.jsonc` and in the format of a theme.

/** What `parseConfigText` says is wrong with the text: the setting and the line of each problem. */
function problems(text: string): { path: string; line: number | undefined; message: string }[] {
  const result = parseConfigText(text);
  if (result.ok) throw new Error(`expected the text to be refused: ${text}`);
  return result.errors.map((error) => ({
    path: error.path,
    line: error.line,
    message: error.message,
  }));
}

describe("appearance.window and appearance.background in config.jsonc", () => {
  it("accept an effect, an opacity and a background", () => {
    const text = `{
  "appearance": {
    "window": { "effect": "mica", "opacity": 0.85 },
    "background": { "image": "C:\\\\Pictures\\\\sky.png", "opacity": 0.3, "blur": 12 },
  },
}`;
    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        appearance: {
          window: { effect: "mica", opacity: 0.85 },
          background: { image: "C:\\Pictures\\sky.png", opacity: 0.3, blur: 12 },
        },
      },
    });
  });

  it("accept each effect, and null for the settings that may be left unset", () => {
    for (const effect of ["none", "mica", "acrylic", "vibrancy"]) {
      expect(parseConfigText(`{ "appearance": { "window": { "effect": "${effect}" } } }`).ok).toBe(
        true,
      );
    }
    expect(
      parseConfigText(
        `{ "appearance": { "window": { "opacity": null }, "background": { "image": null, "opacity": null, "blur": null } } }`,
      ),
    ).toEqual({
      ok: true,
      config: {
        appearance: {
          window: { opacity: null },
          background: { image: null, opacity: null, blur: null },
        },
      },
    });
  });

  it("refuse an effect that does not exist, with the line", () => {
    const [problem] = problems(`{
  "appearance": {
    "window": { "effect": "blur" }
  }
}`);
    expect(problem).toMatchObject({ path: "appearance.window.effect", line: 3 });
  });

  it("refuse an opacity of the interface below the lowest or above solid", () => {
    for (const opacity of ["0.29", "0", "-1", "1.01", '"0.5"']) {
      const [problem] = problems(`{ "appearance": { "window": { "opacity": ${opacity} } } }`);
      expect(problem?.path, opacity).toBe("appearance.window.opacity");
    }
    for (const opacity of ["0.3", "1", "0.5"]) {
      expect(parseConfigText(`{ "appearance": { "window": { "opacity": ${opacity} } } }`).ok).toBe(
        true,
      );
    }
  });

  it("refuse a background that is not a file on this computer, and say what is wrong", () => {
    for (const [image, words] of [
      ["https://example.com/sky.png", /web addresses/],
      ["http://localhost/sky.png", /web addresses/],
      ["file:///C:/sky.png", /web addresses/],
      ["data:image/png;base64,AAAA", /web addresses/],
      ["\\\\\\\\server\\\\share\\\\sky.png", /network paths/],
      ["../sky.png", /climb out/],
      ["notes.txt", /png, jpg/],
      ["", /empty/],
    ] as const) {
      const [problem] = problems(`{ "appearance": { "background": { "image": "${image}" } } }`);
      expect(problem?.path, image).toBe("appearance.background.image");
      expect(problem?.message, image).toMatch(words);
    }
  });

  it("refuse an opacity or a blur out of range", () => {
    for (const [key, value] of [
      ["opacity", "1.5"],
      ["opacity", "-0.1"],
      ["blur", "101"],
      ["blur", "-1"],
    ] as const) {
      const [problem] = problems(`{ "appearance": { "background": { "${key}": ${value} } } }`);
      expect(problem?.path).toBe(`appearance.background.${key}`);
    }
  });

  it("refuse a setting the group does not have", () => {
    const [problem] = problems(`{ "appearance": { "window": { "transparency": 1 } } }`);
    expect(problem?.message).toBe('Unknown setting "transparency"');
  });
});

describe("docs/config.schema.json", () => {
  it("describes the window and the background groups", () => {
    const schema = configJsonSchema() as {
      properties: {
        appearance: {
          properties: Record<
            string,
            { properties: Record<string, { default?: unknown; description?: string }> }
          >;
        };
      };
    };
    const { window, background } = schema.properties.appearance.properties;
    expect(Object.keys(window?.properties ?? {})).toEqual(["effect", "opacity"]);
    expect(Object.keys(background?.properties ?? {})).toEqual(["image", "opacity", "blur"]);
    expect(window?.properties["effect"]?.default).toBe("none");
    expect(window?.properties["effect"]?.description).toMatch(/"mica"/);
    expect(background?.properties["image"]?.description).toMatch(/file on this computer/);
  });
});

describe("editConfigText with a null setting", () => {
  it("writes null over a value and keeps the comments around it", () => {
    const text = `{
  // my window
  "appearance": {
    "window": { "opacity": 0.8 }, // see through
  },
}
`;
    const edited = editConfigText(text, [
      { path: ["appearance", "window", "opacity"], value: null },
    ]);
    expect(edited).toContain("// my window");
    expect(edited).toContain("// see through");
    expect(parseConfigText(edited)).toEqual({
      ok: true,
      config: { appearance: { window: { opacity: null } } },
    });
  });

  it("adds a setting that the file lacks, in the group the schema puts it in", () => {
    const edited = editConfigText('{ "appearance": { "tabs": "top" } }', [
      { path: ["appearance", "window", "effect"], value: "acrylic" },
      { path: ["appearance", "background", "image"], value: "backgrounds/sky.jpg" },
    ]);
    expect(parseConfigText(edited)).toEqual({
      ok: true,
      config: {
        appearance: {
          tabs: "top",
          window: { effect: "acrylic" },
          background: { image: "backgrounds/sky.jpg" },
        },
      },
    });
  });
});

describe("the background of a theme", () => {
  const copy = () =>
    structuredClone(NOREN_DUSK) as unknown as Record<string, Record<string, unknown>>;
  /** The `background` object of a copy of a theme, which a test changes in place. */
  const backgroundOf = (theme: Record<string, Record<string, unknown>>) => {
    const background = theme["background"];
    if (background === undefined) throw new Error("the theme has no background");
    return background;
  };

  it("takes a blur as well, and does without one", () => {
    expect(parseTheme(NOREN_DUSK).ok).toBe(true);
    const theme = copy();
    backgroundOf(theme)["blur"] = 8;
    expect(parseTheme(theme)).toMatchObject({ ok: true });
  });

  it("refuses a blur out of range", () => {
    for (const blur of [-1, 101, "8"]) {
      const theme = copy();
      backgroundOf(theme)["blur"] = blur;
      expect(parseTheme(theme).ok, String(blur)).toBe(false);
    }
  });

  it("refuses an image that is a web address, a network path or not a picture, and says where", () => {
    for (const image of [
      "https://example.com/sky.png",
      "//server/share/sky.png",
      "..\\sky.png",
      "sky.txt",
    ]) {
      const theme = copy();
      backgroundOf(theme)["image"] = image;
      const result = parseTheme(theme);
      expect(result.ok, image).toBe(false);
      if (!result.ok) expect(result.errors.join("\n"), image).toContain("background.image");
    }
  });

  it("takes a path in the config folder and an absolute one", () => {
    for (const image of ["backgrounds/sky.png", "C:\\Pictures\\sky.jpg", "/home/me/sky.webp"]) {
      const theme = copy();
      backgroundOf(theme)["image"] = image;
      expect(parseTheme(theme).ok, image).toBe(true);
    }
  });
});
