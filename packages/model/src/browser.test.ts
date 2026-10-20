import { describe, expect, it } from "vitest";
import {
  MAX_BROWSER_EXTENT,
  browserBoundsProblem,
  browserUrlProblem,
  isBrowserUrl,
  type BrowserBounds,
} from "./browser";
import { MAX_LINK_BYTES } from "./external-link";

describe("browserUrlProblem", () => {
  it.each([
    "http://example.com",
    "https://example.com/a/b?c=d#e",
    "HTTPS://Example.COM/",
    "http://localhost:3000/",
    "http://127.0.0.1:8080/index.html",
    "http://[::1]:8080/",
    "https://sub.domain.example.org:8443/path",
    "http://notlocalhost.example/",
    "http://localhost/",
  ])("accepts %s", (address) => {
    expect(browserUrlProblem(address)).toBeUndefined();
    expect(isBrowserUrl(address)).toBe(true);
  });

  it.each([
    ["a file", "file:///C:/Windows/win.ini"],
    ["a script", "javascript:alert(1)"],
    ["a data page", "data:text/html,<script>alert(1)</script>"],
    ["a link of the app", "noren://open?path=/tmp"],
    ["the protocol of the app", "tauri://localhost/"],
    ["the protocol of the commands", "ipc://localhost/session_create"],
    ["a blob", "blob:http://example.com/1"],
    ["an about page", "about:blank"],
    ["a ftp address", "ftp://example.com/"],
    ["a bare name", "example.com"],
    ["a path", "C:\\Windows\\notepad.exe"],
    ["nothing", ""],
  ])("refuses %s", (_what, address) => {
    expect(browserUrlProblem(address)).toBeTypeOf("string");
    expect(isBrowserUrl(address)).toBe(false);
  });

  it("refuses an address with a blank, a control character, a backslash or a user name", () => {
    for (const address of [
      "https://example.com/a b",
      "https://example.com/\u0000",
      "https://example.com\\evil",
      "https://good.example@evil.example/",
      "https://user:pass@example.com/",
      "https://",
      "https:///path",
    ]) {
      expect(browserUrlProblem(address), address).toBeTypeOf("string");
    }
  });

  it("refuses an address that is too long", () => {
    const long = `https://example.com/${"a".repeat(MAX_LINK_BYTES)}`;
    expect(browserUrlProblem(long)).toBeTypeOf("string");
  });

  it.each([
    "http://tauri.localhost/",
    "https://tauri.localhost/index.html",
    "HTTP://TAURI.LOCALHOST/",
    "http://tauri.localhost./",
    "http://tauri.localhost:80/",
    "http://ipc.localhost/session_create",
    "http://asset.localhost/x",
    "https://anything.localhost/",
    "http://a.b.localhost:3000/",
  ])("refuses %s, a name the app serves its own pages from", (address) => {
    expect(browserUrlProblem(address)).toBe("the address is one of the app's own");
  });

  it("refuses a host written with escapes, which the engine would read another way", () => {
    expect(browserUrlProblem("http://tauri%2Elocalhost/")).toBe(
      "the address has an escaped host name",
    );
    expect(browserUrlProblem("http://tauri.local%68ost/")).toBe(
      "the address has an escaped host name",
    );
  });

  it("does not take a path or a query that mentions the app for its host", () => {
    expect(browserUrlProblem("https://example.com/tauri.localhost")).toBeUndefined();
    expect(browserUrlProblem("https://example.com/?next=http://tauri.localhost/")).toBeUndefined();
    expect(browserUrlProblem("https://example.com#tauri.localhost")).toBeUndefined();
  });
});

describe("browserBoundsProblem", () => {
  const bounds = (patch: Partial<BrowserBounds> = {}): BrowserBounds => ({
    x: 10,
    y: 20,
    width: 400,
    height: 300,
    ...patch,
  });

  it("accepts a place in the window, an empty one and a position partly out of view", () => {
    expect(browserBoundsProblem(bounds())).toBeUndefined();
    expect(browserBoundsProblem(bounds({ width: 0, height: 0 }))).toBeUndefined();
    expect(browserBoundsProblem(bounds({ x: -120, y: -5 }))).toBeUndefined();
    expect(browserBoundsProblem(bounds({ x: 10.5, y: 0.25, width: 99.75 }))).toBeUndefined();
  });

  it("refuses numbers that are not finite", () => {
    for (const name of ["x", "y", "width", "height"] as const) {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(browserBoundsProblem(bounds({ [name]: value })), `${name} ${value}`).toBeTypeOf(
          "string",
        );
      }
    }
  });

  it("refuses a value that is not a number at all", () => {
    const wrong = { x: "1", y: 0, width: 1, height: 1 } as unknown as BrowserBounds;
    expect(browserBoundsProblem(wrong)).toBeTypeOf("string");
  });

  it("refuses a negative size and one beyond the limit", () => {
    expect(browserBoundsProblem(bounds({ width: -1 }))).toBeTypeOf("string");
    expect(browserBoundsProblem(bounds({ height: -0.5 }))).toBeTypeOf("string");
    expect(browserBoundsProblem(bounds({ width: MAX_BROWSER_EXTENT }))).toBeUndefined();
    expect(browserBoundsProblem(bounds({ width: MAX_BROWSER_EXTENT + 1 }))).toBeTypeOf("string");
    expect(browserBoundsProblem(bounds({ height: MAX_BROWSER_EXTENT + 1 }))).toBeTypeOf("string");
  });

  it("refuses a position too far from the window", () => {
    expect(browserBoundsProblem(bounds({ x: MAX_BROWSER_EXTENT + 1 }))).toBeTypeOf("string");
    expect(browserBoundsProblem(bounds({ y: -MAX_BROWSER_EXTENT - 1 }))).toBeTypeOf("string");
  });
});
