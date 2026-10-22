import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { Backend, PathKind } from "@noren/model";
import { useT } from "./i18n";
import { fieldDescription } from "./i18n/names";

// The controls of the settings screen, each the right one for its field (NOR-F20-10b): a switch for a
// yes or no (`Toggle`), a box with a slider beside it for a number that has a range (`NumberBox` with
// `slider`), a box with a chooser of the system for a path (`PathBox`), a row of buttons for a choice
// of two or three short ones and a drop-down list for the rest (`Choice` and `SelectBox`), and the
// color picker of the theme editor (`ThemeEditorDialog`). Each has its label and, under it, the
// explanation of the field (in gray) and the reason a value is refused. In the settings screen every
// one is a row of its grid (the label and the explanation on the left, the control on the right, see
// `.settings-content` in the style sheet); the other dialogs that use the boxes keep them stacked.

/** The description of a field in the language in force, for the `title` of its control. */
const describe = (field: string | undefined): string | undefined =>
  field === undefined ? undefined : fieldDescription(field) || undefined;

/** The ids a control points to for what it is described by (an id that is not there is left out). */
const describedBy = (...ids: (string | undefined)[]): string | undefined => {
  const present = ids.filter((id) => id !== undefined);
  return present.length > 0 ? present.join(" ") : undefined;
};

/** A slider that sets the same number as a box: its name, its range and where it stands now. */
export interface SliderSpec {
  /** The name of the slider for a screen reader (the box has its own label). */
  label: string;
  min: number;
  max: number;
  step: number;
  /** Where the handle stands: the number in the box, or the value in force while the box is empty. */
  value: number;
  /** What a screen reader says for the value, such as "55%"; the number itself without it. */
  valueText?: string;
}

/** The text a box holds for a number a slider chose: at most two decimals, no trailing zeros. */
export function sliderText(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** The range of a number the schema bounds on both ends, and the step its slider moves by. */
export interface RangeSpec {
  min: number;
  max: number;
  step: number;
}

/**
 * A slider on its own: the handle moves a number in its range, and the window follows at once (the
 * screens that use it show the number as a preview until it is saved).
 */
export function Slider({
  label,
  min,
  max,
  step,
  value,
  valueText,
  onChange,
}: SliderSpec & {
  onChange(value: number): void;
}) {
  return (
    <input
      type="range"
      className="settings-slider"
      aria-label={label}
      aria-valuetext={valueText}
      min={min}
      max={max}
      step={step}
      value={Math.min(max, Math.max(min, value))}
      onChange={(event) => onChange(event.target.valueAsNumber)}
    />
  );
}

/**
 * The text of a box while the person is in it. The settings are written as they are typed, and what
 * the file takes may be written differently from what was typed (`0.80` is the `0.8` of the file, a
 * name loses its trailing blank), so the box keeps the typed text until the person leaves it; the
 * text then follows `value` again, which is what the file has.
 */
function useTyped(value: string) {
  const [typed, setTyped] = useState<string>();
  return {
    shown: typed ?? value,
    /** Keeps `text` in the box and gives it back, for the handler that reports it. */
    type: (text: string): string => {
      setTyped(text);
      return text;
    },
    /** The box is left, or something else (a slider, a chooser) sets the value. */
    leave: (): void => setTyped(undefined),
  };
}

export interface NumberBoxProps {
  label: string;
  /** The path of the field in the schema, whose description is the tooltip of the box. */
  field?: string;
  /** The short explanation of the field, in gray under its label; the box is described by it. */
  hint?: string;
  value: string;
  problem: string | undefined;
  /** A box for a path or other text rather than a number. */
  text?: boolean;
  /** A box wide enough for a list of names or a path. */
  wide?: boolean;
  /** A box for a secret (a token): the text is hidden, never completed or checked for spelling. */
  secret?: boolean;
  /** A slider beside the box that sets the same number (the box stays, for a number typed by hand). */
  slider?: SliderSpec;
  /** What goes after the box in its row: the button that opens a chooser, and what it says when it fails. */
  extra?: ReactNode;
  onChange(text: string): void;
}

export function NumberBox({
  label,
  field,
  hint,
  value,
  problem,
  text = false,
  wide = false,
  secret = false,
  slider,
  extra,
  onChange,
}: NumberBoxProps) {
  const hintId = useId();
  const explainId = useId();
  const typed = useTyped(value);
  return (
    <div className={wide ? "settings-number settings-wide" : "settings-number"}>
      <label className="settings-option" title={describe(field)}>
        <span>{label}</span>
        <input
          type={secret ? "password" : "text"}
          inputMode={text || secret ? "text" : "decimal"}
          spellCheck={text || secret ? false : undefined}
          autoComplete={text || secret ? "off" : undefined}
          // An empty box beside a slider (a setting that is not set) shows the number the handle is at.
          placeholder={slider !== undefined && value === "" ? sliderText(slider.value) : undefined}
          value={typed.shown}
          aria-invalid={problem !== undefined ? true : undefined}
          aria-describedby={describedBy(
            problem !== undefined ? hintId : undefined,
            hint !== undefined ? explainId : undefined,
          )}
          onChange={(event) => onChange(typed.type(event.target.value))}
          onBlur={typed.leave}
        />
      </label>
      {hint !== undefined && (
        <p id={explainId} className="settings-hint settings-explain">
          {hint}
        </p>
      )}
      {slider !== undefined && (
        <Slider
          {...slider}
          onChange={(chosen) => {
            typed.leave();
            onChange(sliderText(chosen));
          }}
        />
      )}
      {extra}
      {problem !== undefined && (
        <span id={hintId} className="settings-hint" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

export interface PathBoxProps extends Omit<
  NumberBoxProps,
  "text" | "wide" | "secret" | "slider" | "extra"
> {
  /** What the chooser lists: files of any kind, or folders. */
  kind: PathKind;
  /** The chooser of the system (the Rust side only; the tests answer a fake one). */
  backend: Pick<Backend, "pickPath">;
  /** What a path the chooser gave does (a choice, so it is not text on its way); `onChange` by default. */
  onPick?(path: string): void;
}

/**
 * A path: a box that takes it typed by hand and, under it, a button that opens the chooser of the
 * system for a file or a folder and puts what was chosen in the box (where it is checked like any
 * other text). Closing the chooser without a choice changes nothing; a chooser that cannot be opened
 * says why under the row.
 */
export function PathBox({ kind, backend, onChange, onPick, ...box }: PathBoxProps) {
  const t = useT();
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string>();
  const choose = () => {
    setOpening(true);
    setFailure(undefined);
    backend
      .pickPath({
        kind,
        title: t(kind === "file" ? "settings.pathPickFileTitle" : "settings.pathPickFolderTitle"),
      })
      .then(
        (chosen) => {
          setOpening(false);
          if (chosen !== null) (onPick ?? onChange)(chosen);
        },
        (error: unknown) => {
          setOpening(false);
          setFailure(
            t("settings.pathPickFailed", {
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
        },
      );
  };
  return (
    <NumberBox
      {...box}
      text
      wide
      onChange={onChange}
      extra={
        <>
          <button
            type="button"
            className="settings-link settings-path-choose"
            data-nr-part="path-choose"
            disabled={opening}
            aria-label={t(
              kind === "file" ? "settings.pathChooseFile" : "settings.pathChooseFolder",
              {
                name: box.label,
              },
            )}
            onClick={choose}
          >
            {t("settings.pathChoose")}
          </button>
          {failure !== undefined && (
            <p className="settings-hint settings-path-failure" role="alert">
              {failure}
            </p>
          )}
        </>
      }
    />
  );
}

export interface SelectBoxProps {
  label: string;
  field?: string;
  hint?: string;
  value: string;
  options: readonly { value: string; label: string }[];
  problem: string | undefined;
  onChange(value: string): void;
}

/** A drop-down list with its label; a problem is told under it, where the choice is made. */
export function SelectBox({
  label,
  field,
  hint,
  value,
  options,
  problem,
  onChange,
}: SelectBoxProps) {
  const hintId = useId();
  const explainId = useId();
  const selectId = useId();
  return (
    <div className="settings-number">
      <div className="settings-option">
        <label htmlFor={selectId} title={describe(field)}>
          {label}
        </label>
        <select
          id={selectId}
          title={describe(field)}
          value={value}
          aria-invalid={problem !== undefined ? true : undefined}
          aria-describedby={describedBy(
            problem !== undefined ? hintId : undefined,
            hint !== undefined ? explainId : undefined,
          )}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {hint !== undefined && (
        <p id={explainId} className="settings-hint settings-explain">
          {hint}
        </p>
      )}
      {problem !== undefined && (
        <span id={hintId} className="settings-hint" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

export interface ChoiceProps<T extends string> {
  /** The name of the group: what the choice is about. */
  legend: string;
  /** The path of the field in the schema, whose description is the tooltip of the group. */
  field?: string;
  hint?: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  /**
   * What draws it: a row of buttons with the chosen one marked (two or three short options), or a
   * drop-down list (four or more, or long ones). `CHOICE_CONTROLS` says which for each choice.
   */
  control: "segmented" | "list";
  onChange(value: T): void;
}

/**
 * One choice among several, with its name and explanation on the left and its control on the right:
 * a row of radio buttons drawn as buttons with the chosen one marked (`segmented`: everything in
 * view, one click chooses) or a drop-down list (`list`). The row is a group named by its label, as a
 * fieldset is by its legend; a fieldset cannot be laid out beside its legend, which the grid of the
 * screen needs.
 */
export function Choice<T extends string>({
  legend,
  field,
  hint,
  name,
  value,
  options,
  control,
  onChange,
}: ChoiceProps<T>) {
  const labelId = useId();
  const explainId = useId();
  if (control === "list") {
    return (
      <SelectBox
        label={legend}
        {...(field !== undefined ? { field } : {})}
        {...(hint !== undefined ? { hint } : {})}
        value={value}
        options={options}
        problem={undefined}
        onChange={(chosen) => onChange(chosen as T)}
      />
    );
  }
  return (
    <div
      className="settings-choice"
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hint !== undefined ? explainId : undefined}
      title={describe(field)}
    >
      <div className="settings-choice-head">
        <span id={labelId} className="settings-label">
          {legend}
        </span>
        {hint !== undefined && (
          <p id={explainId} className="settings-hint settings-explain">
            {hint}
          </p>
        )}
      </div>
      <div className="settings-choices settings-segmented">
        {options.map((option) => (
          <label key={option.value} className="settings-option">
            <input
              type="radio"
              name={name}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export interface ToggleProps {
  label: string;
  field?: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}

/**
 * A yes or no, as a switch: its label and explanation on the left and the switch on the right. It
 * is a native check box with the role of a switch, so a click and the Space key turn it, a screen
 * reader says "on" or "off", and the browser keeps its state; the style sheet draws the track and
 * the knob.
 */
export function Toggle({ label, field, hint, checked, disabled = false, onChange }: ToggleProps) {
  const explainId = useId();
  return (
    <div className="settings-toggle">
      <label className="settings-option" title={describe(field)}>
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint !== undefined ? explainId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint !== undefined && (
        <p id={explainId} className="settings-hint settings-explain">
          {hint}
        </p>
      )}
    </div>
  );
}

export interface TextAreaProps {
  label: string;
  field?: string;
  hint?: string;
  value: string;
  problem: string | undefined;
  onChange(text: string): void;
}

/** A box of several lines, such as the arguments of a program, one to a line. */
export function TextArea({ label, field, hint, value, problem, onChange }: TextAreaProps) {
  const hintId = useId();
  const explainId = useId();
  const typed = useTyped(value);
  return (
    <div className="settings-number settings-wide">
      <label className="settings-option" title={describe(field)}>
        <span>{label}</span>
        <textarea
          rows={2}
          spellCheck={false}
          autoComplete="off"
          value={typed.shown}
          aria-invalid={problem !== undefined ? true : undefined}
          aria-describedby={describedBy(
            problem !== undefined ? hintId : undefined,
            hint !== undefined ? explainId : undefined,
          )}
          onChange={(event) => onChange(typed.type(event.target.value))}
          onBlur={typed.leave}
        />
      </label>
      {hint !== undefined && (
        <p id={explainId} className="settings-hint settings-explain">
          {hint}
        </p>
      )}
      {problem !== undefined && (
        <span id={hintId} className="settings-hint" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

export interface ActionRowProps {
  /** The explanation on the left, in gray (what the buttons are for). */
  hint?: ReactNode;
  /** The buttons, one under the other in the control column. */
  children: ReactNode;
}

/** A row whose control is one or more buttons: the explanation on the left, the buttons on the right. */
export function ActionRow({ hint, children }: ActionRowProps) {
  return (
    <div className="settings-action">
      {hint !== undefined && <div className="settings-explain-text">{hint}</div>}
      <div className="settings-action-buttons">{children}</div>
    </div>
  );
}
