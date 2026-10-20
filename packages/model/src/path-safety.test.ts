import { describe, expect, it } from "vitest";
import { backgroundImageProblem } from "./background";
import { parseDeepLink } from "./deep-link";
import { FakeBackend } from "./fake-backend";
import { isValidModFileName } from "./mods";
import { isScrollbackPaneId } from "./scrollback";
import { THEME_ID_PATTERN } from "./theme";

// The page checks every name that becomes a file before it asks the backend, with the same rules
// as `crates/noren-core` (which checks again: `tests/path_safety.rs`). Each test hands the rule a
// hostile name (`..`, an absolute path, a drive, a stream, a device name) and expects a refusal.

const HOSTILE_STEMS = [
  "..",
  "../escape",
  "..\\escape",
  "../../escape",
  "a/../../escape",
  "a/b",
  "a\\b",
  "/etc/passwd",
  "\\windows\\system32",
  "C:\\escape",
  "C:escape",
  "c:/escape",
  "\\\\server\\share\\escape",
  "//server/share/escape",
  "escape\0",
  "escape\n",
  " escape",
  "escape ",
  "escape:stream",
  "escape.",
  "%2e%2e/escape",
  "..%2fescape",
  "con",
  "NUL",
  "aux.v2",
  "com1",
  "lpt9",
  "~",
  "$HOME",
  "",
];

describe("mod file names", () => {
  // "escape." + ".css" is "escape..css", a plain name: a dot at the very end (which Windows drops)
  // is what the other rules refuse.
  it.each(HOSTILE_STEMS.filter((stem) => stem !== "escape."))("refuse %j.css", (stem) => {
    expect(isValidModFileName(`${stem}.css`)).toBe(false);
  });

  it.each([
    "..",
    "../escape.css",
    "a/b.css",
    "escape.CSS",
    "escape.css ",
    "escape.css.exe",
    "escape.css:stream",
    ".hidden.css",
    "-dash.css",
    "ünïcode.css",
  ])("refuse %j", (name) => {
    expect(isValidModFileName(name)).toBe(false);
  });

  it("refuse what is not a string", () => {
    for (const value of [undefined, null, 1, {}, ["a.css"]]) {
      expect(isValidModFileName(value)).toBe(false);
    }
  });

  it.each(["dark.css", "my-mod_2.v3.css", "A1.css"])("accept %s", (name) => {
    expect(isValidModFileName(name)).toBe(true);
  });
});

describe("theme ids", () => {
  it.each([...HOSTILE_STEMS, "Upper", "a_b", "a--b", "-a", "a-", "a.json", "café"])(
    "refuse %j",
    (id) => {
      expect(THEME_ID_PATTERN.test(id)).toBe(false);
    },
  );

  it.each(["con", "prn", "aux", "nul", "com1", "lpt9"])(
    "refuse the device name %s (con.json is the console on Windows)",
    (id) => {
      expect(THEME_ID_PATTERN.test(id)).toBe(false);
    },
  );

  it.each(["dark", "tokyo-night", "theme-2", "a", "con-dark", "aux2", "com10", "console"])(
    "accept %s",
    (id) => {
      expect(THEME_ID_PATTERN.test(id)).toBe(true);
    },
  );

  it("is also refused by the in-memory backend, which saves nothing", async () => {
    const backend = new FakeBackend();
    for (const id of ["../escape", "a/b", "C:\\x", "con", ""]) {
      await expect(backend.saveUserTheme(id, "{}")).rejects.toThrow();
    }
    expect(await backend.listUserThemes()).toEqual([]);
  });
});

describe("scrollback pane ids", () => {
  it.each(HOSTILE_STEMS)("refuse %j", (id) => {
    expect(isScrollbackPaneId(id)).toBe(false);
  });

  it("refuses an id over 64 characters", () => {
    expect(isScrollbackPaneId("a".repeat(65))).toBe(false);
    expect(isScrollbackPaneId("a".repeat(64))).toBe(true);
  });
});

describe("background image paths", () => {
  it.each([
    "../outside/sky.png",
    "..\\outside\\sky.png",
    "backgrounds/../../outside/sky.png",
    "a/./../../sky.png",
    "https://example.com/sky.png",
    "HTTP://example.com/sky.png",
    "file:///C:/sky.png",
    "data:image/png;base64,AAAA",
    "blob:abc",
    "\\\\server\\share\\sky.png",
    "//server/share/sky.png",
    "C:sky.png",
    "C:..\\sky.png",
    "sky.png\0",
    "sky.png\n",
    " sky.png",
    "sky.png ",
    "sky.txt",
    "sky",
    "",
  ])("refuse %j", (path) => {
    expect(backgroundImageProblem(path)).toBeDefined();
  });

  it.each([
    "sky.png",
    "backgrounds/sky.png",
    "./sky.jpg",
    "C:\\Pictures\\sky.png",
    "/home/a/b.webp",
  ])("accept %s", (path) => {
    expect(backgroundImageProblem(path)).toBeUndefined();
  });
});

describe("noren:// links", () => {
  it.each([
    "noren://open?path=..%2F..%2Fetc",
    "noren://open?path=%2Fhome%2Fa%2F..%2Fb",
    "noren://open?path=C%3A%5Cusers%5C..%5Cadmin",
    "noren://open?path=relative%2Fdir",
    "noren://open?path=",
    "noren://open",
    "noren://action?path=%2Fp&id=",
    "noren://open?path=%2Fp%00",
    "noren://run?cmd=calc.exe",
    "noren://open?path=%2Fp&cmd=calc.exe",
    "https://example.com",
    "file:///etc/passwd",
  ])("refuse %s", (url) => {
    expect(parseDeepLink(url).ok).toBe(false);
  });

  it.each([
    ["noren://open?path=%2Fhome%2Fa%2Fproject", "/home/a/project"],
    ["noren://open?path=C%3A%5Cusers%5Ca%5Cproject", "C:\\users\\a\\project"],
    ["noren://open?path=%5C%5Cserver%5Cshare%5Cproject", "\\\\server\\share\\project"],
  ])("accept the absolute folder of %s", (url, path) => {
    const parsed = parseDeepLink(url);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.link).toEqual({ kind: "open", path });
  });
});
