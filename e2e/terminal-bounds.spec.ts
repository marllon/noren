import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// A terminal never grows past its window (NOR-F20-15d, finding 376).
//
// The fit addon reads the size of the element that holds the terminal and divides it by the size of a
// cell. While the page is styled that element has the size of its pane. When the stylesheet does not
// reach the page (a request that failed, which the loaded runs of this suite had now and then: the page
// then draws every part of the terminal in the flow) the element takes the size of what is in it, and
// each fit made the terminal taller than the one before: canvases from 25 600 to 972 048 pixels high that
// changed with every frame, a "Close" button of the settings screen that never held still and a click
// that always landed on a canvas. These specs put the page in that state on purpose and wait for the
// terminal to settle inside the window; the second one reaches the same state with the stylesheet
// loaded, by putting the parts of the terminal back in the flow. They read the canvases, not the model.

interface Hook {
  paneIds(): string[];
  lines(): string[];
}
type HookWindow = Window & { __norenTest?: Hook };

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);

/** Waits for the first terminal to have drawn its prompt. */
async function untilPrompt(page: Page): Promise<void> {
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        ((window as HookWindow).__norenTest?.lines() ?? []).some((row) => row.startsWith("fake$")),
      ),
    )
    .toBe(true);
}

/**
 * The height of the tallest canvas on the page in three frames in a row, and the height of the window.
 * A terminal that has settled gives the same number three times; one that grows from frame to frame
 * does not.
 */
const heights = (page: Page): Promise<{ frames: number[]; window: number }> =>
  page.evaluate(
    () =>
      new Promise((done) => {
        const frames: number[] = [];
        const look = () => {
          const canvases = [...document.querySelectorAll("canvas")];
          frames.push(
            Math.max(0, ...canvases.map((canvas) => canvas.getBoundingClientRect().height)),
          );
          if (frames.length === 3) done({ frames, window: window.innerHeight });
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
  );

/** Waits until the terminal holds still, and is not taller than the window. */
async function untilInsideTheWindow(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const { frames, window } = await heights(page);
        const [first] = frames;
        return first !== undefined && first <= window && frames.every((h) => h === first);
      },
      { message: "the terminal keeps changing size, or is taller than the window" },
    )
    .toBe(true);
}

test.describe("a terminal stays inside its window", () => {
  test("when the stylesheet did not load", async ({ page }) => {
    await page.route("**/assets/*.css", (route) => route.abort("failed"));
    await page.goto("/");
    await untilPrompt(page);
    await untilInsideTheWindow(page);
  });

  test("when the parts of the terminal are in the flow and its box takes their size", async ({
    page,
  }) => {
    await page.goto("/");
    await untilPrompt(page);
    await page.addStyleTag({
      content: `
        .xterm * { position: static !important; }
        .terminal-host { position: static !important; inset: auto !important; }
        .terminal-view { position: static !important; flex: none !important; }`,
    });
    await untilInsideTheWindow(page);
  });
});
