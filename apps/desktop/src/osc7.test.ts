import { describe, expect, it } from "vitest";
import { parseOsc7 } from "./osc7";

describe("parseOsc7", () => {
  it("takes the path of a file URL and ignores the host", () => {
    expect(parseOsc7("file://fake-host/home/me/api")).toBe("/home/me/api");
    expect(parseOsc7("file:///home/me")).toBe("/home/me");
    expect(parseOsc7("FILE://HOST/tmp")).toBe("/tmp");
  });

  it("decodes percent escapes", () => {
    expect(parseOsc7("file://h/home/my%20docs/caf%C3%A9")).toBe("/home/my docs/café");
  });

  it("drops the slash before a Windows drive letter", () => {
    expect(parseOsc7("file://PC/C:/Users/me")).toBe("C:/Users/me");
    expect(parseOsc7("file://PC/c:")).toBe("c:");
    expect(parseOsc7("file://PC/cx/y")).toBe("/cx/y");
  });

  it("refuses anything that is not a plain file URL with a path", () => {
    expect(parseOsc7("")).toBeUndefined();
    expect(parseOsc7("http://host/path")).toBeUndefined();
    expect(parseOsc7("file://host")).toBeUndefined();
    expect(parseOsc7("/home/me")).toBeUndefined();
    expect(parseOsc7("file://h/%E0%A4%A")).toBeUndefined();
  });

  it("refuses a path with a control character or a path that is far too long", () => {
    expect(parseOsc7("file://h/a%00b")).toBeUndefined();
    expect(parseOsc7("file://h/a%1Bb")).toBeUndefined();
    expect(parseOsc7(`file://h/${"a".repeat(5000)}`)).toBeUndefined();
  });
});
