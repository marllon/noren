import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import {
  NUMBER_RANGES,
  ansiField,
  contrastRatio,
  fieldText,
  renameTheme,
  themeContrastWarnings,
  typeIntoField,
} from "@noren/model";
import type {
  AnsiIndex,
  Backend,
  ContrastCheck,
  FieldProblem,
  NumberField,
  Theme,
  ThemeField,
} from "@noren/model";
import { BackgroundPicker } from "./BackgroundPicker";
import { useBackgroundThumbnail } from "./background-thumbnail";
import { useT } from "./i18n";
import { useInterfaceStyle } from "./layout-store";
import { NumberBox, Toggle } from "./SettingsFields";
import { ThemePreview } from "./ThemePreview";
import { themeChanges } from "./theme-changes";
import { nameProblem } from "./themes-section";
import type { SaveMode } from "./themes-section";

interface ThemeEditorDialogProps {
  /** The theme the editor starts from: its colors, font, corners and picture are the ones it opens with. */
  source: Theme;
  /** Whether `source` is one of the person's own themes, which can then be saved over (`changes`). */
  own: boolean;
  backend: Pick<Backend, "pickBackgroundImage" | "readBackgroundImage">;
  /**
   * Saves `theme` under `name`. Answers the sentence that says why it was refused (the dialog stays
   * open and says it), or `undefined` when it was saved (the one that opened the dialog closes it).
   */
  onSave(theme: Theme, name: string, mode: SaveMode): Promise<string | undefined>;
  onCancel(): void;
}

/** The theme being edited, the text typed in each box that differs from it, and what is wrong with a box. */
interface EditState {
  /** Valid at every moment: the preview draws it and Save writes it. */
  theme: Theme;
  /** The text of a box while the person is typing in it (a half-typed value is not the theme's value). */
  typed: Partial<Record<ThemeField, string>>;
  problems: Partial<Record<ThemeField, FieldProblem>>;
}

/** `record` without the box `field`. */
function without<T>(
  record: Partial<Record<ThemeField, T>>,
  field: ThemeField,
): Partial<Record<ThemeField, T>> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== field));
}

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/**
 * The theme editor: every group of a theme has its boxes (a color is a swatch that opens the color
 * picker and a box for the hex value, a number is a box with a slider, the picture is chosen with the
 * file chooser of the system), and the preview beside them is drawn from the theme being edited, so
 * it follows every change at once. Nothing is written while the person edits: the preview is the only
 * thing that changes, and Save (the one that opened the dialog does the writing) is the only thing
 * that ends in a file. A box with a value that is not valid says why under itself, keeps the theme
 * as it was and holds Save back. It is drawn by the themes section, a part of the settings screen,
 * so it takes Escape itself (the screen would otherwise close under it); Escape and Cancel throw the
 * changes away. The colors of the dialog are the ones of the theme in force, never those of the
 * theme being edited, so a color that cannot be read cannot make the editor unreadable.
 *
 * Under the glass style (the default) it is a card of glass like the settings screen: a header with
 * the title, the name of the theme and the buttons (Cancel, Save), the preview with the reading of the
 * contrast of the text on the left, and the boxes of the groups in a column on the right. Under the
 * dense style it is a page of the window under its title bar: a header with the title, the name of the
 * theme as a crumb (and a mark while there is something unsaved) and the buttons, the preview on the
 * left with the readings of the contrast and the sixteen colors of the palette under it as a table, the
 * boxes of the groups in a column on the right (the name is the first of them) and a strip at the foot
 * with how many changes are unsaved. The parts and what each box does are the same in both styles.
 */
export function ThemeEditorDialog({
  source,
  own,
  backend,
  onSave,
  onCancel,
}: ThemeEditorDialogProps) {
  const t = useT();
  const glass = useInterfaceStyle() === "glass";
  const dense = !glass;
  const titleId = useId();
  const nameId = useId();
  const nameProblemId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<EditState>({ theme: source, typed: {}, problems: {} });
  // The name the editor opens with: the theme's own, or "<name> copy" for one that ships with the app.
  const [startName] = useState(() =>
    own ? source.name : t("themes.copyName", { name: source.name }),
  );
  const [name, setName] = useState(startName);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const { theme } = state;
  const picture = useBackgroundThumbnail(backend, theme.background.image ?? "");

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const change = (field: ThemeField, text: string) => {
    setFailure(undefined);
    setState((previous) => {
      const result = typeIntoField(previous.theme, field, text);
      const problems = without(previous.problems, field);
      if (result.problem !== undefined) problems[field] = result.problem;
      return { theme: result.theme, typed: { ...previous.typed, [field]: text }, problems };
    });
  };

  /** The box is left: a value that was valid shows as the theme has it again (`#f80` as `#ff8800`). */
  const settle = (field: ThemeField) =>
    setState((previous) => {
      if (previous.problems[field] !== undefined || !(field in previous.typed)) return previous;
      return { ...previous, typed: without(previous.typed, field) };
    });

  const setKind = (kind: Theme["kind"]) =>
    setState((previous) => ({ ...previous, theme: { ...previous.theme, kind } }));
  const setLigatures = (ligatures: boolean) =>
    setState((previous) => ({
      ...previous,
      theme: { ...previous.theme, font: { ...previous.theme.font, ligatures } },
    }));

  const textOf = (field: ThemeField): string => state.typed[field] ?? fieldText(theme, field);

  const problemText = (field: ThemeField): string | undefined => {
    const problem = state.problems[field];
    if (problem === undefined) return undefined;
    switch (problem.kind) {
      case "color":
        return t(problem.alpha ? "themeEditor.problem.colorAlpha" : "themeEditor.problem.color");
      case "number":
        return t("themeEditor.problem.number");
      case "range":
        return t("themeEditor.problem.range", { min: problem.min, max: problem.max });
      case "empty":
        return t("themeEditor.problem.empty");
      case "picture":
        return problem.reason;
    }
  };

  const named = renameTheme(theme, name);
  const nameError = named.ok ? undefined : nameProblem(name, named.errors);
  const hasProblems = Object.keys(state.problems).length > 0;
  const blocked = hasProblems || nameError !== undefined || saving;

  const save = async (mode: SaveMode) => {
    if (blocked) return;
    setSaving(true);
    setFailure(undefined);
    const refused = await onSave(theme, name, mode);
    setSaving(false);
    if (refused !== undefined) setFailure(refused);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  const number = (field: NumberField, label: string) => {
    const range = NUMBER_RANGES[field];
    const value = Number(fieldText(theme, field));
    return (
      <div data-nr-field={field}>
        <NumberBox
          label={label}
          value={textOf(field)}
          problem={problemText(field)}
          slider={{
            label: t("themeEditor.slider", { name: label }),
            min: range.min,
            max: range.max,
            step: range.step,
            value: Number.isFinite(value) ? value : range.min,
          }}
          onChange={(text) => change(field, text)}
        />
      </div>
    );
  };

  const colorBox = (field: ThemeField, label: string, accessibleName = label) => (
    <ColorBox
      field={field}
      label={label}
      accessibleName={accessibleName}
      text={textOf(field)}
      swatch={fieldText(theme, field)}
      problem={problemText(field)}
      onChange={(text) => change(field, text)}
      onSettle={() => settle(field)}
    />
  );

  const warnings = themeContrastWarnings(theme);
  const ansiName = (index: AnsiIndex): string => t(`themeEditor.ansi.${index}`);
  const saveLabel = own ? t("themeEditor.saveChanges") : t("themeEditor.saveNew");

  const nameInput = (
    <input
      id={nameId}
      ref={nameRef}
      type="text"
      value={name}
      spellCheck={false}
      autoComplete="off"
      aria-invalid={nameError !== undefined ? true : undefined}
      aria-describedby={nameError !== undefined ? nameProblemId : undefined}
      onChange={(event) => {
        setName(event.target.value);
        setFailure(undefined);
      }}
    />
  );
  const nameProblemLine = nameError !== undefined && (
    <span id={nameProblemId} className="settings-hint" role="alert">
      {nameError}
    </span>
  );
  const hint = <p className="settings-hint theme-editor-hint">{t("themeEditor.hint")}</p>;
  // The readings of the contrast of the text (and, under the dense style, of the muted text) on the background, kept to one decimal.
  const mark = (low: boolean) =>
    low ? <TriangleAlert size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />;
  const textLow = warnings.some((warning) => warning.check === "text");
  const contrast = (
    <span
      className="theme-editor-contrast"
      data-nr-part="theme-editor-contrast"
      data-nr-state={textLow ? "low" : "ok"}
    >
      {mark(textLow)}
      {t("themeEditor.contrast", { ratio: contrastRatio(theme.ui.text, theme.ui.bg).toFixed(1) })}
    </span>
  );
  // The dense editor reads the muted text too, as the design does (the editor warns about it below 3:1).
  const mutedLow = warnings.some((warning) => warning.check === "muted");
  const contrastMuted = (
    <span
      className="theme-editor-contrast"
      data-nr-part="theme-editor-contrast-muted"
      data-nr-state={mutedLow ? "low" : "ok"}
    >
      {mark(mutedLow)}
      {t("themeEditor.contrastMuted", {
        ratio: contrastRatio(theme.ui.muted, theme.ui.bg).toFixed(1),
      })}
    </span>
  );
  const changes = themeChanges(source, theme, name, startName);

  /** The sixteen colors: the glass editor keeps them in the group of the terminal, the dense one lays them out as a table under the preview. */
  const palette = (
    <div className="theme-palette" data-nr-part="theme-palette">
      <span className="theme-palette-title">{t("themeEditor.palette")}</span>
      <span className="theme-palette-head">{t("themeEditor.normal")}</span>
      <span className="theme-palette-head">{t("themeEditor.bright")}</span>
      {ANSI_NAMES.map((base, row) => {
        const normal = row as AnsiIndex;
        const bright = (row + 8) as AnsiIndex;
        return (
          <div
            key={base}
            className="theme-palette-row"
            style={{ "--ansi-at": row + 1 } as CSSProperties}
          >
            <span className="theme-palette-name">{ansiName(normal)}</span>
            {colorBox(ansiField(normal), "", ansiName(normal))}
            {colorBox(ansiField(bright), "", ansiName(bright))}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="dialog-backdrop">
      <div
        className="space-dialog theme-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-nr-part="theme-editor"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>
          {t("themeEditor.title")}
          {dense && (
            <span
              className="theme-editor-crumb"
              aria-hidden="true"
              data-nr-part="theme-editor-crumb"
            >
              <span className="theme-editor-crumb-sep">/</span>
              <span className="theme-editor-crumb-name">{name.trim() === "" ? "…" : name}</span>
              {changes > 0 && (
                <span className="theme-editor-crumb-unsaved">{t("themeEditor.unsaved")}</span>
              )}
            </span>
          )}
        </h2>
        {glass && (
          <div className="theme-editor-name" data-nr-field="name">
            <div className="theme-editor-name-box">
              <label htmlFor={nameId}>{t("themeEditor.name")}</label>
              {nameInput}
            </div>
            {nameProblemLine}
          </div>
        )}
        <div className="theme-editor-body">
          <div className="theme-editor-controls">
            <fieldset className="settings-field theme-editor-group" data-nr-group="general">
              <legend>{t("themeEditor.general")}</legend>
              {!glass && (
                <div className="settings-number settings-wide" data-nr-field="name">
                  <label className="settings-option" htmlFor={nameId}>
                    <span>{t("themeEditor.name")}</span>
                  </label>
                  {nameInput}
                  {nameProblemLine}
                </div>
              )}
              <div
                className="theme-editor-kind"
                role="radiogroup"
                aria-label={t("themeEditor.kind")}
              >
                <span>{t("themeEditor.kind")}</span>
                <span className="theme-editor-kinds">
                  {(["dark", "light"] as const).map((kind) => (
                    <label key={kind} className="settings-option">
                      <input
                        type="radio"
                        name="theme-editor-kind"
                        checked={theme.kind === kind}
                        onChange={() => setKind(kind)}
                      />
                      <span>
                        {t(kind === "dark" ? "themeEditor.kindDark" : "themeEditor.kindLight")}
                      </span>
                    </label>
                  ))}
                </span>
              </div>
            </fieldset>

            <fieldset className="settings-field theme-editor-group" data-nr-group="accent">
              <legend>{t("themeEditor.accent")}</legend>
              {colorBox("ui.accent", t("themeEditor.accentColor"))}
            </fieldset>

            <fieldset className="settings-field theme-editor-group" data-nr-group="colors">
              <legend>{t("themeEditor.colors")}</legend>
              {colorBox("ui.bg", t("themeEditor.background"))}
              {colorBox("ui.text", t("themeEditor.text"))}
              {colorBox("ui.muted", t("themeEditor.muted"))}
              {colorBox("ui.border", t("themeEditor.border"))}
            </fieldset>

            <fieldset className="settings-field theme-editor-group" data-nr-group="sidebar">
              <legend>{t("themeEditor.sidebar")}</legend>
              {colorBox("ui.surface", t("themeEditor.surface"))}
            </fieldset>

            <fieldset className="settings-field theme-editor-group" data-nr-group="terminal">
              <legend>{t("themeEditor.terminal")}</legend>
              {colorBox("terminal.background", t("themeEditor.terminalBackground"))}
              {colorBox("terminal.foreground", t("themeEditor.terminalText"))}
              {colorBox("terminal.cursor", t("themeEditor.cursor"))}
              {colorBox("terminal.selection", t("themeEditor.selection"))}
              {glass && palette}
            </fieldset>

            <fieldset className="settings-field theme-editor-group" data-nr-group="font">
              <legend>{t("themeEditor.font")}</legend>
              <div data-nr-field="font.family">
                <NumberBox
                  label={t("themeEditor.fontNames")}
                  text
                  wide
                  value={textOf("font.family")}
                  problem={problemText("font.family")}
                  onChange={(text) => change("font.family", text)}
                />
              </div>
              {number("font.size", t("themeEditor.fontSize"))}
              {number("font.lineHeight", t("themeEditor.lineHeight"))}
              <Toggle
                label={t("themeEditor.ligatures")}
                checked={theme.font.ligatures}
                onChange={setLigatures}
              />
              <p className="settings-hint">{t("themeEditor.fontNote")}</p>
            </fieldset>

            <fieldset className="settings-field theme-editor-group" data-nr-group="corners">
              <legend>{t("themeEditor.corners")}</legend>
              {number("ui.radius", t("themeEditor.radius"))}
            </fieldset>

            <fieldset className="settings-field theme-editor-group" data-nr-group="transparency">
              <legend>{t("themeEditor.transparency")}</legend>
              {number("ui.opacity", t("themeEditor.panelOpacity"))}
              {number("ui.blur", t("themeEditor.panelBlur"))}
              <p className="settings-hint">{t("themeEditor.transparencyNote")}</p>
            </fieldset>

            <fieldset className="settings-field theme-editor-group" data-nr-group="picture">
              <legend>{t("themeEditor.picture")}</legend>
              <BackgroundPicker
                backend={backend}
                named
                path={textOf("background.image")}
                onChoose={(path) => change("background.image", path)}
                onRemove={() => change("background.image", "")}
              />
              <div data-nr-field="background.image">
                <NumberBox
                  label={t("themeEditor.picturePath")}
                  text
                  wide
                  value={textOf("background.image")}
                  problem={problemText("background.image")}
                  onChange={(text) => change("background.image", text)}
                />
              </div>
              {number("background.opacity", t("themeEditor.pictureOpacity"))}
              {number("background.blur", t("themeEditor.pictureBlur"))}
            </fieldset>
          </div>

          <div className="theme-editor-side">
            <div className="theme-editor-side-head">
              <h3>{t("themeEditor.preview")}</h3>
              {hint}
              {contrast}
              {dense && contrastMuted}
            </div>
            <ThemePreview theme={theme} picture={picture.status === "ready" ? picture.url : null} />
            {dense && palette}
            <div role="status" className="theme-editor-notes" data-nr-part="theme-editor-notes">
              {warnings.map((warning) => (
                <p key={warning.check} className="settings-hint" data-nr-note={warning.check}>
                  {t("themeEditor.low", {
                    what: t(lowKey(warning.check)),
                    ratio: Number(warning.ratio.toFixed(1)),
                    min: warning.minimum,
                  })}
                </p>
              ))}
            </div>
          </div>
        </div>
        {hasProblems && (
          <p className="settings-hint" data-nr-part="theme-editor-fix">
            {t("themeEditor.fixFirst")}
          </p>
        )}
        {failure !== undefined && (
          <p role="alert" className="settings-hint" data-nr-part="theme-editor-failure">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          {own && (
            <button
              type="button"
              data-nr-action="save-copy"
              disabled={blocked}
              onClick={() => void save("new")}
            >
              {t("themeEditor.saveCopy")}
            </button>
          )}
          <button
            type="button"
            className="primary"
            data-nr-action="save"
            disabled={blocked}
            onClick={() => void save(own ? "changes" : "new")}
          >
            {saveLabel}
          </button>
        </div>
        {dense && (
          <div
            className="theme-editor-footer"
            aria-hidden="true"
            data-nr-part="theme-editor-footer"
          >
            <span className="theme-editor-footer-label">{t("themeEditor.footerLabel")}</span>
            <span className="theme-editor-footer-name">{name.trim() === "" ? "…" : name}</span>
            <span
              className="theme-editor-footer-changes"
              data-nr-state={changes > 0 ? "unsaved" : "none"}
            >
              {changes === 0
                ? t("themeEditor.noChanges")
                : changes === 1
                  ? t("themeEditor.changes.one", { count: changes })
                  : t("themeEditor.changes.other", { count: changes })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

const lowKey = (check: ContrastCheck) => `themeEditor.lowWhat.${check}` as const;

interface ColorBoxProps {
  field: ThemeField;
  /** The text beside the boxes; empty where a row of a grid says it. */
  label: string;
  /** The name of the boxes for a screen reader. */
  accessibleName: string;
  /** What the box holds now (the text being typed, else the color of the theme). */
  text: string;
  /** The color of the theme, `#rrggbb` (and an alpha), for the swatch. */
  swatch: string;
  problem: string | undefined;
  onChange(text: string): void;
  onSettle(): void;
}

/** A color: a swatch that opens the color picker and a box for the hex value, which stay one value. */
function ColorBox({
  field,
  label,
  accessibleName,
  text,
  swatch,
  problem,
  onChange,
  onSettle,
}: ColorBoxProps) {
  const t = useT();
  const inputId = useId();
  const problemId = useId();
  return (
    <div className="theme-color" data-nr-field={field}>
      {label !== "" && (
        <label htmlFor={inputId} className="theme-color-label">
          {label}
        </label>
      )}
      <span className="theme-color-boxes">
        <input
          type="color"
          className="theme-swatch"
          aria-label={t("themeEditor.swatch", { name: accessibleName })}
          value={swatch.slice(0, 7)}
          onChange={(event) => onChange(event.target.value + swatch.slice(7))}
        />
        <input
          id={inputId}
          type="text"
          className="theme-hex"
          aria-label={label === "" ? accessibleName : undefined}
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problem !== undefined ? true : undefined}
          aria-describedby={problem !== undefined ? problemId : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onSettle}
        />
      </span>
      {problem !== undefined && (
        <span id={problemId} className="settings-hint theme-color-problem" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
