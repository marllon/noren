import { backgroundImageProblem } from "@noren/model";
import type { Space, SpaceBackground } from "@noren/model";
import { BACKGROUND_BLUR_PROBLEM, BACKGROUND_OPACITY_PROBLEM } from "./settings-screen";
import { parseBackgroundBlur, parseBackgroundOpacity } from "./settings-screen";

// The picture of one space, chosen in the menu of the space. The form holds the text of its three
// boxes; `planBackground` turns it into what `space/set-background` takes, or says which box is
// wrong. Pure: the dialog (`SpaceBackgroundDialog.tsx`) only draws this.

/** The text of the boxes of the dialog. An empty opacity or blur takes the one of the settings or the theme. */
export interface BackgroundForm {
  image: string;
  opacity: string;
  blur: string;
}

/** The boxes of a space: the picture it has, or empty boxes. */
export function backgroundFormOf(space: Pick<Space, "background">): BackgroundForm {
  const { background } = space;
  return {
    image: background?.image ?? "",
    opacity: background?.opacity !== undefined ? String(background.opacity) : "",
    blur: background?.blur !== undefined ? String(background.blur) : "",
  };
}

/** What is wrong with each box; a box that is fine has no entry. */
export type BackgroundProblems = Partial<Record<keyof BackgroundForm, string>>;

export const BACKGROUND_IMAGE_REQUIRED = "Give the path of a picture file.";

export type BackgroundPlan = { background: SpaceBackground } | { problems: BackgroundProblems };

/** The picture the form asks for, or the problems of its boxes. The path is trimmed. */
export function planBackground(form: BackgroundForm): BackgroundPlan {
  const problems: BackgroundProblems = {};
  const image = form.image.trim();
  if (image === "") problems.image = BACKGROUND_IMAGE_REQUIRED;
  else {
    const problem = backgroundImageProblem(image);
    if (problem !== undefined) problems.image = problem;
  }
  const opacity = form.opacity.trim() === "" ? undefined : parseBackgroundOpacity(form.opacity);
  if (form.opacity.trim() !== "" && opacity === undefined) {
    problems.opacity = BACKGROUND_OPACITY_PROBLEM;
  }
  const blur = form.blur.trim() === "" ? undefined : parseBackgroundBlur(form.blur);
  if (form.blur.trim() !== "" && blur === undefined) problems.blur = BACKGROUND_BLUR_PROBLEM;
  if (Object.keys(problems).length > 0) return { problems };
  return {
    background: {
      image,
      ...(opacity !== undefined ? { opacity } : {}),
      ...(blur !== undefined ? { blur } : {}),
    },
  };
}
