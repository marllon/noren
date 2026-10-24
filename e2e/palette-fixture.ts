import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { afterNextFrame } from "./frames";

// The one way the specs open, use and close the command palette (NOR-F20-15a).
//
// Why a helper: the keyboard listener of the shell is a passive effect of the first commit, so it
// reaches the window a little after the tree of tabs is on screen (about 60 ms later in a loaded
// run, measured with a probe on window.addEventListener). A key pressed in that gap goes to no one,
// the palette never opens and the spec waits its whole timeout for it. The effect that publishes
// the test hook (`window.__norenTest`) is declared after the listener in the same component and
// runs in the same flush, so the hook being there means the listener is too. The helper waits for
// that, lets the frame the last close queued go by (below), presses the chord once, and waits for
// the dialog; it never presses a key again.
//
// The second thing is the way out: when the palette closes, the app hands the keyboard back to the
// terminal in a requestAnimationFrame (`focusTerminal` in App.tsx), and nothing in the page shows it
// happened. Under load that frame can come after the next palette is open and has the focus: the
// terminal takes it, Enter goes to the shell and the palette stays open (measured: the Enter of the
// second palette of a spec reached no list row). Waiting for the dialog to go is not enough, so the
// helpers also wait for the next frame, which runs after every callback queued before it.

/** The dialog of the command palette. */
export const paletteDialog = (page: Page): Locator => page.locator('[data-nr-part="palette"]');

/** Waits until the keyboard listener of the shell is on the window. */
export async function waitForShortcuts(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as Window & { __norenTest?: unknown }).__norenTest !== undefined,
        ),
      { message: "the shell has not set up its keyboard listener" },
    )
    .toBe(true);
}

/** Opens the palette with its shortcut, once the shortcut is heard, and waits for the dialog. */
export async function openCommandPalette(page: Page): Promise<Locator> {
  await waitForShortcuts(page);
  await afterNextFrame(page);
  await page.keyboard.press("Control+Shift+P");
  const dialog = paletteDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Waits for the palette to go and for the keyboard to be handed back (see the top of the file). */
export async function waitForPaletteClosed(page: Page): Promise<void> {
  await expect(paletteDialog(page)).toBeHidden();
  await afterNextFrame(page);
}

/** Closes the palette with Escape and waits for it to be gone. */
export async function closeCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await waitForPaletteClosed(page);
}

/**
 * Presses Enter on the first row of the list once that row is the one Enter takes. The list shows
 * the new rows before the list component moves the highlight to the first of them, and an Enter in
 * that gap acts on the row that was highlighted for the old query (which may be gone): the palette
 * stays open and the command never runs. The row being selected is what the key needs, so the helper
 * waits for it (`aria-selected`) and not for a time.
 */
export async function chooseFirstOption(page: Page, text: string): Promise<void> {
  const first = paletteDialog(page).getByRole("option").first();
  await expect(first).toContainText(text);
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
}

/**
 * Runs a command of the palette by typing its name: opens it, narrows the list, chooses the first
 * row (which must be the command) and waits for the palette to go. `label` is the accessible name of
 * the search box (it follows the language).
 */
export async function runPaletteCommand(
  page: Page,
  name: string,
  label = "Command palette",
): Promise<void> {
  const dialog = await openCommandPalette(page);
  await dialog.getByRole("combobox", { name: label, exact: true }).fill(name);
  await chooseFirstOption(page, name);
  await waitForPaletteClosed(page);
}
