import { useId } from "react";

// The boxes of the settings screen that hold a line of text or a choice, each with its label and, under
// it, the reason a value is refused.

export interface NumberBoxProps {
  label: string;
  value: string;
  problem: string | undefined;
  /** A box for a path or other text rather than a number. */
  text?: boolean;
  /** A box wide enough for a list of names or a path. */
  wide?: boolean;
  onChange(text: string): void;
}

export function NumberBox({
  label,
  value,
  problem,
  text = false,
  wide = false,
  onChange,
}: NumberBoxProps) {
  const hintId = useId();
  return (
    <div className={wide ? "settings-number settings-wide" : "settings-number"}>
      <label className="settings-option">
        <span>{label}</span>
        <input
          type="text"
          inputMode={text ? "text" : "decimal"}
          spellCheck={text ? false : undefined}
          autoComplete={text ? "off" : undefined}
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
  value: string;
  options: readonly { value: string; label: string }[];
  problem: string | undefined;
  onChange(value: string): void;
}

/** A drop-down list with its label; a problem is told under it, where the choice is made. */
export function SelectBox({ label, value, options, problem, onChange }: SelectBoxProps) {
  const hintId = useId();
  const selectId = useId();
  return (
    <div className="settings-number">
      <div className="settings-option">
        <label htmlFor={selectId}>{label}</label>
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
