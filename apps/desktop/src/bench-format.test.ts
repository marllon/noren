import { describe, expect, it } from "vitest";
import {
  NO_READING,
  formatBytes,
  formatDuration,
  formatPercent,
  formatTokensPerSecond,
  tokensSourceKey,
} from "./bench-format";

describe("bench scoreboard numbers", () => {
  it("writes a fraction as a whole percent", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.85)).toBe("85%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(2 / 3)).toBe("67%");
  });

  it("writes milliseconds under a second and seconds from a second up", () => {
    expect(formatDuration(null)).toBe(NO_READING);
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(849.6)).toBe("850 ms");
    expect(formatDuration(1000)).toBe("1.0 s");
    expect(formatDuration(12_345)).toBe("12.3 s");
  });

  it("writes tokens per second with one decimal and a dash for none", () => {
    expect(formatTokensPerSecond(null)).toBe(NO_READING);
    expect(formatTokensPerSecond(42)).toBe("42.0");
    expect(formatTokensPerSecond(41.96)).toBe("42.0");
  });

  it("writes bytes in binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TiB");
    expect(formatBytes(5000 * 1024 ** 4)).toBe("5000.0 TiB");
  });

  it("names the words of each source of the tokens", () => {
    expect(tokensSourceKey("stream")).toBe("bench.source.stream");
    expect(tokensSourceKey("estimate")).toBe("bench.source.estimate");
    expect(tokensSourceKey("mixed")).toBe("bench.source.mixed");
  });
});
