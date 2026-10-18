import { describe, expect, it } from "vitest";
import { MODEL_PACKAGE_NAME } from "./index";

describe("@noren/model", () => {
  it("exposes the package name", () => {
    expect(MODEL_PACKAGE_NAME).toBe("@noren/model");
  });
});
