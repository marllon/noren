import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COVERING_SELECTOR, coversWindow } from "./native-cover";

const here = fileURLToPath(new URL(".", import.meta.url));

/** A page that has the elements the selector finds, as the names of those that match it. */
function pageWith(...elements: string[]): Pick<ParentNode, "querySelector"> {
  const selectors = COVERING_SELECTOR.split(",").map((part) => part.trim());
  return {
    querySelector: ((selector: string) =>
      selector === COVERING_SELECTOR && elements.some((element) => selectors.includes(element))
        ? {}
        : null) as ParentNode["querySelector"],
  };
}

describe("what covers the window", () => {
  it("is a modal, a menu or the tab switcher", () => {
    expect(coversWindow(pageWith('[aria-modal="true"]'))).toBe(true);
    expect(coversWindow(pageWith('[role="menu"]'))).toBe(true);
    expect(coversWindow(pageWith('[data-nr-part="mru"]'))).toBe(true);
  });

  it("is nothing on a page with no such element", () => {
    expect(coversWindow(pageWith())).toBe(false);
  });
});

/** The sources of the interface that draw something (not their tests). */
function components(): { file: string; text: string }[] {
  return readdirSync(here)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .map((file) => ({ file, text: readFileSync(join(here, file), "utf8") }));
}

describe("the dialogs of the interface", () => {
  // The web view of a browser pane is native and sits over the page, so a dialog only keeps it out
  // of the way if it says it is modal. A dialog added without it would open under the page.
  it("every one that says it is a dialog also says it is modal", () => {
    const offenders: string[] = [];
    for (const { file, text } of components()) {
      const dialogs = text.match(/role="(?:alert)?dialog"/g)?.length ?? 0;
      const modals = text.match(/aria-modal="true"/g)?.length ?? 0;
      if (dialogs !== modals) offenders.push(`${file}: ${dialogs} dialogs, ${modals} modal`);
    }
    expect(offenders).toEqual([]);
  });

  it("finds the dialogs, so the check above looks at something", () => {
    const withDialogs = components().filter(({ text }) => /role="(?:alert)?dialog"/.test(text));
    expect(withDialogs.length).toBeGreaterThan(8);
  });
});
