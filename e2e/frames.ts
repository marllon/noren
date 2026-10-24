import { expect } from "./test";
import type { Page } from "@playwright/test";

/**
 * Resolves after the page has drawn its next frame, so every `requestAnimationFrame` callback the
 * app queued before this call has run. The app hands the keyboard back to the terminal that way
 * when the palette, the settings screen or a panel closes (`focusTerminal` in App.tsx), and
 * nothing in the page shows it happened: the terminal may already hold the focus because the
 * closing dialog gave it back at once. Opening the next dialog before that frame would lose its
 * focus to the terminal. This is a sync point on the frame loop, not a fixed wait.
 */
export function afterNextFrame(page: Page): Promise<void> {
  return page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
}

/**
 * Resolves once no animation or transition that ends is running anywhere in the page. The frame
 * first, so that a transition the last change started (it is created when the page restyles) is in
 * the list; then the list is read until it is empty. Looping animations (a spinner, a blinking
 * cursor) never end and do not count. A sync point on the animations themselves: an element that
 * is measured before this has not got to the place it is going to.
 */
export async function afterAnimations(page: Page): Promise<void> {
  await afterNextFrame(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY,
              ).length,
        ),
      { message: "an animation or a transition is still running" },
    )
    .toBe(0);
}
