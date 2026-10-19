import { useT } from "./i18n";
import type { MruRow } from "./use-mru-switcher";

interface MruSwitcherViewProps {
  rows: readonly MruRow[];
}

/**
 * The overlay of the Ctrl+Tab switcher: every open tab by recent use, each with the last lines of
 * its output. It never takes the keyboard (the terminal keeps it until the switch is committed), so
 * it is a list the user reads, not a dialog.
 */
export function MruSwitcherView({ rows }: MruSwitcherViewProps) {
  const t = useT();
  return (
    <div className="mru-backdrop">
      <div className="mru" data-nr-part="mru" role="listbox" aria-label={t("mru.label")}>
        {rows.map((row) => (
          <div
            key={row.itemId}
            className="mru-row"
            role="option"
            aria-selected={row.selected}
            data-nr-item-id={row.itemId}
            data-nr-state={row.selected ? "selected" : undefined}
          >
            <div className="mru-head">
              <span className="mru-dot" aria-hidden="true" style={{ background: row.spaceColor }} />
              <span className="mru-title">{row.title}</span>
              <span className="mru-detail">{row.detail}</span>
            </div>
            <pre className="mru-preview" data-nr-part="mru-preview">
              {row.preview.length > 0 ? row.preview.join("\n") : t("output.none")}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
