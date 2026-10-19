import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
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
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const keybindings = useKeybindings();
  const keybindingsRef = useRef(keybindings);
  keybindingsRef.current = keybindings;
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();

  const rows = useMemo(() => shortcutRows(keybindings), [keybindings]);
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
      const holders = result.holders.map((holder) => `"${holder.title}"`).join(", ");
      setFeedback({
        kind: "conflict",
        text: `${formatChord(result.chord)} is already used by ${holders}. "${title}" keeps its shortcut; nothing changed.`,
      });
      return;
    }
    updateKeybindings({ overrides: result.keybindings.overrides });
    const chord = shortcutRows(result.keybindings).find((row) => row.id === actionId)?.chord;
    setFeedback({
      kind: "status",
      text:
        chord === undefined
          ? `"${title}" has no shortcut now.`
          : `"${title}" is now ${formatChord(chord)}.`,
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
        setFeedback({ kind: "status", text: "Recording cancelled." });
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
      text: `Press the new shortcut for "${title}", or Escape to cancel.`,
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
        <h2 id={titleId}>Keyboard shortcuts</h2>
        <input
          ref={searchRef}
          type="text"
          aria-label="Search shortcuts"
          placeholder="Search by action, category or keys"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="shortcuts-note">
          {keybindings.preset === "browser"
            ? `The browser preset is on: ${shellKeys.join(", ")} no longer reach the terminal, so a shell program that uses them does not receive them.`
            : `The browser preset would take ${shellKeys.join(", ")} away from the terminal, so a shell program that uses them would not receive them.`}
        </p>
        <div className="shortcuts-feedback">
          <p role="status">{feedback?.kind === "status" ? feedback.text : ""}</p>
          {feedback?.kind === "conflict" && (
            <p role="alert" className="shortcuts-warning">
              {feedback.text}
            </p>
          )}
        </div>
        <ul className="shortcuts-list" aria-label="Shortcuts">
          {shown.map((row) => (
            <li key={row.id} className="shortcuts-row">
              <span className="shortcuts-title">{row.title}</span>
              <span className="shortcuts-category">{row.category}</span>
              <kbd className="shortcuts-chord" aria-label={`Shortcut for ${row.title}`}>
                {row.chord === undefined ? "None" : formatChord(row.chord)}
              </kbd>
              <span className="shortcuts-buttons">
                <button
                  type="button"
                  aria-label={`Record shortcut for ${row.title}`}
                  aria-pressed={recordingId === row.id}
                  onClick={() =>
                    recordingId === row.id
                      ? setRecordingId(undefined)
                      : startRecording(row.id, row.title)
                  }
                >
                  {recordingId === row.id ? "Press keys" : "Record"}
                </button>
                <button
                  type="button"
                  aria-label={`Reset shortcut for ${row.title}`}
                  disabled={!row.overridden}
                  onClick={() => apply(row.id, { kind: "reset" })}
                >
                  Reset
                </button>
                <button
                  type="button"
                  aria-label={`Remove shortcut for ${row.title}`}
                  disabled={row.chord === undefined}
                  onClick={() => apply(row.id, { kind: "remove" })}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
        {shown.length === 0 && <p className="shortcuts-empty">No shortcut matches.</p>}
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
