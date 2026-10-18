import { describe, expect, it } from "vitest";
import { ManualClock, OutputStream, decodeUtf8, encodeUtf8 } from "./index";

describe("utf8", () => {
  it("round-trips text of every width", () => {
    const text = "a é € 😀 \r\n";
    expect(Array.from(encodeUtf8("é€😀"))).toEqual([
      0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80,
    ]);
    expect(decodeUtf8(encodeUtf8(text))).toBe(text);
  });

  it("replaces lone surrogates and malformed bytes", () => {
    const bad = String.fromCharCode(0xfffd);
    expect(decodeUtf8(encodeUtf8("a\ud800b"))).toBe(`a${bad}b`);
    expect(decodeUtf8(new Uint8Array([0x61, 0xff, 0xc3, 0x62]))).toBe(`a${bad}${bad}b`);
    expect(decodeUtf8(new Uint8Array([0xe2, 0x82]))).toBe(bad);
  });
});

describe("ManualClock", () => {
  it("fires timers in due order as time advances", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.setTimer(() => fired.push("b"), 20);
    clock.setTimer(() => fired.push("a"), 10);
    clock.setTimer(() => fired.push("a2"), 10);
    clock.advance(9);
    expect(fired).toEqual([]);
    clock.advance(11);
    expect(fired).toEqual(["a", "a2", "b"]);
    expect(clock.now()).toBe(20);
  });

  it("runs timers scheduled by a timer when they fall inside the window", () => {
    const clock = new ManualClock();
    const fired: number[] = [];
    clock.setTimer(() => {
      fired.push(clock.now());
      clock.setTimer(() => fired.push(clock.now()), 5);
    }, 10);
    clock.advance(20);
    expect(fired).toEqual([10, 15]);
  });

  it("does not fire a cancelled timer", () => {
    const clock = new ManualClock();
    let fired = false;
    const cancel = clock.setTimer(() => (fired = true), 1);
    cancel();
    clock.advance(10);
    expect(fired).toBe(false);
    expect(clock.pending).toBe(0);
  });
});

describe("OutputStream", () => {
  it("holds chunks for the first subscriber, then delivers live", () => {
    const stream = new OutputStream();
    stream.push(new Uint8Array([1]));
    stream.push(new Uint8Array([2]));
    const seen: number[] = [];
    const stop = stream.subscribe((data) => seen.push(...data));
    expect(seen).toEqual([1, 2]);
    stream.push(new Uint8Array([3]));
    stop();
    stream.push(new Uint8Array([4]));
    expect(seen).toEqual([1, 2, 3]);
  });
});
