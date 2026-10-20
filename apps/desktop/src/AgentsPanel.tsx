import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { AgentRow, Workspace } from "@noren/model";
import { useAgentRows } from "./agent-state-store";
import { useT } from "./i18n";

interface AgentsPanelProps {
  workspace: Workspace;
  /** The person chose an agent (Enter or a click). The caller goes to its space, tab and pane and closes the panel. */
  onPick(row: AgentRow): void;
  /** Escape or a click outside. */
  onClose(): void;
}

/**
 * The agents of all the spaces: which program, what it is doing, for how long, where it runs and the
 * last line it printed. The ones that wait for you come first. Up and Down move between the rows,
 * Enter or a click goes to the agent, Escape closes. The list follows the agents while it is open.
 * The name of an agent is the name of its executable: no logo, no product name.
 */
export function AgentsPanel({ workspace, onPick, onClose }: AgentsPanelProps) {
  const t = useT();
  const rows = useAgentRows(workspace);
  const dialog = useRef<HTMLDivElement>(null);

  // The keyboard starts on the first agent (the one that waits longest), or on the panel itself.
  useEffect(() => {
    const first = dialog.current?.querySelector<HTMLElement>("button.agents-open");
    (first ?? dialog.current)?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [
      ...(dialog.current?.querySelectorAll<HTMLElement>("button.agents-open") ?? []),
    ];
    if (buttons.length === 0) return;
    event.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div
      className="dialog-backdrop agents-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="agents"
        data-nr-part="agents"
        role="dialog"
        aria-modal="true"
        aria-label={t("agents.label")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="agents-head">
          <span className="agents-title">{t("agents.label")}</span>
          <span className="agents-count" data-nr-part="agents-count">
            {rows.length}
          </span>
        </div>
        {rows.length > 0 && (
          <ul className="agents-list" aria-label={t("agents.list")}>
            {rows.map((row) => {
              const state = t(`agents.state.${row.state}`);
              const where = t("agents.where", { tab: row.itemTitle, space: row.spaceName });
              const label =
                row.lastLine === ""
                  ? t("agents.row", { name: row.agentId, state, elapsed: row.elapsed, where })
                  : t("agents.rowWithLine", {
                      name: row.agentId,
                      state,
                      elapsed: row.elapsed,
                      where,
                      line: row.lastLine,
                    });
              return (
                <li
                  key={row.paneId}
                  className="agents-row"
                  data-nr-part="agents-row"
                  data-nr-agent-state={row.state}
                  data-pane-id={row.paneId}
                >
                  <button
                    type="button"
                    className="agents-open"
                    aria-label={label}
                    onClick={() => onPick(row)}
                  >
                    <span className="agent-dot" aria-hidden="true" />
                    <span className="agents-name" data-nr-part="agents-name">
                      {row.agentId}
                    </span>
                    <span className="agents-state" data-nr-part="agents-state">
                      {state}
                    </span>
                    <span className="agents-elapsed" data-nr-part="agents-elapsed">
                      {row.elapsed}
                    </span>
                    <span className="agents-where" data-nr-part="agents-where">
                      <span
                        className="agents-space-dot"
                        aria-hidden="true"
                        style={{ background: row.spaceColor }}
                      />
                      {where}
                    </span>
                    {row.lastLine !== "" && (
                      <span className="agents-line" data-nr-part="agents-line">
                        {row.lastLine}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {rows.length === 0 && (
          <div className="agents-empty" role="status" data-nr-part="agents-empty">
            {t("agents.none")}
          </div>
        )}
      </div>
    </div>
  );
}
