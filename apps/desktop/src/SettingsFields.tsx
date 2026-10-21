import { useId } from "react";
import { fieldDescription } from "./i18n/names";

// The boxes of the settings screen that hold a line of text or a choice, each with its label and, under
// it, the reason a value is refused.

/** The description of a field in the language in force, for the `title` of its control. */
const describe = (field: string | undefined): string | undefined =>
  field === undefined ? undefined : fieldDescription(field) || undefined;

export interface NumberBoxProps {
  label: string;
  /** The path of the field in the schema, whose description is the tooltip of the box. */
  field?: string;
  value: string;
  problem: string | undefined;
  /** A box for a path or other text rather than a number. */
  text?: boolean;
  /** A box wide enough for a list of names or a path. */
  wide?: boolean;
  /** A box for a secret (a token): the text is hidden, never completed or checked for spelling. */
  secret?: boolean;
  onChange(text: string): void;
}

export function NumberBox({
  label,
  field,
  value,
  problem,
  text = false,
  wide = false,
  secret = false,
  onChange,
}: NumberBoxProps) {
  const hintId = useId();
  return (
    <div className={wide ? "settings-number settings-wide" : "settings-number"}>
      <label className="settings-option" title={describe(field)}>
        <span>{label}</span>
        <input
          type={secret ? "password" : "text"}
          inputMode={text || secret ? "text" : "decimal"}
          spellCheck={text || secret ? false : undefined}
          autoComplete={text || secret ? "off" : undefined}
          value={value}
          aria-invalid={problem !== undefined ? true : undefined}
          aria-describedby={problem !== undefined ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {problem !== undefined && (
        <span id={hintId} className="settings-hint" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

export interface SelectBoxProps {
  label: string;
  field?: string;
  value: string;
  options: readonly { value: string; label: string }[];
  problem: string | undefined;
  onChange(value: string): void;
}

/** A drop-down list with its label; a problem is told under it, where the choice is made. */
export function SelectBox({ label, field, value, options, problem, onChange }: SelectBoxProps) {
  const hintId = useId();
  const selectId = useId();
  return (
    <div className="settings-number">
      <div className="settings-option">
        <label htmlFor={selectId} title={describe(field)}>
          {label}
        </label>
        <select
          id={selectId}
          value={value}
          aria-invalid={problem !== undefined ? true : undefined}
          aria-describedby={problem !== undefined ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {problem !== undefined && (
        <span id={hintId} className="settings-hint" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
