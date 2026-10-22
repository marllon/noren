import { describe, expect, it } from "vitest";
import { NOREN_DUSK, THEMES } from "./builtin-themes";
import {
  BACKGROUND_EXTENSIONS,
  BACKGROUND_VEIL,
  DEFAULT_BACKGROUND_BLUR,
  DEFAULT_BACKGROUND_OPACITY,
  MAX_BACKGROUND_BLUR,
  MAX_BACKGROUND_PATH,
  backgroundImageProblem,
  resolveBackground,
  sniffImageMime,
} from "./background";

// The same cases as `path_problem` in crates/noren-core/src/background.rs: the interface and the
// side that opens the file must agree on which paths can name a background.
const ACCEPTED = [
  "C:\\Pictures\\sky.png",
  "c:/pictures/sky.JPG",
  "/home/me/sky.jpeg",
  "\\rooted\\sky.webp",
  "backgrounds/sky.gif",
  "backgrounds\\sky.bmp",
  "./sky.png",
  "sky.png",
  "My Pictures/a b.png",
  "a..b/sky.png",
];

const REFUSED = [
  "",
  "   ",
  " sky.png",
  "sky.png ",
  "http://example.com/sky.png",
  "https://example.com/sky.png",
  "HTTPS://example.com/sky.png",
  "file:///C:/sky.png",
  "data:image/png;base64,AAAA",
  "blob:abc",
  "ftp:sky.png",
  "\\\\server\\share\\sky.png",
  "//server/share/sky.png",
  "\\\\?\\C:\\sky.png",
  "C:sky.png",
  "../sky.png",
  "backgrounds/../../sky.png",
  "backgrounds\\..\\sky.png",
  "sky.txt",
  "sky",
  "sky.png.exe",
  ".png",
  "sky.svg",
  "bad\0name.png",
  "bad\nname.png",
];

describe("backgroundImageProblem", () => {
  it.each(ACCEPTED)("accepts %s", (path) => {
    expect(backgroundImageProblem(path)).toBeUndefined();
  });

  it.each(REFUSED)("refuses %j with a sentence", (path) => {
    const problem = backgroundImageProblem(path);
    expect(problem).toBeTypeOf("string");
    expect(problem).toMatch(/\.$/);
  });

  it("refuses a path longer than the limit and accepts one at it", () => {
    expect(backgroundImageProblem(`${"a".repeat(MAX_BACKGROUND_PATH)}.png`)).toBeDefined();
    expect(backgroundImageProblem(`${"a".repeat(MAX_BACKGROUND_PATH - 4)}.png`)).toBeUndefined();
  });

  it("tells a web address from a web address in words, never fetching anything", () => {
    expect(backgroundImageProblem("http://127.0.0.1/sky.png")).toMatch(/web addresses/);
    expect(backgroundImageProblem("\\\\host\\share\\sky.png")).toMatch(/network paths/);
    expect(backgroundImageProblem("../sky.png")).toMatch(/climb out/);
    expect(backgroundImageProblem("sky.txt")).toMatch(/png, jpg, jpeg, webp, gif, bmp/);
  });

  it("lists the extensions it accepts, lower case", () => {
    for (const extension of BACKGROUND_EXTENSIONS) {
      expect(backgroundImageProblem(`a.${extension}`)).toBeUndefined();
      expect(backgroundImageProblem(`a.${extension.toUpperCase()}`)).toBeUndefined();
    }
  });
});

describe("sniffImageMime", () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

  it("tells the picture by its first bytes", () => {
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      "image/png",
    );
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageMime(ascii("GIF89a...."))).toBe("image/gif");
    expect(sniffImageMime(ascii("GIF87a...."))).toBe("image/gif");
    expect(sniffImageMime(ascii("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(ascii("BM......"))).toBe("image/bmp");
  });

  it("does not take text, a svg, another RIFF file or nothing for a picture", () => {
    expect(sniffImageMime(ascii("RIFF\0\0\0\0WAVE"))).toBeUndefined();
    expect(sniffImageMime(ascii("<svg xmlns="))).toBeUndefined();
    expect(sniffImageMime(ascii("hello"))).toBeUndefined();
    expect(sniffImageMime(new Uint8Array())).toBeUndefined();
  });
});

describe("the defaults of a picture", () => {
  it("show far more of the picture than the 0.15 of before, and keep a veil over it", () => {
    expect(DEFAULT_BACKGROUND_OPACITY).toBeGreaterThan(0.15);
    expect(DEFAULT_BACKGROUND_OPACITY).toBeLessThan(1);
    expect(BACKGROUND_VEIL).toBeGreaterThan(0);
    expect(BACKGROUND_VEIL).toBeLessThan(1);
    expect(DEFAULT_BACKGROUND_BLUR).toBe(0);
  });

  it("are the opacity the built-in themes say, so a theme and the settings file agree", () => {
    for (const theme of THEMES) {
      expect(theme.background.opacity, theme.id).toBe(DEFAULT_BACKGROUND_OPACITY);
    }
    expect(NOREN_DUSK.background).toEqual({ image: null, opacity: DEFAULT_BACKGROUND_OPACITY });
  });
});

describe("resolveBackground", () => {
  it("is no picture, faint and sharp, with nothing said", () => {
    expect(resolveBackground([])).toEqual({
      image: null,
      opacity: DEFAULT_BACKGROUND_OPACITY,
      blur: DEFAULT_BACKGROUND_BLUR,
    });
    expect(resolveBackground([undefined, null, {}])).toEqual(resolveBackground([]));
  });

  it("lets the last layer that says something win, part by part", () => {
    const theme = { image: "themes/sky.png", opacity: 0.2, blur: 3 };
    const settings = { opacity: 0.5 };
    const space = { image: "C:\\Pictures\\space.jpg", blur: 9 };
    expect(resolveBackground([theme])).toEqual({ image: "themes/sky.png", opacity: 0.2, blur: 3 });
    expect(resolveBackground([theme, settings])).toEqual({
      image: "themes/sky.png",
      opacity: 0.5,
      blur: 3,
    });
    expect(resolveBackground([theme, settings, space])).toEqual({
      image: "C:\\Pictures\\space.jpg",
      opacity: 0.5,
      blur: 9,
    });
  });

  it("takes null for the picture as no picture, even over the theme's", () => {
    expect(resolveBackground([{ image: "themes/sky.png" }, { image: null }]).image).toBeNull();
    // A null opacity or blur says nothing.
    expect(
      resolveBackground([
        { opacity: 0.4, blur: 5 },
        { opacity: null, blur: null },
      ]),
    ).toMatchObject({ opacity: 0.4, blur: 5 });
  });

  it("holds the numbers to their range and ignores what is not a number", () => {
    expect(resolveBackground([{ opacity: 7, blur: 1000 }])).toMatchObject({
      opacity: 1,
      blur: MAX_BACKGROUND_BLUR,
    });
    expect(resolveBackground([{ opacity: -1, blur: -5 }])).toMatchObject({ opacity: 0, blur: 0 });
    expect(resolveBackground([{ opacity: Number.NaN, blur: Number.POSITIVE_INFINITY }])).toEqual({
      image: null,
      opacity: DEFAULT_BACKGROUND_OPACITY,
      blur: DEFAULT_BACKGROUND_BLUR,
    });
  });

  it("never lets a bad path hide a good one under it, nor reach the shell", () => {
    expect(
      resolveBackground([{ image: "themes/sky.png" }, { image: "https://example.com/a.png" }])
        .image,
    ).toBe("themes/sky.png");
    expect(resolveBackground([{ image: "https://example.com/a.png" }]).image).toBeNull();
    expect(resolveBackground([{ image: "notes.txt" }]).image).toBeNull();
  });
});
