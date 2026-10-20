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
