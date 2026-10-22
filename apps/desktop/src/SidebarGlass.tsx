import { PanelLeftClose, PanelLeftOpen, Search, Settings } from "lucide-react";
import { useT } from "./i18n";
import { ariaShortcutOf, useChord, useKeycap } from "./shortcut-keys";

/**
 * The parts the glass sidebar has at its head and foot that the dense one does not: the brand with
 * the button that folds the sidebar away, the search button of the palette, the keycap of a
 * shortcut and the settings button. Nothing here is drawn under the dense style (the page asks).
 */

/** The shortcut of an action as a keycap; nothing when the action has no key. */
export function Keycap({ actionId }: { actionId: string }) {
  const keycap = useKeycap(actionId);
  if (keycap === undefined) return null;
  return (
    <span className="keycap" data-nr-part="keycap" aria-hidden="true">
      {keycap}
    </span>
  );
}

interface SidebarHeadProps {
  /** Compact mode is on: the sidebar hides at the edge of the window, so the button keeps it open. */
  compact: boolean;
  /** Top tabs make the sidebar hide whatever the setting says; the button means nothing then. */
  canToggle: boolean;
  onToggle(): void;
}

/** The brand (the mark in the color of the space and the name) and the button that folds the sidebar. */
export function SidebarHead({ compact, canToggle, onToggle }: SidebarHeadProps) {
  const t = useT();
  const label = compact ? t("sidebar.dock") : t("sidebar.collapse");
  return (
    <div className="sidebar-head" data-nr-part="sidebar-head">
      <div className="sidebar-brand" data-nr-part="sidebar-brand">
        <span className="sidebar-mark" aria-hidden="true">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m5 8 4 4-4 4" />
            <path d="M12 16h7" />
          </svg>
        </span>
        <span className="sidebar-brand-name">noren</span>
      </div>
      {canToggle && (
        <button
          type="button"
          className="sidebar-collapse"
          data-nr-part="sidebar-collapse"
          aria-label={label}
          title={label}
          onClick={onToggle}
        >
          {compact ? (
            <PanelLeftOpen size={16} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={16} aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

interface SidebarSearchProps {
  /** The sidebar is wide enough for the whole sentence; else the short word. */
  roomy: boolean;
  onOpen(): void;
}

/** The field-like button that opens the command palette, with the shortcut that does the same. */
export function SidebarSearch({ roomy, onOpen }: SidebarSearchProps) {
  const t = useT();
  const chord = useChord("palette.open");
  return (
    <button
      type="button"
      className="sidebar-search"
      data-nr-part="sidebar-search"
      title={t("sidebar.search")}
      {...(chord !== undefined ? { "aria-keyshortcuts": ariaShortcutOf(chord) } : {})}
      onClick={onOpen}
    >
      <Search size={16} aria-hidden="true" />
      <span className="sidebar-search-text">
        {roomy ? t("sidebar.search") : t("sidebar.searchShort")}
      </span>
      <Keycap actionId="palette.open" />
    </button>
  );
}

/** The settings button at the foot of the glass sidebar (the title bar has it when the sidebar is not docked). */
export function SidebarSettings({ onOpen }: { onOpen(): void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="sidebar-settings"
      data-nr-part="sidebar-settings"
      aria-label={t("titleBar.settings")}
      title={t("titleBar.settings")}
      onClick={onOpen}
    >
      <Settings size={17} aria-hidden="true" />
    </button>
  );
}
