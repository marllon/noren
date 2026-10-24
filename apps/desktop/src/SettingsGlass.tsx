import {
  AppWindow,
  Archive,
  Bell,
  Box,
  Download,
  Image,
  Keyboard,
  LayoutGrid,
  PanelLeft,
  Palette,
  Puzzle,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  Upload,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";
import type { InterfaceStyle } from "@noren/model";
import { fieldDescription } from "./i18n/names";
import type { SettingsSection } from "./settings-nav";

/**
 * The parts of the settings screen that the two styles draw each their way (NOR-F20-19 and NOR-F20-21b): an icon on each section of the column (the glass has them, the dense one numbers its sections
 * with a counter of the style sheet), the mark of the search (the magnifier under glass, the slash of the
 * design under dense), and the two cards that choose the interface style (both screens have them). The
 * cards are radio buttons like the buttons of the other choices: the input is the control (the click, the
 * arrow keys, the focus), and the picture of the style is for the eyes.
 */

/** The icon of each section of the column; they are drawings, so a screen reader says the name only. */
const SECTION_ICONS: Readonly<Record<SettingsSection, LucideIcon>> = {
  appearance: PanelLeft,
  themes: Palette,
  window: AppWindow,
  background: Image,
  terminal: Terminal,
  profiles: Box,
  shortcuts: Keyboard,
  notifications: Bell,
  archive: Archive,
  ai: Sparkles,
  mods: Puzzle,
  gallery: LayoutGrid,
  sync: RefreshCw,
  updates: Download,
  import: Upload,
};

/** The icon at the left of a section of the column. */
export function SectionIcon({ section }: { section: SettingsSection }) {
  const Icon = SECTION_ICONS[section];
  return <Icon className="settings-nav-icon" size={16} strokeWidth={1.75} aria-hidden="true" />;
}

/**
 * The search box with its mark: the box is `children`, drawn inside the frame of the field. The mark is a
 * drawing, so it says nothing to a screen reader (the box has its own name).
 */
export function SearchField({ style, children }: { style: InterfaceStyle; children: ReactNode }) {
  return (
    <div className="settings-search-field" data-nr-part="settings-search-field">
      {style === "glass" ? (
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <span className="settings-search-slash" aria-hidden="true">
          /
        </span>
      )}
      {children}
    </div>
  );
}

export interface StyleCardsProps {
  /** The name of the group: what the choice is about. */
  legend: string;
  /** The path of the field in the schema, whose description is the tooltip of the group. */
  field?: string;
  /** The explanation of the choice, in gray under its name. */
  hint?: string;
  name: string;
  value: InterfaceStyle;
  /** Each style with a short line about it, which is said after its name. */
  options: readonly { value: InterfaceStyle; label: string; note: string }[];
  onChange(value: InterfaceStyle): void;
}

/** The little picture of a style on its card: the glass is two cards over a landscape, the dense a ruled grid. */
function StyleThumb({ style }: { style: InterfaceStyle }) {
  return (
    <span className="settings-style-thumb" data-nr-thumb={style} aria-hidden="true">
      {style === "glass" ? (
        <>
          <span className="settings-style-ridge" />
          <span className="settings-style-side" />
          <span className="settings-style-main" />
        </>
      ) : (
        <>
          <span className="settings-style-bar" />
          <span className="settings-style-rail" />
          <span className="settings-style-grid">
            <span />
            <span />
          </span>
          <span className="settings-style-status" />
        </>
      )}
    </span>
  );
}

/**
 * The choice of the interface style as two cards, each with the picture of its style, a radio mark, its
 * name and a line about it. The group is named by its label, as a fieldset is by its legend; the line
 * about a style is what the radio button is described by, so the name of the button is the style.
 */
export function StyleCards({
  legend,
  field,
  hint,
  name,
  value,
  options,
  onChange,
}: StyleCardsProps) {
  const labelId = useId();
  const explainId = useId();
  const title = field === undefined ? undefined : fieldDescription(field) || undefined;
  return (
    <div
      className="settings-style"
      data-nr-part="settings-style"
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hint !== undefined ? explainId : undefined}
      title={title}
    >
      <div className="settings-style-head">
        <span id={labelId} className="settings-label">
          {legend}
        </span>
        {hint !== undefined && (
          <p id={explainId} className="settings-hint settings-explain">
            {hint}
          </p>
        )}
      </div>
      <div className="settings-style-cards">
        {options.map((option) => {
          const noteId = `${labelId}-${option.value}`;
          return (
            <label
              key={option.value}
              className="settings-style-card"
              data-nr-part="settings-style-card"
              data-nr-style-option={option.value}
            >
              <input
                type="radio"
                name={name}
                checked={option.value === value}
                aria-describedby={noteId}
                onChange={() => onChange(option.value)}
              />
              <StyleThumb style={option.value} />
              <span className="settings-style-line">
                <span className="settings-style-mark" aria-hidden="true" />
                <span className="settings-style-name">{option.label}</span>
                <span id={noteId} className="settings-style-note" aria-hidden="true">
                  {option.note}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
