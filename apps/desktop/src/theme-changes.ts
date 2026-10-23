import { ANSI_INDEXES, NUMBER_RANGES, ansiField, fieldText } from "@noren/model";
import type { NumberField, Theme, ThemeField } from "@noren/model";

/** Every box of the theme editor: the colors, the sixteen of the palette, the numbers, the font names and the picture. */
const FIELDS: readonly ThemeField[] = [
  "ui.accent",
  "ui.bg",
  "ui.surface",
  "ui.text",
  "ui.muted",
  "ui.border",
  "terminal.background",
  "terminal.foreground",
  "terminal.cursor",
  "terminal.selection",
  ...ANSI_INDEXES.map(ansiField),
  ...(Object.keys(NUMBER_RANGES) as NumberField[]),
  "font.family",
  "background.image",
];

/**
 * How many things the person has changed in the theme editor: every box whose value differs from the
 * theme the editor opened with, the kind, the ligatures and the name (against the name the editor
 * opened with). The dense editor says it in its header and at its foot; it is only a reading, the
 * editor saves the theme as it is.
 */
export function themeChanges(
  source: Theme,
  edited: Theme,
  name: string,
  startName: string,
): number {
  let count = 0;
  for (const field of FIELDS) {
    if (fieldText(source, field) !== fieldText(edited, field)) count += 1;
  }
  if (source.kind !== edited.kind) count += 1;
  if (source.font.ligatures !== edited.font.ligatures) count += 1;
  if (name !== startName) count += 1;
  return count;
}
