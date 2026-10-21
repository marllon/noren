import { describe, expect, it } from "vitest";
import { OutputStream } from "./output-stream";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("OutputStream", () => {
  it("holds chunks for the first subscriber and then delivers in order", () => {
    const stream = new OutputStream();
    stream.push(bytes(1));
    stream.push(bytes(2));
    const heard: number[][] = [];
    stream.subscribe((data) => heard.push([...data]));
    stream.push(bytes(3));
    expect(heard).toEqual([[1], [2], [3]]);
  });

  describe("tap", () => {
    it("hears what is held and what comes, and leaves the held chunks for the first subscriber", () => {
      const stream = new OutputStream();
      stream.push(bytes(1));
      const tapped: number[][] = [];
      stream.tap((data) => tapped.push([...data]));
      stream.push(bytes(2));
      expect(tapped).toEqual([[1], [2]]);

      const heard: number[][] = [];
      stream.subscribe((data) => heard.push([...data]));
      expect(heard).toEqual([[1], [2]]);
      stream.push(bytes(3));
      expect(heard).toEqual([[1], [2], [3]]);
      expect(tapped).toEqual([[1], [2], [3]]);
    });

    it("is not the subscriber the held chunks wait for", () => {
      const stream = new OutputStream();
      stream.tap(() => undefined);
      stream.push(bytes(9));
      const heard: number[][] = [];
      stream.subscribe((data) => heard.push([...data]));
      expect(heard).toEqual([[9]]);
    });

    it("stops hearing when it is unsubscribed, and a second unsubscribe does nothing", () => {
      const stream = new OutputStream();
      const tapped: number[][] = [];
      const stop = stream.tap((data) => tapped.push([...data]));
      stream.push(bytes(1));
      stop();
      stop();
      stream.push(bytes(2));
      expect(tapped).toEqual([[1]]);
    });

    it("hears each chunk once even with a subscriber, and two taps both hear", () => {
      const stream = new OutputStream();
      const first: number[][] = [];
      const second: number[][] = [];
      stream.subscribe(() => undefined);
      stream.tap((data) => first.push([...data]));
      stream.tap((data) => second.push([...data]));
      stream.push(bytes(4));
      expect(first).toEqual([[4]]);
      expect(second).toEqual([[4]]);
    });
  });
});
