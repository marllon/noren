import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Space, SpaceBackground } from "@noren/model";
import { backgroundFormOf, planBackground } from "./space-background";
import type { BackgroundForm, BackgroundProblems } from "./space-background";

interface SpaceBackgroundDialogProps {
  space: Space;
  /** The person chose a picture. */
  onSubmit(background: SpaceBackground): void;
  /** The person took the picture of the space away, so it follows the settings and the theme. */
  onClear(): void;
  onCancel(): void;
}

/**
 * Collects the picture of a space: the file, how much of it shows and how blurred it is. The
 * picture is a file on this computer; the boxes are checked as the settings screen checks them, and
 * a problem is told under its box instead of being written.
 */
export function SpaceBackgroundDialog({
  space,
  onSubmit,
  onClear,
  onCancel,
}: SpaceBackgroundDialogProps) {
  const titleId = useId();
  const imageRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<BackgroundForm>(() => backgroundFormOf(space));
  const [problems, setProblems] = useState<BackgroundProblems>({});

  useEffect(() => {
    imageRef.current?.focus();
    imageRef.current?.select();
  }, []);

  const change = (patch: Partial<BackgroundForm>) => {
    setForm((now) => ({ ...now, ...patch }));
    setProblems({});
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const plan = planBackground(form);
    if ("problems" in plan) setProblems(plan.problems);
    else onSubmit(plan.background);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  const box = (
    key: keyof BackgroundForm,
    label: string,
    options: { ref?: typeof imageRef; text?: boolean } = {},
  ) => (
    <>
      <label className="field">
        <span>{label}</span>
        <input
          ref={options.ref}
          type="text"
          inputMode={options.text === true ? "text" : "decimal"}
          spellCheck={options.text === true ? false : undefined}
          autoComplete="off"
          value={form[key]}
          aria-invalid={problems[key] !== undefined ? true : undefined}
          onChange={(event) => change({ [key]: event.target.value })}
        />
      </label>
      {problems[key] !== undefined && (
        <span className="settings-hint" role="alert">
          {problems[key]}
        </span>
      )}
    </>
  );

  return (
    <div className="dialog-backdrop">
      <form
        className="space-dialog"
        data-nr-part="space-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>Background image</h2>
        <p className="settings-hint">
          A picture file on this computer for the space “{space.name}”: a full path, or a path
          inside the config folder (backgrounds/sky.jpg). Web addresses are not accepted. Empty
          opacity and blur take the ones of the settings or the theme.
        </p>
        {box("image", "Image file", { ref: imageRef, text: true })}
        {box("opacity", "Opacity (0 to 1)")}
        {box("blur", "Blur (px)")}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" disabled={space.background === undefined} onClick={onClear}>
            Remove image
          </button>
          <button type="submit" className="primary">
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}
