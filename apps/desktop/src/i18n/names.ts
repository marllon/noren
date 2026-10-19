import { en } from "./en";
import { t, tDynamic } from "./index";
import type { MessageKey } from "./index";

// The names of things the code knows by id, in the language in force: the actions of the shortcut
// registry (`keybindings.ts`), their categories and the window effects. The registry keeps the
// English title, which is also what the tests and the docs read; the screens say the action by its
// id, so the registry does not import the dictionary.

type Direction = "left" | "right" | "up" | "down";

/** The name of a window effect (`none`, `mica`, `acrylic`, `vibrancy`) in the language in force. */
export function effectName(effect: "none" | "mica" | "acrylic" | "vibrancy"): string {
  return t(`settings.effect.${effect}`);
}

/** The category of an action in the language in force. */
export function categoryName(category: string): string {
  const key = `category.${category}`;
  return isMessageKey(key) ? tDynamic(key) : category;
}

function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key);
}

function directionName(direction: string): string {
  const key = `direction.${direction as Direction}` as const;
  return t(key);
}

/** `pane.focus-left` and the like: the action with a value in its name (a direction or a digit). */
const PARAMETRIC = /^(pane\.focus|pane\.resize)-(left|right|up|down)$|^(space|tab)\.([1-9])$/;

/**
 * The name of an action in the language in force, from its id. `fallback` (the English title of the
 * registry) stands in for an id the dictionary does not know, so a new action still shows a name.
 */
export function actionName(id: string, fallback: string): string {
  const parametric = PARAMETRIC.exec(id);
  if (parametric !== null) {
    const [, pane, direction, group, digit] = parametric;
    if (pane === "pane.focus")
      return t("action.pane.focus", { direction: directionName(direction ?? "") });
    if (pane === "pane.resize") {
      return t("action.pane.resize", { direction: directionName(direction ?? "") });
    }
    return group === "space"
      ? t("action.space.go", { n: digit ?? "" })
      : t("action.tab.go", { n: digit ?? "" });
  }
  const key = `action.${id}`;
  return isMessageKey(key) ? tDynamic(key) : fallback;
}

/** Whether the dictionary names the action (the tests walk the whole registry with it). */
export function actionIsNamed(id: string): boolean {
  return PARAMETRIC.test(id) || isMessageKey(`action.${id}`);
}

/**
 * The description of a field of `config.jsonc` in the language in force, by its path in the schema
 * (`appearance.sidebar.position`; `item` stands for an entry of a list, as in `profiles.item.id`).
 * `@noren/model` keeps the English words that the generated JSON Schema shows an editor and never
 * imports the dictionary, so the screens say the field by its path. Empty for a path with none.
 */
export function fieldDescription(path: string): string {
  const key = `field.${path}`;
  return isMessageKey(key) ? tDynamic(key) : "";
}

/** The name of a color of the space dialog (`Blue`, by the name the list gives it). */
export function spaceColorName(name: string): string {
  const key = `spaceColor.${name.toLowerCase()}`;
  return isMessageKey(key) ? tDynamic(key) : name;
}

/** The name of an icon of the space dialog, by its id; `fallback` is the English label. */
export function spaceIconName(icon: string, fallback: string): string {
  const key = `spaceIcon.${icon}`;
  return isMessageKey(key) ? tDynamic(key) : fallback;
}
