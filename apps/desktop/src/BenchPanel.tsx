import { useCallback, useEffect, useState } from "react";
import {
  benchDefaultEdits,
  benchScoreboard,
  benchScoreboardCsv,
  knownAiProviderIds,
  loadBenchRuns,
  recommendBenchModel,
} from "@noren/model";
import type { BenchKind, BenchScoreRow, Backend } from "@noren/model";
import { configManager, useConfigState } from "./config-store";
import { useT } from "./i18n";
import {
  NO_READING,
  formatBytes,
  formatDuration,
  formatPercent,
  formatTokensPerSecond,
  tokensSourceKey,
} from "./bench-format";

const KINDS: readonly BenchKind[] = ["command", "explain", "summarize"];

/** A line under the scoreboard about what its last button did; a refusal is read out as an alert. */
interface Note {
  text: string;
  alert: boolean;
}

/** The scoreboard, or why there is none: still reading, the folder could not be read, or the rows. */
type Loaded =
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | { state: "ready"; rows: BenchScoreRow[] };

interface BenchPanelProps {
  backend: Pick<Backend, "listBenchResults">;
}

/**
 * The bench scoreboard, inside the AI section of the settings screen: the saved results read
 * through the backend, one row for each model (accuracy, medians, tokens per second with where
 * they come from, memory, whether the run finished), the model recommended as the default marked,
 * a button to make a row the default of the three AI functions, and one to copy the table as CSV.
 * It only reads results; running the bench is not done from here. Making a model the default
 * writes config.jsonc at once (the comments stay) and does not turn the AI on.
 */
export function BenchPanel({ backend }: BenchPanelProps) {
  const t = useT();
  const { config } = useConfigState();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [note, setNote] = useState<Note>();
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    setLoaded({ state: "loading" });
    loadBenchRuns(backend).then(
      (saved) => setLoaded({ state: "ready", rows: benchScoreboard(saved) }),
      (error: unknown) =>
        setLoaded({
          state: "failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
    );
  }, [backend]);

  useEffect(() => {
    reload();
  }, [reload]);

  const rows = loaded.state === "ready" ? loaded.rows : [];
  const recommended = recommendBenchModel(rows);
  const known = knownAiProviderIds(config.ai?.providers);

  const apply = async (row: BenchScoreRow) => {
    if (busy) return;
    const plan = benchDefaultEdits({ provider: row.provider.id, model: row.model }, known);
    if (!plan.ok) {
      setNote({
        text:
          plan.reason === "unknown-provider"
            ? t("bench.refusedProvider", { provider: row.provider.id })
            : t("bench.refusedModel"),
        alert: true,
      });
      return;
    }
    setBusy(true);
    const result = await configManager.update(plan.edits);
    setBusy(false);
    setNote(
      result.ok
        ? {
            text: t("bench.applied", { model: row.model, provider: row.provider.id }),
            alert: false,
          }
        : { text: t("bench.applyFailed", { reason: result.message }), alert: true },
    );
  };

  const copyCsv = () => {
    const csv = benchScoreboardCsv(rows);
    navigator.clipboard.writeText(csv).then(
      () => setNote({ text: t("bench.copied", { count: rows.length }), alert: false }),
      () => setNote({ text: t("bench.copyFailed"), alert: true }),
    );
  };

  const kindLabel = (kind: BenchKind) => t(`bench.kind.${kind}`);
  const stateLabel = (row: BenchScoreRow) =>
    row.state === "complete"
      ? t("bench.state.complete")
      : t("bench.state.cancelled", { done: row.done, planned: row.planned });
  const runsLabel = (row: BenchScoreRow) =>
    row.runs === 1 ? t("bench.runs.one") : t("bench.runs.other", { count: row.runs });
  const tokensLabel = (row: BenchScoreRow) =>
    row.tokensSource === null
      ? NO_READING
      : `${formatTokensPerSecond(row.medianTokensPerSecond)} (${t(tokensSourceKey(row.tokensSource))})`;
  const memoryLabel = (row: BenchScoreRow) =>
    row.memory === null
      ? NO_READING
      : t("bench.memoryValue", {
          bytes: formatBytes(row.memory.bytes),
          vram: formatBytes(row.memory.vramBytes),
        });

  return (
    <div className="settings-bench" data-nr-part="settings-ai-bench">
      <h4>{t("bench.title")}</h4>
      {loaded.state === "loading" && (
        <p role="status" className="settings-hint">
          {t("bench.loading")}
        </p>
      )}
      {loaded.state === "failed" && (
        <p role="alert" className="settings-warning" data-nr-part="settings-bench-error">
          {t("bench.loadFailed", { reason: loaded.reason })}
        </p>
      )}
      {loaded.state === "ready" && rows.length === 0 && (
        <p className="settings-hint" data-nr-part="settings-bench-empty">
          {t("bench.empty")}
        </p>
      )}
      {rows.length > 0 && (
        <>
          <p className="settings-hint" data-nr-part="settings-bench-recommendation">
            {recommended === undefined
              ? t("bench.noRecommendation")
              : t("bench.recommendation", {
                  model: recommended.model,
                  provider: recommended.provider.id,
                })}
          </p>
          <div className="settings-bench-scroll">
            <table className="settings-bench-table" aria-label={t("bench.table")}>
              <thead>
                <tr>
                  <th scope="col">{t("bench.col.model")}</th>
                  <th scope="col">{t("bench.col.provider")}</th>
                  <th scope="col">{t("bench.col.accuracy")}</th>
                  {KINDS.map((kind) => (
                    <th key={kind} scope="col">
                      {kindLabel(kind)}
                    </th>
                  ))}
                  <th scope="col">{t("bench.col.firstPiece")}</th>
                  <th scope="col">{t("bench.col.totalTime")}</th>
                  <th scope="col">{t("bench.col.tokens")}</th>
                  <th scope="col">{t("bench.col.memory")}</th>
                  <th scope="col">{t("bench.col.state")}</th>
                  <th scope="col">{t("bench.col.use")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isRecommended = row === recommended;
                  return (
                    <tr
                      key={`${row.provider.id}\u0000${row.model}`}
                      data-nr-part="settings-bench-row"
                      data-nr-recommended={isRecommended ? "true" : "false"}
                      data-nr-state={row.state}
                    >
                      <th scope="row">
                        {row.model}
                        {isRecommended && (
                          <span
                            className="settings-bench-badge"
                            data-nr-part="settings-bench-badge"
                          >
                            {t("bench.recommended")}
                          </span>
                        )}
                      </th>
                      <td>{row.provider.id}</td>
                      <td>{formatPercent(row.accuracy)}</td>
                      {KINDS.map((kind) => (
                        <td key={kind}>
                          {row.byKind[kind].total === 0
                            ? NO_READING
                            : formatPercent(row.byKind[kind].accuracy)}
                        </td>
                      ))}
                      <td>{formatDuration(row.medianFirstChunkMs)}</td>
                      <td>{formatDuration(row.medianTotalMs)}</td>
                      <td>{tokensLabel(row)}</td>
                      <td>{memoryLabel(row)}</td>
                      <td>
                        {stateLabel(row)}
                        <br />
                        <span className="settings-hint">{runsLabel(row)}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="settings-link"
                          disabled={busy}
                          aria-label={t("bench.useLabel", {
                            model: row.model,
                            provider: row.provider.id,
                          })}
                          onClick={() => void apply(row)}
                        >
                          {t("bench.use")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="settings-bench-actions">
        {recommended !== undefined && (
          <button
            type="button"
            className="settings-link"
            disabled={busy}
            onClick={() => void apply(recommended)}
          >
            {t("bench.useRecommended")}
          </button>
        )}
        {rows.length > 0 && (
          <button type="button" className="settings-link" onClick={copyCsv}>
            {t("bench.copyCsv")}
          </button>
        )}
        <button type="button" className="settings-link" onClick={reload}>
          {t("bench.reload")}
        </button>
      </div>
      <p
        role={note?.alert === true ? "alert" : "status"}
        className={note?.alert === true ? "settings-warning" : "settings-hint"}
        data-nr-part="settings-bench-note"
      >
        {note?.text ?? ""}
      </p>
      <p className="settings-hint">{t("bench.footnote")}</p>
    </div>
  );
}
