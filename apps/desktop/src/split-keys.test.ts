import { describe, expect, it } from "vitest";
import { typesText } from "./split-keys";

describe("typesText", () => {
  it("is true for text fields, selects and editable content", () => {
    expect(typesText({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(typesText({ tagName: "input" })).toBe(true);
    expect(typesText({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(typesText({ tagName: "SELECT" })).toBe(true);
    expect(typesText({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("is false for the terminal input, buttons and checkboxes", () => {
    expect(typesText({ tagName: "TEXTAREA" })).toBe(false);
    expect(typesText({ tagName: "BUTTON" })).toBe(false);
    expect(typesText({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(typesText({ tagName: "BODY" })).toBe(false);
    expect(typesText(null)).toBe(false);
  });
});
