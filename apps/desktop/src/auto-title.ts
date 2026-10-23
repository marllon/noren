import { autoTabTitle } from "@noren/model";
import type { Action, Item } from "@noren/model";

/**
 * The action that gives a tab the title its focused pane asks for (`autoTabTitle`: its folder, then
 * the program it runs), or `undefined` when the tab already has it. A tab whose title the user chose
 * (locked) is never touched. When the pane asks for nothing, a title that came from the shell goes
 * away and the tab goes back to its number.
 */
export function autoTitleAction(item: Item, home?: string): Action | undefined {
  if (item.titleLocked) return undefined;
  const wanted = autoTabTitle(item, home);
  if (wanted === item.title) return undefined;
  return { type: "item/rename", itemId: item.id, title: wanted ?? "", source: "process" };
}
