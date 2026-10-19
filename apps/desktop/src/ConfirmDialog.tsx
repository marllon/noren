import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  /** Text shown as is under the message (a command line), in a block that keeps line breaks. */
  detail?: string;
  /** Styles the confirm button as destructive. Defaults to true. */
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** Asks before something that cannot be undone. Focus starts on "Cancel"; Esc cancels. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  detail,
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        className="space-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={messageId} className="dialog-message">
          {message}
        </p>
        {detail !== undefined && <pre className="dialog-detail">{detail}</pre>}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={danger ? "danger" : undefined} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
