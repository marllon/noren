import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { Backend } from "@noren/model";
import { ConfirmDialog } from "./ConfirmDialog";
import { formatBytes } from "./bench-format";
import { useT } from "./i18n";
import { readModelsView, sharePercent } from "./models-view";
import type { ModelsView, ModelsViewRow } from "./models-view";

/** A line under the table about what the last install button did; a missing terminal is read out as an alert. */
interface Note {
  text: string;
  alert: boolean;
}

interface ModelsPanelProps {
  backend: Pick<Backend, "readHardware">;
  /**
   * Puts `text` at the prompt of the focused terminal without Enter (the same insert as the Ask
   * panel); false when there is no terminal to put it in.
   */
  onInsert(text: string): boolean;
}

/**
 * The local models that fit this computer, inside the AI section of the settings screen: the memory
 * is read once when the screen opens, `recommendedBenchModels` chooses the list, and each model has an
 * install button that shows the `ollama pull` command and asks first. Only after the person confirms
 * is the command put at the prompt of the focused terminal, and never with Enter (D8): nothing here
 * runs it.
 */
export function ModelsPanel({ backend, onInsert }: ModelsPanelProps) {
  const t = useT();
  const [view, setView] = useState<ModelsView>();
  const [pending, setPending] = useState<ModelsViewRow>();
  const [note, setNote] = useState<Note>();
  // The install button that opened the question, which takes the keyboard back when it closes.
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let current = true;
    void readModelsView(backend).then((next) => {
      if (current) setView(next);
    });
    return () => {
      current = false;
    };
  }, [backend]);

  const closeQuestion = () => {
    setPending(undefined);
    trigger.current?.focus();
  };

  const confirm = () => {
    if (pending === undefined || pending.command === null) return;
    const { command } = pending;
    const put = onInsert(command);
    setPending(undefined);
    setNote(
      put
        ? { text: t("models.inserted", { command }), alert: false }
        : { text: t("models.noTerminal"), alert: true },
    );
    // The terminal takes the keyboard when it gets text; the screen is still open, so give it back.
    trigger.current?.focus();
  };

  const ask = (row: ModelsViewRow, event: MouseEvent<HTMLButtonElement>) => {
    trigger.current = event.currentTarget;
    setNote(undefined);
    setPending(row);
  };

  const reasonLabel = (row: ModelsViewRow) =>
    t(`models.reason.${row.reason}`, { headroom: formatBytes(row.headroomBytes) });
  const usesLabel = (row: ModelsViewRow) =>
    row.uses.map((use) => t(`settings.ai.${use}`)).join(", ");

  return (
    <div className="settings-bench settings-models" data-nr-part="settings-ai-models">
      <h4>{t("models.title")}</h4>
      {view === undefined && (
        <p role="status" className="settings-hint">
          {t("models.loading")}
        </p>
      )}
      {view?.state === "unknown" && (
        <p role="alert" className="settings-warning" data-nr-part="settings-models-warning">
          {t("models.unknown")}
        </p>
      )}
      {view?.state === "failed" && (
        <p role="alert" className="settings-warning" data-nr-part="settings-models-warning">
          {t("models.failed", { reason: view.reason })}
        </p>
      )}
      {view?.state === "invalid" && (
        <p role="alert" className="settings-warning" data-nr-part="settings-models-warning">
          {t("models.invalid")}
        </p>
      )}
      {view?.state === "ready" && (
        <>
          <p className="settings-hint" data-nr-part="settings-models-hardware">
            {view.hardware.vramBytes === null
              ? t("models.hardware.noVram", { ram: formatBytes(view.hardware.ramBytes) })
              : t("models.hardware.vram", {
                  ram: formatBytes(view.hardware.ramBytes),
                  vram: formatBytes(view.hardware.vramBytes),
                })}
          </p>
          {view.rows.length === 0 ? (
            <p className="settings-hint" data-nr-part="settings-models-empty">
              {t("models.empty", {
                budget: formatBytes(view.budgetBytes),
                smallest: formatBytes(view.smallestNeedBytes ?? 0),
              })}
            </p>
          ) : (
            <>
              <p className="settings-hint" data-nr-part="settings-models-budget">
                {t(`models.chosenFor.${view.memory}`, {
                  budget: formatBytes(view.budgetBytes),
                  percent: sharePercent(view.memory),
                })}
              </p>
              <div className="settings-bench-scroll">
                <table className="settings-bench-table" aria-label={t("models.table")}>
                  <thead>
                    <tr>
                      <th scope="col">{t("models.col.model")}</th>
                      <th scope="col">{t("models.col.download")}</th>
                      <th scope="col">{t("models.col.memory")}</th>
                      <th scope="col">{t("models.col.uses")}</th>
                      <th scope="col">{t("models.col.license")}</th>
                      <th scope="col">{t("models.col.reason")}</th>
                      <th scope="col">{t("models.col.install")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((row) => (
                      <tr
                        key={row.id}
                        data-nr-part="settings-models-row"
                        data-nr-model={row.id}
                        data-nr-reason={row.reason}
                      >
                        <th scope="row">{row.id}</th>
                        <td>{formatBytes(row.downloadBytes)}</td>
                        <td>{formatBytes(row.minMemoryBytes)}</td>
                        <td>{usesLabel(row)}</td>
                        <td>{row.license}</td>
                        <td>{reasonLabel(row)}</td>
                        <td>
                          {row.command !== null && (
                            <button
                              type="button"
                              className="settings-link"
                              aria-label={t("models.installLabel", { model: row.id })}
                              onClick={(event) => ask(row, event)}
                            >
                              {t("models.install")}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      <p
        role={note?.alert === true ? "alert" : "status"}
        className={note?.alert === true ? "settings-warning" : "settings-hint"}
        data-nr-part="settings-models-note"
      >
        {note?.text ?? ""}
      </p>
      <p className="settings-hint">{t("models.footnote")}</p>
      {pending !== undefined && pending.command !== null && (
        // Escape here only closes the question: it must not reach the settings screen under it.
        <div className="settings-confirm" onKeyDown={(event) => event.stopPropagation()}>
          <ConfirmDialog
            title={t("models.confirmTitle", { model: pending.id })}
            message={t("models.confirmMessage", { size: formatBytes(pending.downloadBytes) })}
            detail={pending.command}
            confirmLabel={t("models.confirmButton")}
            danger={false}
            titleLevel={4}
            onCancel={closeQuestion}
            onConfirm={confirm}
          />
        </div>
      )}
    </div>
  );
}
