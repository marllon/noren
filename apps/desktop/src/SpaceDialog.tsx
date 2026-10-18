import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { SPACE_ICONS } from "./SpaceIcon";
import { SPACE_COLORS, SPACE_ICON_NAMES, parseEnvLines } from "./spaces";
import type { NewSpaceInput } from "./workspace-store";

interface SpaceDialogProps {
  onCreate(input: NewSpaceInput): void;
  onCancel(): void;
}

/** Collects the name, color, icon, start folder and environment of a new space. */
export function SpaceDialog({ onCreate, onCancel }: SpaceDialogProps) {
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(SPACE_COLORS[0]?.value ?? "");
  const [icon, setIcon] = useState<string>(SPACE_ICON_NAMES[0]);
  const [cwd, setCwd] = useState("");
  const [envText, setEnvText] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Give the space a name.");
      return;
    }
    const env = parseEnvLines(envText);
    if (!env.ok) {
      setError(env.error);
      return;
    }
    onCreate({
      name,
      icon,
      color,
      ...(cwd.trim() !== "" ? { cwd: cwd.trim() } : {}),
      ...(Object.keys(env.env).length > 0 ? { env: env.env } : {}),
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
        <h2 id={titleId}>New space</h2>
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
                  checked={icon === choice}
                  onChange={() => setIcon(choice)}
                />
                <span>
                  <Icon size={16} aria-hidden="true" />
                </span>
              </label>
            );
          })}
        </fieldset>
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
            Create space
          </button>
        </div>
      </form>
    </div>
  );
}
