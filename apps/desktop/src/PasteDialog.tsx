import { useEffect, useRef } from "react";
import { previewPaste } from "./paste";

interface PasteDialogProps {
  text: string;
  onPaste(): void;
  onCancel(): void;
}

/** Asks before a multi-line paste reaches the shell. Own React dialog, not `window.confirm`. */
export function PasteDialog({ text, onPaste, onCancel }: PasteDialogProps) {
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
        <h2 id="paste-dialog-title">Paste {preview.total} lines?</h2>
        <p>Every line may run as a command.</p>
        <pre className="paste-preview">
          {preview.lines.join("\n")}
          {preview.hidden > 0 ? `\n… and ${preview.hidden} more` : ""}
        </pre>
        <div className="paste-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" ref={pasteButton} onClick={onPaste}>
            Paste
          </button>
        </div>
      </div>
    </div>
  );
}
