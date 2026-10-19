import type { AppliedMod } from "@noren/model";

// Puts the mods that are in force into the document: one `<style data-nr-mod="name.css">` for each,
// holding the CSS already wrapped in `@layer mods` (`wrapModCss`), in the order of the cascade (the
// last one wins). The elements are kept between runs: a mod whose text did not change is left alone,
// so editing one file does not restyle the others.

/** The attribute that tells a style element of a mod from every other. */
export const MOD_STYLE_ATTRIBUTE = "data-nr-mod";

/**
 * Makes the mod styles of `host` (the `<head>`) exactly `applied`, in that order: a style whose mod
 * is no longer in force goes, a new one is made, one whose text changed is rewritten, and they are
 * put in the order given. Nothing is touched when nothing changed.
 */
export function syncModStyles(host: Element, applied: readonly AppliedMod[]): void {
  const selector = `style[${MOD_STYLE_ATTRIBUTE}]`;
  const byName = new Map<string, Element>();
  for (const element of host.querySelectorAll(selector)) {
    const name = element.getAttribute(MOD_STYLE_ATTRIBUTE) ?? "";
    // A second element with the same name is a leftover.
    if (byName.has(name) || !applied.some((mod) => mod.name === name)) element.remove();
    else byName.set(name, element);
  }

  const wanted: Element[] = [];
  for (const { name, css } of applied) {
    let element = byName.get(name);
    if (element === undefined) {
      element = host.ownerDocument.createElement("style");
      element.setAttribute(MOD_STYLE_ATTRIBUTE, name);
    }
    if (element.textContent !== css) element.textContent = css;
    wanted.push(element);
  }

  const inPlace = [...host.querySelectorAll(selector)];
  const sameOrder =
    inPlace.length === wanted.length &&
    inPlace.every((element, index) => element === wanted[index]);
  // Appending moves an element that is in the document already, so this also puts them in order.
  if (!sameOrder) host.append(...wanted);
}
