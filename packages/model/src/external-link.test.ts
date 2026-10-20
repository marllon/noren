import { describe, expect, it } from "vitest";
import { MAX_LINK_BYTES, externalLinkProblem, isExternalLink } from "./external-link";

describe("externalLinkProblem", () => {
  it.each([
    "http://example.com",
    "https://example.com/",
    "HTTPS://Example.com/Path?q=1&r=2#frag",
    "http://127.0.0.1:8080/a",
    "https://[::1]:3000/",
    "https://example.com/a%20b",
    "https://example.com/?next=https://other.example/@x",
  ])("opens %s", (address) => {
    expect(externalLinkProblem(address)).toBeUndefined();
    expect(isExternalLink(address)).toBe(true);
  });

  it.each([
    "file:///C:/Windows/System32/calc.exe",
    "file://server/share/x",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "noren://open?path=/home",
    "ms-msdt:/id PCWDiagnostic",
    "ftp://example.com/",
    "ssh://example.com",
    "mailto:a@example.com",
    "vbscript:msgbox(1)",
    "blob:http://example.com/1",
    "//example.com/path",
    "example.com",
    "C:\\Windows\\notepad.exe",
    "/etc/passwd",
    "httpx://example.com",
    "http:/example.com",
    "http:example.com",
    " https://example.com",
  ])("refuses the scheme of %s", (address) => {
    expect(externalLinkProblem(address)).toBe("only http and https links can be opened");
  });

  it.each([
    "https://example.com/a b",
    "https://example.com/\n",
    "https://example.com/\r\nHost: x",
    "https://example.com/\u0000",
    "https://example.com/\t",
    "https://example.com\\@evil.example",
    "https://example.com/\u0085",
    "https://example.com/\u00a0",
    "https://example.com/ ",
  ])("refuses blanks, control characters and backslashes in %j", (address) => {
    expect(externalLinkProblem(address)).toMatch(/blank, a control character or a backslash/);
  });

  it.each(["https://", "http:///etc/passwd", "https://?x", "https://#x", "http://"])(
    "refuses %s for having no host",
    (address) => {
      expect(externalLinkProblem(address)).toBe("the link has no host");
    },
  );

  it.each(["https://good.example@evil.example/", "https://user:pass@example.com", "http://@x.com"])(
    "refuses %s for the user name before the host",
    (address) => {
      expect(externalLinkProblem(address)).toMatch(/user name or password/);
    },
  );

  it("refuses an empty address and one over the size limit, and accepts one at the limit", () => {
    expect(externalLinkProblem("")).toMatch(/empty or too long/);
    expect(externalLinkProblem(`https://example.com/${"a".repeat(MAX_LINK_BYTES)}`)).toMatch(
      /empty or too long/,
    );
    const prefix = "https://example.com/";
    expect(isExternalLink(prefix + "a".repeat(MAX_LINK_BYTES - prefix.length))).toBe(true);
    // The limit counts bytes: a multi-byte character weighs more than one.
    expect(isExternalLink(prefix + "é".repeat(MAX_LINK_BYTES / 2))).toBe(false);
  });
});
