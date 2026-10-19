import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useLanguage, useT } from "./i18n";
import { actionName } from "./i18n/names";
import { updateKeybindings, setRecording, useKeybindings } from "./keybindings-store";
import {
  changeBinding,
  filterRows,
  formatChord,
  presetShellKeys,
  recordedKey,
  shortcutRows,
} from "./shortcuts-screen";
import type { Change } from "./shortcuts-screen";

interface Feedback {
  kind: "status" | "conflict";
  text: string;
}

interface ShortcutsDialogProps {
  onClose(): void;
}

/**
 * The shortcuts screen: every action with its chord, a search box, and per action a way to record a
 * new chord, go back to the preset's chord or leave the action without one. A chord another action
 * holds is refused with a warning and nothing changes.
 */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const t = useT();
  const language = useLanguage();
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const keybindings = useKeybindings();
  const keybindingsRef = useRef(keybindings);
  keybindingsRef.current = keybindings;
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();

  // The rows say the actions in words, so a change of language makes them again.
  const rows = useMemo(() => shortcutRows(keybindings), [keybindings, language]);
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);
  const shellKeys = presetShellKeys("browser");

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const apply = (actionId: string, change: Change) => {
    const current = keybindingsRef.current;
    const result = changeBinding(current, actionId, change);
    const title = rows.find((row) => row.id === actionId)?.title ?? actionId;
    if (!result.ok) {
      const holders = result.holders
        .map((holder) => `"${actionName(holder.id, holder.title)}"`)
        .join(", ");
      setFeedback({
        kind: "conflict",
        text: t("shortcuts.conflict", { chord: formatChord(result.chord), holders, title }),
      });
      return;
    }
    updateKeybindings({ overrides: result.keybindings.overrides });
    const chord = shortcutRows(result.keybindings).find((row) => row.id === actionId)?.chord;
    setFeedback({
      kind: "status",
      text:
        chord === undefined
          ? t("shortcuts.hasNone", { title })
          : t("shortcuts.isNow", { title, chord: formatChord(chord) }),
    });
  };

  // While a row records, the next key press is read as its new chord. The flag keeps the global
  // shortcut listener from running the action the pressed chord already stands for.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (recordingId === undefined) return undefined;
    setRecording(true);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const key = recordedKey(event);
      if (key.kind === "wait") return;
      if (key.kind === "invalid") {
        setFeedback({ kind: "status", text: key.hint });
        return;
      }
      setRecordingId(undefined);
      if (key.kind === "cancel") {
        setFeedback({ kind: "status", text: t("shortcuts.cancelled") });
        return;
      }
      applyRef.current(recordingId, { kind: "set", chord: key.chord });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      setRecording(false);
    };
  }, [recordingId]);

  const startRecording = (actionId: string, title: string) => {
    setRecordingId(actionId);
    setFeedback({
      kind: "status",
      text: t("shortcuts.prompt", { title }),
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div className="dialog-backdrop">
      <div
        className="space-dialog shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{t("shortcuts.title")}</h2>
        <input
          ref={searchRef}
          type="text"
          aria-label={t("shortcuts.searchLabel")}
          placeholder={t("shortcuts.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="shortcuts-note">
          {keybindings.preset === "browser"
            ? t("shortcuts.noteBrowserOn", { keys: shellKeys.join(", ") })
            : t("shortcuts.noteBrowserOff", { keys: shellKeys.join(", ") })}
        </p>
        <div className="shortcuts-feedback">
          <p role="status">{feedback?.kind === "status" ? feedback.text : ""}</p>
          {feedback?.kind === "conflict" && (
            <p role="alert" className="shortcuts-warning">
              {feedback.text}
            </p>
          )}
        </div>
        <ul className="shortcuts-list" aria-label={t("shortcuts.list")}>
          {shown.map((row) => (
            <li key={row.id} className="shortcuts-row">
              <span className="shortcuts-title">{row.title}</span>
              <span className="shortcuts-category">{row.category}</span>
              <kbd
                className="shortcuts-chord"
                aria-label={t("shortcuts.forAction", { title: row.title })}
              >
                {row.chord === undefined ? t("shortcuts.none") : formatChord(row.chord)}
              </kbd>
              <span className="shortcuts-buttons">
                <button
                  type="button"
                  aria-label={t("shortcuts.record", { title: row.title })}
                  aria-pressed={recordingId === row.id}
                  onClick={() =>
                    recordingId === row.id
                      ? setRecordingId(undefined)
                      : startRecording(row.id, row.title)
                  }
                >
                  {recordingId === row.id ? t("shortcuts.pressKeys") : t("common.record")}
                </button>
                <button
                  type="button"
                  aria-label={t("shortcuts.reset", { title: row.title })}
                  disabled={!row.overridden}
                  onClick={() => apply(row.id, { kind: "reset" })}
                >
                  {t("common.reset")}
                </button>
                <button
                  type="button"
                  aria-label={t("shortcuts.remove", { title: row.title })}
                  disabled={row.chord === undefined}
                  onClick={() => apply(row.id, { kind: "remove" })}
                >
                  {t("common.remove")}
                </button>
              </span>
            </li>
          ))}
        </ul>
        {shown.length === 0 && <p className="shortcuts-empty">{t("shortcuts.empty")}</p>}
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
