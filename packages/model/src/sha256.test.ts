import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

// Known answers (FIPS 180-4 and the usual test strings; `{}\n` is also the text the bridge test of
// the app hashes in Rust), so the fake backends and `noren-core` hash a space file the same way.

describe("sha256Hex", () => {
  it("hashes the empty text and the short test strings", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("{}\n")).toBe(
      "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
    );
  });

  it("hashes the 56-byte message that needs a second block for its length", () => {
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("hashes a long text (a million letters a)", () => {
    expect(sha256Hex("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("hashes the UTF-8 bytes of non-ASCII text", () => {
    expect(sha256Hex("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
  });

  it("always gives 64 lower case hexadecimal digits and the same answer for the same text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const hash = sha256Hex(text);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(sha256Hex(text)).toBe(hash);
      }),
      { numRuns: 200 },
    );
  });
});
