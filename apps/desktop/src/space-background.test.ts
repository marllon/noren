import { describe, expect, it } from "vitest";
import {
  BACKGROUND_IMAGE_REQUIRED,
  backgroundFormOf,
  planBackground,
  removalOf,
} from "./space-background";
import { BACKGROUND_BLUR_PROBLEM, BACKGROUND_OPACITY_PROBLEM } from "./settings-screen";

describe("removalOf (the Remove button of the picker)", () => {
  it("takes the picture away from the space when the preview shows the one the space has", () => {
    const space = { background: { image: "C:\\Pictures\\sky.png", opacity: 0.4 } };
    expect(removalOf(space, { image: "C:\\Pictures\\sky.png" })).toEqual({ kind: "clear" });
  });

  it("lets go of a picture that was only chosen, back to the one of the space", () => {
    const space = { background: { image: "C:\\Pictures\\sky.png" } };
    expect(removalOf(space, { image: "D:\\other.jpg" })).toEqual({
      kind: "reset",
      image: "C:\\Pictures\\sky.png",
    });
  });

  it("lets go of a picture that was only chosen, back to empty, for a space with no picture", () => {
    expect(removalOf({}, { image: "D:\\other.jpg" })).toEqual({ kind: "reset", image: "" });
    expect(removalOf({}, { image: "" })).toEqual({ kind: "reset", image: "" });
  });
});

describe("backgroundFormOf", () => {
  it("is empty for a space with no picture", () => {
    expect(backgroundFormOf({})).toEqual({ image: "", opacity: "", blur: "" });
  });

  it("shows the picture of the space as text", () => {
    expect(
      backgroundFormOf({ background: { image: "C:\\Pictures\\sky.png", opacity: 0.25, blur: 0 } }),
    ).toEqual({ image: "C:\\Pictures\\sky.png", opacity: "0.25", blur: "0" });
    expect(backgroundFormOf({ background: { image: "a.png" } })).toEqual({
      image: "a.png",
      opacity: "",
      blur: "",
    });
  });
});

describe("planBackground", () => {
  it("makes the picture from the boxes, with the path trimmed", () => {
    expect(planBackground({ image: "  a.png ", opacity: "0.5", blur: "8" })).toEqual({
      background: { image: "a.png", opacity: 0.5, blur: 8 },
    });
  });

  it("leaves out an opacity or a blur that is empty, so the settings and the theme decide", () => {
    expect(planBackground({ image: "a.png", opacity: " ", blur: "" })).toEqual({
      background: { image: "a.png" },
    });
    expect(planBackground({ image: "a.png", opacity: "0", blur: "0" })).toEqual({
      background: { image: "a.png", opacity: 0, blur: 0 },
    });
  });

  it("needs a path, and says what is wrong with one that cannot be a background", () => {
    expect(planBackground({ image: "  ", opacity: "", blur: "" })).toEqual({
      problems: { image: BACKGROUND_IMAGE_REQUIRED },
    });
    const web = planBackground({ image: "https://example.com/a.png", opacity: "", blur: "" });
    expect("problems" in web && web.problems.image).toMatch(/web addresses/);
    const text = planBackground({ image: "notes.txt", opacity: "", blur: "" });
    expect("problems" in text && text.problems.image).toMatch(/png, jpg/);
  });

  it("tells each box that cannot be used, all at once", () => {
    expect(planBackground({ image: "", opacity: "2", blur: "x" })).toEqual({
      problems: {
        image: BACKGROUND_IMAGE_REQUIRED,
        opacity: BACKGROUND_OPACITY_PROBLEM,
        blur: BACKGROUND_BLUR_PROBLEM,
      },
    });
  });
});
