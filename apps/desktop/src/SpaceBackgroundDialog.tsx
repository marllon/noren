import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { MAX_BACKGROUND_BLUR } from "@noren/model";
import type { Backend, Space, SpaceBackground } from "@noren/model";
import { appearancePreview, setAppearancePreview } from "./appearance-preview";
import { BackgroundPicker } from "./BackgroundPicker";
import { useT } from "./i18n";
import { Slider, sliderText } from "./SettingsFields";
import type { SliderSpec } from "./SettingsFields";
import { parseBackgroundBlur, parseBackgroundOpacity } from "./settings-screen";
import {
  backgroundFormOf,
  planBackground,
  previewOfBackground,
  removalOf,
} from "./space-background";
import type { BackgroundForm, BackgroundProblems } from "./space-background";
import { useSettingsAppearance } from "./use-window";

interface SpaceBackgroundDialogProps {
  space: Space;
  /**
   * The space is the one on screen: the sliders show their effect in the window at once, before
   * Apply. A space that is not on screen has nothing to show it on.
   */
  active?: boolean;
  /** The file chooser of the system and the read of the picture, for the preview. */
  backend: Pick<Backend, "pickBackgroundImage" | "readBackgroundImage">;
  /** The person chose a picture. */
  onSubmit(background: SpaceBackground): void;
  /** The person took the picture of the space away, so it follows the settings and the theme. */
  onClear(): void;
  onCancel(): void;
}

/**
 * Collects the picture of a space: the file, how much of it shows and how blurred it is. The
 * picture is a file on this computer, chosen in the file chooser of the system (with a preview) or
 * typed as a path; the boxes are checked as the settings screen checks them, and a problem is told
 * under its box instead of being written.
 */
export function SpaceBackgroundDialog({
  space,
  active = false,
  backend,
  onSubmit,
  onClear,
  onCancel,
}: SpaceBackgroundDialogProps) {
  const t = useT();
  const titleId = useId();
  const imageRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<BackgroundForm>(() => backgroundFormOf(space));
  const [problems, setProblems] = useState<BackgroundProblems>({});
  // The numbers of the settings and the theme, which the sliders show while a box is empty.
  const inForce = useSettingsAppearance();

  // The sliders and the boxes next to them are tried out in the window at once, for the space on
  // screen; closing the dialog any way puts the window back as the space has it.
  const { opacity: opacityText, blur: blurText } = form;
  useEffect(() => {
    if (active) {
      setAppearancePreview(
        previewOfBackground({ opacity: opacityText, blur: blurText }, appearancePreview()),
      );
    }
  }, [active, opacityText, blurText]);
  useEffect(() => () => setAppearancePreview(undefined), []);

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

  // "Remove" takes away the picture the preview shows: the one the space has (the space goes back to
  // the settings and the theme, at once, like "Remove image"), or one that was only chosen here and
  // not applied yet (the box goes back to the picture of the space).
  const removeShown = () => {
    const removal = removalOf(space, form);
    if (removal.kind === "clear") onClear();
    else change({ image: removal.image });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  const opacity = parseBackgroundOpacity(form.opacity) ?? inForce.background.opacity;
  const blur = parseBackgroundBlur(form.blur) ?? inForce.background.blur;
  const sliders: Record<"opacity" | "blur", SliderSpec> = {
    opacity: {
      label: t("background.opacitySlider"),
      min: 0,
      max: 1,
      step: 0.01,
      value: opacity,
      valueText: `${Math.round(opacity * 100)}%`,
    },
    blur: {
      label: t("background.blurSlider"),
      min: 0,
      max: MAX_BACKGROUND_BLUR,
      step: 1,
      value: blur,
      valueText: `${blur} px`,
    },
  };

  const box = (
    key: keyof BackgroundForm,
    label: string,
    options: { ref?: typeof imageRef; text?: boolean; slider?: SliderSpec } = {},
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
      {options.slider !== undefined && (
        <Slider {...options.slider} onChange={(chosen) => change({ [key]: sliderText(chosen) })} />
      )}
      {problems[key] !== undefined && (
        <span className="settings-hint" role="alert">
          {problems[key]}
        </span>
      )}
    </>
  );

  return (
    <div className="dialog-backdrop">
      <div
        className="space-dialog"
        data-nr-part="space-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <form className="dialog-form" onSubmit={submit}>
          <h2 id={titleId}>{t("background.title")}</h2>
          <p className="settings-hint">{t("background.hint", { name: space.name })}</p>
          <BackgroundPicker
            backend={backend}
            path={form.image}
            onChoose={(image) => change({ image })}
            onRemove={removeShown}
          />
          {box("image", t("background.image"), { ref: imageRef, text: true })}
          {box("opacity", t("background.opacity"), { slider: sliders.opacity })}
          {box("blur", t("background.blur"), { slider: sliders.blur })}
          <div className="dialog-actions">
            <button type="button" onClick={onCancel}>
              {t("common.cancel")}
            </button>
            <button type="button" disabled={space.background === undefined} onClick={onClear}>
              {t("background.remove")}
            </button>
            <button type="submit" className="primary">
              {t("background.apply")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
