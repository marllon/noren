import { useEffect, useRef, useSyncExternalStore } from "react";
import { useT } from "./i18n";
import type { UpdateController } from "./update-controller";
import {
  canCheck,
  canInstall,
  phaseIsAlert,
  phaseText,
  progressView,
  publishedText,
  updateOfPhase,
} from "./update-screen";

interface PanelProps {
  controller: UpdateController;
}

/**
 * The update of the app, inside the settings screen (NOR-F20-02b): the "Check for updates" button,
 * where the check stands, and, when a newer version was found, its release notes and the button
 * that downloads and installs it. Nothing here runs by itself: the check is a click (or the palette
 * command, which opens this section), and the install is another click on a found update. The
 * download shows a progress bar; every refusal is a sentence in the `status` line.
 */
export function UpdatePanel({ controller }: PanelProps) {
  const t = useT();
  const phase = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.phase,
  );
  const root = useRef<HTMLDivElement>(null);

  // The palette opened the settings to show a check: bring this section into view.
  // The settings screen puts the focus on its first control when it opens, which scrolls it back
  // to the top, so this waits for the next frame.
  useEffect(() => {
    if (!controller.takeReveal()) return;
    const frame = requestAnimationFrame(() => root.current?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [controller]);

  const text = phaseText(phase);
  const info = updateOfPhase(phase);
  const published = info === undefined ? null : publishedText(info.publishedAt);
  return (
    <div
      ref={root}
      className="settings-update"
      data-nr-part="settings-update"
      data-phase={phase.kind}
    >
      <p className="settings-hint">{t("update.hint")}</p>
      <div className="settings-sync-buttons">
        <button
          type="button"
          className="settings-link"
          disabled={!canCheck(phase)}
          onClick={() => void controller.check()}
        >
          {t("update.check")}
        </button>
      </div>
      {text !== undefined && (
        <p
          role="status"
          className={phaseIsAlert(phase) ? "settings-warning" : "settings-hint"}
          data-nr-part="update-status"
        >
          {text}
        </p>
      )}
      {phase.kind === "downloading" && <DownloadBar progress={phase.progress} />}
      {info !== undefined && (
        <div className="settings-update-release" data-nr-part="update-release">
          {published !== null && (
            <p className="settings-hint">{t("update.published", { date: published })}</p>
          )}
          <h4>{t("update.notes")}</h4>
          <div
            className="settings-update-notes"
            role="group"
            aria-label={t("update.notes")}
            tabIndex={0}
            data-nr-part="update-notes"
          >
            {info.notes === null || info.notes.trim() === "" ? t("update.notes.none") : info.notes}
          </div>
        </div>
      )}
      {canInstall(phase) && (
        <>
          <p className="settings-hint">{t("update.installHint")}</p>
          <div className="settings-sync-buttons">
            <button
              type="button"
              className="settings-link"
              onClick={() => void controller.install()}
            >
              {t("update.install")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function DownloadBar({ progress }: { progress: Parameters<typeof progressView>[0] }) {
  const t = useT();
  const view = progressView(progress);
  return (
    <div className="settings-update-progress" data-nr-part="update-progress">
      <progress
        max={100}
        {...(view.percent === null ? {} : { value: view.percent })}
        aria-label={t("update.progress.label")}
      />
      <span className="settings-hint" data-nr-part="update-progress-text">
        {view.label}
      </span>
    </div>
  );
}
