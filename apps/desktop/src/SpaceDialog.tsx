import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Space } from "@noren/model";
import { SPACE_ICONS, isSpaceIcon } from "./SpaceIcon";
import {
  SPACE_COLORS,
  SPACE_ICON_NAMES,
  formatEnvLines,
  isSingleGlyph,
  parseEnvLines,
} from "./spaces";

/** What the dialog collects. A blank `cwd` means no start folder. */
export interface SpaceFormValues {
  name: string;
  icon: string;
  color: string;
  cwd: string;
  env: Record<string, string>;
}

interface SpaceDialogProps {
  /** The space to edit; without it the dialog makes a new one. */
  space?: Space;
  onSubmit(values: SpaceFormValues): void;
  onCancel(): void;
}

/** Collects the name, color, icon, start folder and environment of a space, new or existing. */
export function SpaceDialog({ space, onSubmit, onCancel }: SpaceDialogProps) {
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const editing = space !== undefined;
  const [name, setName] = useState(space?.name ?? "");
  const [color, setColor] = useState(space?.color ?? SPACE_COLORS[0]?.value ?? "");
  // A Lucide icon is picked from the list; any other icon name is an emoji, typed in its own field.
  const [lucide, setLucide] = useState<string>(
    space !== undefined && isSpaceIcon(space.icon) ? space.icon : SPACE_ICON_NAMES[0],
  );
  const [emoji, setEmoji] = useState(
    space !== undefined && !isSpaceIcon(space.icon) ? space.icon : "",
  );
  const [cwd, setCwd] = useState(space?.defaults.cwd ?? "");
  const [envText, setEnvText] = useState(formatEnvLines(space?.defaults.env ?? {}));
  const [error, setError] = useState<string>();

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Give the space a name.");
      return;
    }
    const glyph = emoji.trim();
    if (glyph !== "" && !isSingleGlyph(glyph)) {
      setError("Use a single emoji for the icon.");
      return;
    }
    const env = parseEnvLines(envText);
    if (!env.ok) {
      setError(env.error);
      return;
    }
    onSubmit({
      name,
      icon: glyph !== "" ? glyph : lucide,
      color,
      cwd: cwd.trim(),
      env: env.env,
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="dialog-backdrop">
      <form
        className="space-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{editing ? "Edit space" : "New space"}</h2>
        <label className="field">
          <span>Name</span>
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset className="field choices">
          <legend>Color</legend>
          {SPACE_COLORS.map((choice) => (
            <label key={choice.value} className="swatch">
              <input
                type="radio"
                name="space-color"
                aria-label={choice.name}
                checked={color === choice.value}
                onChange={() => setColor(choice.value)}
              />
              <span style={{ background: choice.value }} />
            </label>
          ))}
        </fieldset>
        <fieldset className="field choices">
          <legend>Icon</legend>
          {SPACE_ICON_NAMES.map((choice) => {
            const { label, Icon } = SPACE_ICONS[choice];
            return (
              <label key={choice} className="swatch">
                <input
                  type="radio"
                  name="space-icon"
                  aria-label={label}
                  checked={emoji.trim() === "" && lucide === choice}
                  onChange={() => {
                    setLucide(choice);
                    setEmoji("");
                  }}
                />
                <span>
                  <Icon size={16} aria-hidden="true" />
                </span>
              </label>
            );
          })}
        </fieldset>
        <label className="field">
          <span>Emoji</span>
          <input
            value={emoji}
            placeholder="Optional, replaces the icon"
            onChange={(e) => setEmoji(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Start folder</span>
          <input value={cwd} placeholder="Optional" onChange={(e) => setCwd(e.target.value)} />
        </label>
        <label className="field">
          <span>Environment variables</span>
          <textarea
            rows={3}
            value={envText}
            placeholder="NAME=value, one per line"
            onChange={(e) => setEnvText(e.target.value)}
          />
        </label>
        {error !== undefined && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {editing ? "Save" : "Create space"}
          </button>
        </div>
      </form>
    </div>
  );
}
