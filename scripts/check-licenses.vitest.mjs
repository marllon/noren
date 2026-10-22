// Vitest tests of the license gate (scripts/check-licenses.mjs): the lists of REGRAS.md stay strict, and
// the SIL Open Font License is allowed for the font packages of the app and for nothing else. The
// report has the shape `pnpm licenses list --json` gives; nothing here runs pnpm or reads the network.
import { describe, expect, it } from "vitest";
import { PROD_ALLOWED, allowedFor, evaluate, violations } from "./check-licenses.mjs";

const none = new Set();
const report = (license, name) => ({ [license]: [{ name, versions: ["1.0.0"] }] });

describe("the font license", () => {
  it("is not in the list of production licenses", () => {
    expect(PROD_ALLOWED.has("OFL-1.1")).toBe(false);
    expect(evaluate("OFL-1.1", PROD_ALLOWED)).toBe(false);
  });

  it("passes for the font packages of the app", () => {
    for (const name of [
      "@fontsource/geist",
      "@fontsource/geist-mono",
      "@fontsource/jetbrains-mono",
    ]) {
      expect(violations(report("OFL-1.1", name), PROD_ALLOWED, none), name).toEqual([]);
    }
    expect(violations(report("OFL-1.1", "@fontsource-variable/geist"), PROD_ALLOWED, none)).toEqual(
      [],
    );
  });

  it("fails for any other package, whatever its name looks like", () => {
    for (const name of [
      "left-pad",
      "fontsource",
      "@fontsource",
      "@fontsource/",
      "@fontsource/geist/extra",
      "@other/fontsource",
      "my-fontsource-thing",
      "@fontsources/geist",
      "@FONTSOURCE/geist",
    ]) {
      expect(violations(report("OFL-1.1", name), PROD_ALLOWED, none), name).toEqual([
        `${name}@1.0.0: OFL-1.1`,
      ]);
    }
  });

  it("is the only extra license a font package gets", () => {
    for (const license of ["GPL-3.0-only", "CC-BY-4.0", "Proprietary", "UNLICENSED", "OFL-1.0"]) {
      expect(
        violations(report(license, "@fontsource/geist"), PROD_ALLOWED, none),
        license,
      ).toHaveLength(1);
    }
    // The licenses that were allowed before still are, for a font package as for any other.
    expect(violations(report("MIT", "@fontsource/geist"), PROD_ALLOWED, none)).toEqual([]);
    expect(violations(report("Apache-2.0", "left-pad"), PROD_ALLOWED, none)).toEqual([]);
  });

  it("does not let an expression slip another license in next to it", () => {
    expect(
      violations(report("OFL-1.1 AND GPL-3.0-only", "@fontsource/geist"), PROD_ALLOWED, none),
    ).toHaveLength(1);
    expect(violations(report("OFL-1.1 OR MIT", "left-pad"), PROD_ALLOWED, none)).toEqual([]);
    expect(violations(report("OFL-1.1 AND MIT", "left-pad"), PROD_ALLOWED, none)).toHaveLength(1);
    expect(violations(report("OFL-1.1 AND MIT", "@fontsource/geist"), PROD_ALLOWED, none)).toEqual(
      [],
    );
  });

  it("leaves the lists of the gate as they were", () => {
    expect(allowedFor("left-pad", PROD_ALLOWED)).toBe(PROD_ALLOWED);
    const font = allowedFor("@fontsource/geist", PROD_ALLOWED);
    expect([...font].filter((license) => !PROD_ALLOWED.has(license))).toEqual(["OFL-1.1"]);
    expect(PROD_ALLOWED.has("OFL-1.1")).toBe(false);
  });
});
