import { describe, expect, it } from "vitest";
import { osNameOf } from "./os-name";

describe("osNameOf", () => {
  it("names the three systems from the user agent of their web views", () => {
    expect(
      osNameOf(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
      ),
    ).toBe("Windows");
    expect(
      osNameOf(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      ),
    ).toBe("macOS");
    expect(
      osNameOf(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      ),
    ).toBe("Linux");
  });

  it("does not take a phone for a computer, and says so when it does not know", () => {
    expect(osNameOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("this system");
    expect(osNameOf("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("this system");
    expect(osNameOf("")).toBe("this system");
  });
});
