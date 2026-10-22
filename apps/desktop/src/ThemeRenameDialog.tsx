import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useT } from "./i18n";

interface ThemeRenameDialogProps {
  /** The name the theme has now, which the box starts with. */
  name: string;
  /** Answers the sentence that says why the name was refused, or `undefined` when it was taken. */
  onRename(name: string): Promise<string | undefined>;
  onCancel(): void;
}

/**
 * Asks for the new name of a theme of the user. It is drawn by the themes section, a part of the
 * settings screen, so it takes Escape itself (the screen would otherwise close under it) and Enter
 * in the box asks for the rename. A name that is refused is said under the box and the dialog
 * stays; the box starts selected, so typing replaces the old name.
 */
export function ThemeRenameDialog({ name, onRename, onCancel }: ThemeRenameDialogProps) {
  const t = useT();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const problemId = useId();
  const [value, setValue] = useState(name);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const refused = await onRename(value);
    setBusy(false);
    if (refused !== undefined) {
      setProblem(refused);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      event.stopPropagation();
      void submit();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        className="space-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-nr-part="theme-rename"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{t("themes.renameTitle")}</h2>
        <label className="field">
          <span>{t("themes.renameName")}</span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem !== undefined ? true : undefined}
            aria-describedby={problem !== undefined ? problemId : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setProblem(undefined);
            }}
          />
        </label>
        {problem !== undefined && (
          <p id={problemId} className="settings-hint" role="alert">
            {problem}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
            {t("themes.renameConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
