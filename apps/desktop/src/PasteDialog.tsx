import { useEffect, useRef } from "react";
import { useT } from "./i18n";
import { previewPaste } from "./paste";

interface PasteDialogProps {
  text: string;
  onPaste(): void;
  onCancel(): void;
}

/** Asks before a multi-line paste reaches the shell. Own React dialog, not `window.confirm`. */
export function PasteDialog({ text, onPaste, onCancel }: PasteDialogProps) {
  const t = useT();
  const pasteButton = useRef<HTMLButtonElement>(null);
  const preview = previewPaste(text);

  useEffect(() => {
    pasteButton.current?.focus();
  }, []);

  return (
    <div className="paste-backdrop">
      <div
        className="paste-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="paste-dialog-title">{t("paste.title", { count: preview.total })}</h2>
        <p>{t("paste.warning")}</p>
        <pre className="paste-preview">
          {preview.lines.join("\n")}
          {preview.hidden > 0 ? `\n${t("paste.more", { count: preview.hidden })}` : ""}
        </pre>
        <div className="paste-actions">
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" ref={pasteButton} onClick={onPaste}>
            {t("paste.paste")}
          </button>
        </div>
      </div>
    </div>
  );
}
