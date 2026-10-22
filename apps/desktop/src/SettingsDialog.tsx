import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode } from "react";
import {
  AI_FUNCTIONS,
  BELL_STYLES,
  CURSOR_STYLES,
  LANGUAGES,
  MAX_BACKGROUND_BLUR,
  MIN_WINDOW_OPACITY,
  RIGHT_CLICK_ACTIONS,
  WINDOW_EFFECTS,
  OLLAMA_PROVIDER_ID,
  describeConfigError,
  movedMod,
  withMod,
} from "@noren/model";
import type {
  AiFunction,
  Backend,
  BellStyle,
  CursorStyle,
  LanguageSetting,
  RightClickAction,
  WindowEffect,
} from "@noren/model";
import { useConfigState, configManager } from "./config-store";
import { LANGUAGE_NAMES, t, useT } from "./i18n";
import { effectName } from "./i18n/names";
import { resolveBindings } from "./keybindings";
import type { Preset } from "./keybindings";
import { useKeybindings } from "./keybindings-store";
import type { Density, SidebarSide, TabsPlacement } from "./layout";
import { settingsModRows } from "./mod-options";
import { useModFiles } from "./mods-store";
import { commitProfileImport, readProfileFile, takenProfileIds } from "./profile-import";
import type { ProfileImportPlan } from "./profile-import";
import { ProfileImportDialog } from "./ProfileImportDialog";
import { BackgroundPicker } from "./BackgroundPicker";
import { BenchPanel } from "./BenchPanel";
import { GalleryPanel } from "./GalleryPanel";
import { SyncPanel } from "./SyncPanel";
import { UpdatePanel } from "./UpdatePanel";
import type { UpdateController } from "./update-controller";
import type { SpaceSyncPort } from "./space-sync";
import { ModelsPanel } from "./ModelsPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { useProfiles } from "./profiles-store";
import { QUICK_TOGGLE_ACTION, quickShortcutLine } from "./quick-shortcut";
import { useQuickShortcutStatus } from "./quick-shortcut-store";
import { importSchemeFile } from "./scheme-import";
import { ActionRow, Choice, NumberBox, SelectBox, TextArea, Toggle } from "./SettingsFields";
import type { SliderSpec } from "./SettingsFields";
import { appearancePreview, setAppearancePreview } from "./appearance-preview";
import { useSettingsAppearance } from "./use-window";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { ThemesPanel } from "./ThemesPanel";
import type { ThemesSpace } from "./ThemesPanel";
import { addUserThemes, getUserThemes } from "./user-themes-store";
import {
  compactAvailable,
  hasProblems,
  keepOpenAvailable,
  parseBackgroundBlur,
  parseBackgroundOpacity,
  parseWindowOpacity,
  planSave,
  previewOf,
  shownSettings,
} from "./settings-screen";
import type { SettingsDraft } from "./settings-screen";
import {
  columnMove,
  currentSection,
  isSettingsSection,
  navPart,
  searchWords,
  sectionPart,
  visibleRows,
} from "./settings-nav";
import type { SettingsSection } from "./settings-nav";
import { isSshRow, withNewProfile, withProfileEdited, withoutProfile } from "./settings-profiles";
import type { ProfileField, ProfileRow } from "./settings-profiles";
import { aiProviderIds, fontChoice } from "./settings-sections";
import type { AiTargetDraft } from "./settings-sections";
import { useWindowEffectReport, windowEffectNote } from "./window-effect-store";

// The choices of the screen, made when it draws so they say the words of the language in force.
const sideOptions = (): readonly { value: SidebarSide; label: string }[] => [
  { value: "left", label: t("settings.left") },
  { value: "right", label: t("settings.right") },
];

const tabPlacementOptions = (): readonly { value: TabsPlacement; label: string }[] => [
  { value: "sidebar", label: t("settings.inSidebar") },
  { value: "top", label: t("settings.onTop") },
];

const densityOptions = (): readonly { value: Density; label: string }[] => [
  { value: "comfortable", label: t("settings.comfortable") },
  { value: "compact", label: t("settings.compact") },
];

/** The language names are their own, so each is found in its own words; "system" is ours to say. */
const languageOptions = (): readonly { value: LanguageSetting; label: string }[] => [
  { value: "system", label: t("settings.language.system") },
  ...LANGUAGES.map((value) => ({ value, label: LANGUAGE_NAMES[value] })),
];

const windowEffectOptions = (): readonly { value: WindowEffect; label: string }[] =>
  WINDOW_EFFECTS.map((value) => ({ value, label: effectName(value) }));

const cursorOptions = (): readonly { value: CursorStyle; label: string }[] =>
  CURSOR_STYLES.map((value) => ({ value, label: t(`settings.cursor.${value}`) }));

const bellOptions = (): readonly { value: BellStyle; label: string }[] =>
  BELL_STYLES.map((value) => ({ value, label: t(`settings.bell.${value}`) }));

const rightClickOptions = (): readonly { value: RightClickAction; label: string }[] =>
  RIGHT_CLICK_ACTIONS.map((value) => ({ value, label: t(`settings.rightClick.${value}`) }));

const aiFunctionLabel = (fn: AiFunction): string => t(`settings.ai.${fn}`);

const aiFunctionHint = (fn: AiFunction): string => t(`settings.aiHint.${fn}`);

/** The choices of a provider list: no provider, Ollama, and the providers of the file. */
function providerOptions(
  ids: readonly string[],
  current: string,
): readonly { value: string; label: string }[] {
  // A provider the file no longer lists stays on the list, so the box tells what is chosen.
  const listed = current === "" || ids.includes(current) ? ids : [...ids, current];
  return [
    { value: "", label: t("settings.aiNoProvider") },
    ...listed.map((id) => ({ value: id, label: id === OLLAMA_PROVIDER_ID ? "Ollama" : id })),
  ];
}

const keyPresetOptions = (): readonly { value: Preset; label: string }[] => [
  { value: "safe", label: t("settings.preset.safe") },
  { value: "browser", label: t("settings.preset.browser") },
];

/** An opacity as the percent a screen reader says: 0.55 is "55%". */
const percent = (opacity: number): string => `${Math.round(opacity * 100)}%`;

/**
 * Scrolls the content so that a section stands at its top, under the padding. False when the
 * section is not on screen at all (a search hid it), and then nothing is scrolled.
 */
function alignSection(content: HTMLElement, id: SettingsSection): boolean {
  const section = content.querySelector<HTMLElement>(`[data-nr-part="${sectionPart(id)}"]`);
  if (section === null || section.getClientRects().length === 0) return false;
  const padTop = Number.parseFloat(getComputedStyle(content).paddingTop) || 0;
  const top = section.getBoundingClientRect().top - content.getBoundingClientRect().top;
  content.scrollTop = Math.max(0, content.scrollTop + top - padTop);
  return true;
}

/** One row of a section: what the search looks at, and what is drawn. */
interface RowDef {
  key: string;
  /** The words of the row (its label, its explanation, the names of its choices) for the search. */
  texts: readonly string[];
  node: ReactNode;
  /** A note under the rows of the section, which has no line above it. */
  note: boolean;
}

/** One section of the screen: the title (also what the search compares first) and its rows. */
interface SectionDef {
  id: SettingsSection;
  title: string;
  /** The name of the region when it is not the title (Terminal is named "Terminal options"). */
  label?: string;
  rows: RowDef[];
}

/** A row of a section; the texts are the ones the row says (left out when it says none). */
const row = (
  key: string,
  texts: readonly (string | undefined)[],
  node: ReactNode,
  note = false,
): RowDef => ({
  key,
  texts: texts.filter((text): text is string => text !== undefined),
  node,
  note,
});

const labelsOf = (options: readonly { label: string }[]): string[] =>
  options.map((option) => option.label);

interface SettingsDialogProps {
  /** Where an imported color scheme is written (the themes folder), and the gallery. */
  backend: Pick<
    Backend,
    | "saveUserTheme"
    | "deleteUserTheme"
    | "exportUserTheme"
    | "listMonospaceFonts"
    | "pickBackgroundImage"
    | "readBackgroundImage"
    | "ai"
    | "listBenchResults"
    | "readHardware"
    | "galleryIndex"
    | "galleryInstalled"
    | "galleryInstall"
    | "syncStatus"
    | "syncConnect"
    | "syncPull"
    | "syncPush"
    | "syncGistStatus"
    | "syncGistSetToken"
    | "syncGistClearToken"
    | "syncGistConnect"
    | "syncGistPull"
    | "syncGistPush"
    | "syncSpaceFiles"
    | "syncReadSpaceFile"
    | "syncWriteSpaceFiles"
    | "syncLinkSpaceFiles"
    | "listUserThemes"
    | "listMods"
  >;
  /**
   * The spaces and profiles of the window, for the Sync section: a push writes every space as a
   * file and a pull makes spaces of the files that came in. Without it the sync carries no spaces.
   */
  spaceSync?: SpaceSyncPort | undefined;
  /** The update of the app (NOR-F20-02b); without it the screen has no Updates section. */
  updates?: UpdateController | undefined;
  /**
   * The active space, for the "only this space" choice of the themes section; without it the
   * section offers a theme for the whole app only.
   */
  space?: ThemesSpace | undefined;
  /** Gives the active space the theme `themeId`, or (null) takes its own theme away. */
  onSpaceTheme?: ((themeId: string | null) => void) | undefined;
  /**
   * Puts text at the prompt of the focused terminal without Enter, for the install command of a
   * recommended model; false when there is no terminal.
   */
  onInsert(text: string): boolean;
  onClose(): void;
}

/**
 * The settings screen (NOR-F20-10a): a search on top, the column of sections on the left and, on the
 * right, every section in one column of rows (label and explanation on the left, control on the
 * right, on a grid of 8 px). A click in the column scrolls the section to the top and the column
 * follows the scroll; the search keeps the sections and rows that have its words. Hidden rows stay
 * in the page, so what a panel was told or a box holds is not lost by a search.
 *
 * What is changed in the sections is a draft until Save, which writes only the settings that differ
 * from the ones in force into `config.jsonc` (its comments stay) and closes the screen; the interface
 * follows the file, so the change shows without a reload. A file with a problem of its own is not
 * edited: Save waits until it is fixed. Importing is not part of the draft (see the Import section).
 */
export function SettingsDialog({
  backend,
  spaceSync,
  updates,
  space,
  onSpaceTheme,
  onInsert,
  onClose,
}: SettingsDialogProps) {
  const t = useT();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shortcutsButtonRef = useRef<HTMLButtonElement>(null);
  const { config, errors } = useConfigState();
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SettingsSection>("appearance");
  const keybindings = useKeybindings();
  const quickChord = resolveBindings(keybindings).chords[QUICK_TOGGLE_ACTION];
  const quickStatus = useQuickShortcutStatus();
  // Importing is not part of the draft: it acts at once (a color scheme) or after its own
  // confirmation (the profiles), and tells what happened in the line under its buttons.
  const schemeInputRef = useRef<HTMLInputElement>(null);
  const profilesInputRef = useRef<HTMLInputElement>(null);
  const profilesButtonRef = useRef<HTMLButtonElement>(null);
  const profiles = useProfiles();
  // What the system did with the effect that is saved (not with the one in the draft).
  const effectNote = windowEffectNote(useWindowEffectReport());
  const [importStatus, setImportStatus] = useState("");
  const [importPlan, setImportPlan] = useState<ProfileImportPlan>();
  // The monospaced fonts this computer has, which the Terminal section offers for the font box.
  const [fonts, setFonts] = useState<readonly string[]>([]);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, []);

  useEffect(() => {
    let current = true;
    backend.listMonospaceFonts().then(
      (names) => {
        if (current) setFonts(names);
      },
      () => {
        // A computer whose fonts cannot be listed: the box still takes any list of names.
      },
    );
    return () => {
      current = false;
    };
  }, [backend]);

  const shown = shownSettings(config, draft);
  // The sliders (and the boxes next to them) show their effect in the window at once, as a preview:
  // Save keeps it, and closing the screen any other way puts the window back as the file has it.
  useEffect(() => {
    setAppearancePreview(previewOf(draft, appearancePreview()));
  }, [draft]);
  useEffect(() => () => setAppearancePreview(undefined), []);
  const inForce = useSettingsAppearance();
  const sliders: Record<"windowOpacity" | "backgroundOpacity" | "backgroundBlur", SliderSpec> = {
    windowOpacity: {
      label: t("settings.windowOpacitySlider"),
      min: MIN_WINDOW_OPACITY,
      max: 1,
      step: 0.01,
      value: parseWindowOpacity(shown.windowOpacity) ?? inForce.opacity,
      valueText: percent(parseWindowOpacity(shown.windowOpacity) ?? inForce.opacity),
    },
    backgroundOpacity: {
      label: t("settings.backgroundOpacitySlider"),
      min: 0,
      max: 1,
      step: 0.01,
      value: parseBackgroundOpacity(shown.backgroundOpacity) ?? inForce.background.opacity,
      valueText: percent(
        parseBackgroundOpacity(shown.backgroundOpacity) ?? inForce.background.opacity,
      ),
    },
    backgroundBlur: {
      label: t("settings.backgroundBlurSlider"),
      min: 0,
      max: MAX_BACKGROUND_BLUR,
      step: 1,
      value: parseBackgroundBlur(shown.backgroundBlur) ?? inForce.background.blur,
      valueText: `${parseBackgroundBlur(shown.backgroundBlur) ?? inForce.background.blur} px`,
    },
  };
  const modFiles = useModFiles();
  const modRows = settingsModRows(modFiles, shown.mods);
  const plan = planSave(config, draft, { takenProfileIds: takenProfileIds(config, profiles) });
  const [firstError] = errors;
  const canSave =
    !saving && firstError === undefined && plan.changes.length > 0 && !hasProblems(plan);
  const change = (patch: SettingsDraft) => setDraft((now) => ({ ...now, ...patch }));
  const changeTerminal = (patch: NonNullable<SettingsDraft["terminal"]>) =>
    setDraft((now) => ({ ...now, terminal: { ...now.terminal, ...patch } }));
  const changeArchive = (patch: NonNullable<SettingsDraft["archive"]>) =>
    setDraft((now) => ({ ...now, archive: { ...now.archive, ...patch } }));
  // The rows of the list are one draft: the first change takes the profiles of the file as they are.
  const changeAi = (patch: Pick<NonNullable<SettingsDraft["ai"]>, "enabled">) =>
    setDraft((now) => ({ ...now, ai: { ...now.ai, ...patch } }));
  const changeAiTarget = (fn: AiFunction, patch: AiTargetDraft) =>
    setDraft((now) => ({ ...now, ai: { ...now.ai, [fn]: { ...now.ai?.[fn], ...patch } } }));
  const changeProfiles = (next: (rows: readonly ProfileRow[]) => readonly ProfileRow[]) =>
    setDraft((now) => ({ ...now, profiles: next(now.profiles ?? shown.profiles) }));
  const editProfile = (key: string, patch: Partial<Record<ProfileField, string>>) =>
    changeProfiles((rows) => withProfileEdited(rows, key, patch));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setFailure(undefined);
    const result = await configManager.update(plan.changes);
    setSaving(false);
    if (result.ok) onClose();
    else setFailure(result.message);
  };

  // The same flow as "Import color scheme..." in the command palette: the importers read the file
  // by what is in it, so the input takes any file.
  const onSchemeFile = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    setImportStatus("");
    void importSchemeFile(file, {
      backend,
      existing: getUserThemes(),
      added: addUserThemes,
    }).then(setImportStatus);
    // So picking the same file again (after fixing it) is a change the input reports.
    input.value = "";
  };

  // Reading a settings file only shows what it would add; the profiles are written when the person
  // confirms, and nothing is started either way.
  const onProfilesFile = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    setImportStatus("");
    void readProfileFile(file, takenProfileIds(config, profiles)).then((read) => {
      if (read.ok) setImportPlan(read.plan);
      else setImportStatus(read.message);
    });
    input.value = "";
  };

  const confirmProfileImport = async (): Promise<string | undefined> => {
    if (importPlan === undefined) return undefined;
    const result = await commitProfileImport(importPlan, configManager);
    if (!result.ok) return result.message;
    setImportPlan(undefined);
    setImportStatus(result.message);
    profilesButtonRef.current?.focus();
    return undefined;
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  // Escape in the search first empties it; the next one closes the screen like anywhere else.
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    } else if (event.key === "Enter") {
      event.preventDefault();
    }
  };

  const sectionOptions = {
    side: sideOptions(),
    tabs: tabPlacementOptions(),
    density: densityOptions(),
    language: languageOptions(),
    effect: windowEffectOptions(),
    cursor: cursorOptions(),
    bell: bellOptions(),
    rightClick: rightClickOptions(),
    preset: keyPresetOptions(),
  };

  const sections: SectionDef[] = [
    {
      id: "appearance",
      title: t("settings.appearance"),
      rows: [
        row(
          "language",
          [
            t("settings.language"),
            t("settings.language.hint"),
            ...labelsOf(sectionOptions.language),
          ],
          <Choice
            legend={t("settings.language")}
            field="language"
            hint={t("settings.language.hint")}
            name="settings-language"
            value={shown.language}
            options={sectionOptions.language}
            onChange={(language) => change({ language })}
          />,
        ),
        row(
          "side",
          [t("settings.sidebarSide"), ...labelsOf(sectionOptions.side)],
          <Choice
            legend={t("settings.sidebarSide")}
            field="appearance.sidebar.position"
            name="settings-side"
            value={shown.side}
            options={sectionOptions.side}
            onChange={(side) => change({ side })}
          />,
        ),
        row(
          "width",
          [t("settings.sidebarWidth")],
          <NumberBox
            label={t("settings.sidebarWidth")}
            field="appearance.sidebar.width"
            value={shown.width}
            problem={plan.problems.width}
            onChange={(width) => change({ width })}
          />,
        ),
        row(
          "tabs",
          [t("settings.tabPosition"), ...labelsOf(sectionOptions.tabs)],
          <Choice
            legend={t("settings.tabPosition")}
            field="appearance.tabs"
            name="settings-tabs"
            value={shown.tabs}
            options={sectionOptions.tabs}
            onChange={(tabs) => change({ tabs })}
          />,
        ),
        row(
          "density",
          [t("settings.density"), ...labelsOf(sectionOptions.density)],
          <Choice
            legend={t("settings.density")}
            field="appearance.density"
            name="settings-density"
            value={shown.density}
            options={sectionOptions.density}
            onChange={(density) => change({ density })}
          />,
        ),
        // With top tabs the sidebar always hides (it holds the spaces and favorites).
        row(
          "compact",
          [t("settings.compactMode")],
          <Toggle
            label={t("settings.compactMode")}
            field="appearance.sidebar.compact"
            checked={shown.compact}
            disabled={!compactAvailable(shown)}
            onChange={(compact) => change({ compact })}
          />,
        ),
        row(
          "keepOpen",
          [t("settings.keepOpen")],
          <Toggle
            label={t("settings.keepOpen")}
            field="appearance.sidebar.keepOpen"
            checked={shown.keepOpen}
            disabled={!keepOpenAvailable(shown)}
            onChange={(keepOpen) => change({ keepOpen })}
          />,
        ),
        row(
          "paneHeaders",
          [t("settings.paneHeaders")],
          <Toggle
            label={t("settings.paneHeaders")}
            field="appearance.paneHeaders"
            checked={shown.paneHeaders}
            onChange={(paneHeaders) => change({ paneHeaders })}
          />,
        ),
      ],
    },
    {
      id: "themes",
      title: t("themes.title"),
      rows: [
        row(
          "themes",
          [
            t("themes.hint"),
            t("themes.scope"),
            t("themes.import"),
            t("themes.customize"),
            t("themes.duplicate"),
            t("themes.followSystem"),
          ],
          <ThemesPanel backend={backend} space={space} onSpaceTheme={onSpaceTheme} />,
        ),
      ],
    },
    {
      id: "window",
      title: t("settings.window"),
      rows: [
        row(
          "effect",
          [
            t("settings.windowEffect"),
            t("settings.windowEffectHint"),
            ...labelsOf(sectionOptions.effect),
          ],
          <>
            <Choice
              legend={t("settings.windowEffect")}
              field="appearance.window.effect"
              hint={t("settings.windowEffectHint")}
              name="settings-window-effect"
              value={shown.windowEffect}
              options={sectionOptions.effect}
              onChange={(windowEffect) => change({ windowEffect })}
            />
            {effectNote !== "" && (
              <p
                role="status"
                className="settings-hint settings-row-note"
                data-nr-part="settings-window-effect-note"
              >
                {effectNote}
              </p>
            )}
          </>,
        ),
        row(
          "opacity",
          [t("settings.windowOpacity"), t("settings.windowOpacityHint")],
          <NumberBox
            label={t("settings.windowOpacity")}
            field="appearance.window.opacity"
            hint={t("settings.windowOpacityHint")}
            value={shown.windowOpacity}
            problem={plan.problems.windowOpacity}
            slider={sliders.windowOpacity}
            onChange={(windowOpacity) => change({ windowOpacity })}
          />,
        ),
      ],
    },
    {
      id: "background",
      title: t("settings.background"),
      rows: [
        row(
          "image",
          [t("settings.backgroundImage"), t("background.choose"), t("background.removeChosen")],
          <>
            <NumberBox
              label={t("settings.backgroundImage")}
              field="appearance.background.image"
              value={shown.backgroundImage}
              problem={plan.problems.backgroundImage}
              text
              wide
              onChange={(backgroundImage) => change({ backgroundImage })}
            />
            <BackgroundPicker
              backend={backend}
              path={shown.backgroundImage}
              onChoose={(backgroundImage) => change({ backgroundImage })}
              onRemove={() => change({ backgroundImage: "" })}
            />
          </>,
        ),
        row(
          "opacity",
          [t("settings.backgroundOpacity")],
          <NumberBox
            label={t("settings.backgroundOpacity")}
            field="appearance.background.opacity"
            value={shown.backgroundOpacity}
            problem={plan.problems.backgroundOpacity}
            slider={sliders.backgroundOpacity}
            onChange={(backgroundOpacity) => change({ backgroundOpacity })}
          />,
        ),
        row(
          "blur",
          [t("settings.backgroundBlur")],
          <NumberBox
            label={t("settings.backgroundBlur")}
            field="appearance.background.blur"
            value={shown.backgroundBlur}
            problem={plan.problems.backgroundBlur}
            slider={sliders.backgroundBlur}
            onChange={(backgroundBlur) => change({ backgroundBlur })}
          />,
        ),
        row(
          "hint",
          [t("settings.backgroundHint")],
          <p className="settings-hint">{t("settings.backgroundHint")}</p>,
          true,
        ),
      ],
    },
    {
      id: "terminal",
      title: t("settings.terminal"),
      label: t("settings.terminalSection"),
      rows: [
        row(
          "fontList",
          [t("settings.fontList")],
          <NumberBox
            label={t("settings.fontList")}
            field="terminal.font.family"
            value={shown.terminal.fontFamily}
            problem={plan.terminalProblems.fontFamily}
            text
            wide
            onChange={(fontFamily) => changeTerminal({ fontFamily })}
          />,
        ),
        ...(fonts.length > 0
          ? [
              row(
                "installedFont",
                [t("settings.installedFont")],
                <SelectBox
                  label={t("settings.installedFont")}
                  value=""
                  options={[
                    { value: "", label: t("settings.chooseOne") },
                    ...fonts.map((name) => ({ value: name, label: name })),
                  ]}
                  problem={undefined}
                  onChange={(name) => {
                    if (name !== "") changeTerminal({ fontFamily: fontChoice(name) });
                  }}
                />,
              ),
            ]
          : []),
        row(
          "fontSize",
          [t("settings.fontSize")],
          <NumberBox
            label={t("settings.fontSize")}
            field="terminal.font.size"
            value={shown.terminal.fontSize}
            problem={plan.terminalProblems.fontSize}
            onChange={(fontSize) => changeTerminal({ fontSize })}
          />,
        ),
        row(
          "lineHeight",
          [t("settings.lineHeight")],
          <NumberBox
            label={t("settings.lineHeight")}
            field="terminal.font.lineHeight"
            value={shown.terminal.lineHeight}
            problem={plan.terminalProblems.lineHeight}
            onChange={(lineHeight) => changeTerminal({ lineHeight })}
          />,
        ),
        row(
          "ligatures",
          [t("settings.ligatures"), t("settings.ligaturesHint")],
          <Toggle
            label={t("settings.ligatures")}
            field="terminal.font.ligatures"
            hint={t("settings.ligaturesHint")}
            checked={shown.terminal.ligatures}
            onChange={(ligatures) => changeTerminal({ ligatures })}
          />,
        ),
        row(
          "cursorShape",
          [t("settings.cursorShape"), ...labelsOf(sectionOptions.cursor)],
          <Choice
            legend={t("settings.cursorShape")}
            field="terminal.cursor.style"
            name="settings-cursor"
            value={shown.terminal.cursorStyle}
            options={sectionOptions.cursor}
            onChange={(cursorStyle) => changeTerminal({ cursorStyle })}
          />,
        ),
        row(
          "cursorBlinks",
          [t("settings.cursorBlinks")],
          <Toggle
            label={t("settings.cursorBlinks")}
            field="terminal.cursor.blink"
            checked={shown.terminal.cursorBlink}
            onChange={(cursorBlink) => changeTerminal({ cursorBlink })}
          />,
        ),
        row(
          "scrollback",
          [t("settings.scrollback")],
          <NumberBox
            label={t("settings.scrollback")}
            field="terminal.scrollback"
            value={shown.terminal.scrollback}
            problem={plan.terminalProblems.scrollback}
            onChange={(scrollback) => changeTerminal({ scrollback })}
          />,
        ),
        row(
          "bell",
          [t("settings.bell"), ...labelsOf(sectionOptions.bell)],
          <Choice
            legend={t("settings.bell")}
            field="terminal.bell"
            name="settings-bell"
            value={shown.terminal.bell}
            options={sectionOptions.bell}
            onChange={(bell) => changeTerminal({ bell })}
          />,
        ),
        row(
          "rightClick",
          [t("settings.rightClick"), ...labelsOf(sectionOptions.rightClick)],
          <Choice
            legend={t("settings.rightClick")}
            field="terminal.rightClick"
            name="settings-right-click"
            value={shown.terminal.rightClick}
            options={sectionOptions.rightClick}
            onChange={(rightClick) => changeTerminal({ rightClick })}
          />,
        ),
        row(
          "maxPanes",
          [t("settings.maxPanes")],
          <NumberBox
            label={t("settings.maxPanes")}
            field="terminal.maxPanes"
            value={shown.terminal.maxPanes}
            problem={plan.terminalProblems.maxPanes}
            onChange={(maxPanes) => changeTerminal({ maxPanes })}
          />,
        ),
        row(
          "screenReader",
          [t("settings.screenReader"), t("settings.screenReaderHint")],
          <Toggle
            label={t("settings.screenReader")}
            field="terminal.screenReaderMode"
            hint={t("settings.screenReaderHint")}
            checked={shown.terminal.screenReaderMode}
            onChange={(screenReaderMode) => changeTerminal({ screenReaderMode })}
          />,
        ),
      ],
    },
    {
      id: "profiles",
      title: t("settings.profiles"),
      rows: [
        row(
          "list",
          [
            t("settings.profilesNone"),
            t("settings.profileName"),
            t("settings.profileProgram"),
            t("settings.profileArgs"),
            t("settings.profileCwd"),
            t("settings.profileHost"),
            t("settings.profileUser"),
            t("settings.profilePort"),
            t("settings.profileIdentityFile"),
            ...shown.profiles.map((profile) => profile.name),
          ],
          shown.profiles.length === 0 ? (
            <p className="settings-hint">{t("settings.profilesNone")}</p>
          ) : (
            <ul className="settings-profiles">
              {shown.profiles.map((profileRow, index) => {
                const problems = plan.profileProblems[profileRow.key];
                const heading = profileRow.saved
                  ? (config.profiles?.find((profile) => profile.id === profileRow.key)?.name ??
                    profileRow.key)
                  : t("settings.profileNew", { n: index + 1 });
                return (
                  <li key={profileRow.key}>
                    <fieldset
                      className="settings-profile"
                      aria-label={heading}
                      data-nr-part="settings-profile"
                    >
                      <NumberBox
                        label={t("settings.profileName")}
                        field="profiles.item.name"
                        value={profileRow.name}
                        problem={problems?.name}
                        text
                        wide
                        onChange={(name) => editProfile(profileRow.key, { name })}
                      />
                      {isSshRow(profileRow) && (
                        <>
                          <NumberBox
                            label={t("settings.profileHost")}
                            field="profiles.item.host"
                            value={profileRow.host ?? ""}
                            problem={problems?.host}
                            text
                            wide
                            onChange={(host) => editProfile(profileRow.key, { host })}
                          />
                          <NumberBox
                            label={t("settings.profileUser")}
                            field="profiles.item.user"
                            value={profileRow.user ?? ""}
                            problem={problems?.user}
                            text
                            wide
                            onChange={(user) => editProfile(profileRow.key, { user })}
                          />
                          <NumberBox
                            label={t("settings.profilePort")}
                            field="profiles.item.port"
                            value={profileRow.port ?? ""}
                            problem={problems?.port}
                            onChange={(port) => editProfile(profileRow.key, { port })}
                          />
                          <NumberBox
                            label={t("settings.profileIdentityFile")}
                            field="profiles.item.identityFile"
                            value={profileRow.identityFile ?? ""}
                            problem={problems?.identityFile}
                            text
                            wide
                            onChange={(identityFile) =>
                              editProfile(profileRow.key, { identityFile })
                            }
                          />
                          <NumberBox
                            label={t("settings.profileKnownHostsFile")}
                            field="profiles.item.knownHostsFile"
                            value={profileRow.knownHostsFile ?? ""}
                            problem={problems?.knownHostsFile}
                            text
                            wide
                            onChange={(knownHostsFile) =>
                              editProfile(profileRow.key, { knownHostsFile })
                            }
                          />
                        </>
                      )}
                      <NumberBox
                        label={t(
                          isSshRow(profileRow)
                            ? "settings.profileRemoteProgram"
                            : "settings.profileProgram",
                        )}
                        field="profiles.item.program"
                        value={profileRow.program}
                        problem={problems?.program}
                        text
                        wide
                        onChange={(program) => editProfile(profileRow.key, { program })}
                      />
                      <TextArea
                        label={t("settings.profileArgs")}
                        field="profiles.item.args"
                        value={profileRow.args}
                        problem={problems?.args}
                        onChange={(args) => editProfile(profileRow.key, { args })}
                      />
                      <NumberBox
                        label={t(
                          isSshRow(profileRow)
                            ? "settings.profileRemoteCwd"
                            : "settings.profileCwd",
                        )}
                        field="profiles.item.cwd"
                        value={profileRow.cwd}
                        problem={problems?.cwd}
                        text
                        wide
                        onChange={(cwd) => editProfile(profileRow.key, { cwd })}
                      />
                      <button
                        type="button"
                        className="settings-link"
                        onClick={() =>
                          changeProfiles((rows) => withoutProfile(rows, profileRow.key))
                        }
                      >
                        {t("settings.profileRemove")}
                      </button>
                    </fieldset>
                  </li>
                );
              })}
            </ul>
          ),
        ),
        row(
          "add",
          [t("settings.profileAdd"), t("settings.profileAddSsh"), t("settings.profilesHint")],
          <ActionRow
            hint={
              <>
                <p className="settings-hint">{t("settings.profilesHint")}</p>
                {shown.profiles.some(isSshRow) && (
                  <p className="settings-hint">{t("settings.profilesSshHint")}</p>
                )}
              </>
            }
          >
            <button
              type="button"
              className="settings-link"
              onClick={() => changeProfiles((rows) => withNewProfile(rows))}
            >
              {t("settings.profileAdd")}
            </button>
            <button
              type="button"
              className="settings-link"
              onClick={() => changeProfiles((rows) => withNewProfile(rows, "ssh"))}
            >
              {t("settings.profileAddSsh")}
            </button>
          </ActionRow>,
        ),
      ],
    },
    {
      id: "shortcuts",
      title: t("settings.shortcuts"),
      rows: [
        row(
          "preset",
          [t("settings.preset"), ...labelsOf(sectionOptions.preset)],
          <Choice
            legend={t("settings.preset")}
            field="keybindings.preset"
            name="settings-preset"
            value={shown.preset}
            options={sectionOptions.preset}
            onChange={(preset) => change({ preset })}
          />,
        ),
        row(
          "keys",
          [t("settings.keyboardShortcuts"), quickShortcutLine(quickChord, quickStatus)],
          <ActionRow
            hint={
              <p className="settings-hint" data-nr-part="quick-shortcut">
                {quickShortcutLine(quickChord, quickStatus)}
              </p>
            }
          >
            <button
              ref={shortcutsButtonRef}
              type="button"
              className="settings-link"
              onClick={() => setShortcutsOpen(true)}
            >
              {t("settings.keyboardShortcuts")}
            </button>
          </ActionRow>,
        ),
      ],
    },
    {
      id: "notifications",
      title: t("settings.notifications"),
      rows: [
        row(
          "enabled",
          [t("settings.systemNotifications")],
          <Toggle
            label={t("settings.systemNotifications")}
            field="notifications.enabled"
            checked={shown.notifications}
            onChange={(notifications) => change({ notifications })}
          />,
        ),
        row(
          "longCommand",
          [t("settings.longCommand")],
          <NumberBox
            label={t("settings.longCommand")}
            field="notifications.longCommandSeconds"
            value={shown.longCommandSeconds}
            problem={plan.problems.longCommandSeconds}
            onChange={(longCommandSeconds) => change({ longCommandSeconds })}
          />,
        ),
      ],
    },
    {
      id: "archive",
      title: t("settings.archive"),
      rows: [
        row(
          "enabled",
          [t("settings.archiveIdle")],
          <Toggle
            label={t("settings.archiveIdle")}
            field="archive.enabled"
            checked={shown.archive.enabled}
            onChange={(enabled) => changeArchive({ enabled })}
          />,
        ),
        row(
          "after",
          [t("settings.archiveAfter"), t("settings.archiveHint")],
          <NumberBox
            label={t("settings.archiveAfter")}
            field="archive.afterHours"
            hint={t("settings.archiveHint")}
            value={shown.archive.afterHours}
            problem={plan.archiveProblems.afterHours}
            onChange={(afterHours) => changeArchive({ afterHours })}
          />,
        ),
      ],
    },
    {
      id: "ai",
      title: t("settings.ai"),
      rows: [
        row(
          "on",
          [t("settings.aiOn")],
          <Toggle
            label={t("settings.aiOn")}
            field="ai.enabled"
            checked={shown.ai.enabled}
            onChange={(enabled) => changeAi({ enabled })}
          />,
        ),
        row(
          "providers",
          [t("providers.title"), t("providers.addGroup"), "Ollama"],
          <ProvidersPanel backend={backend} />,
        ),
        row(
          "models",
          [t("models.title"), t("models.install")],
          <ModelsPanel backend={backend} onInsert={onInsert} />,
        ),
        row("bench", [t("bench.title")], <BenchPanel backend={backend} />),
        row(
          "defaults",
          [
            t("settings.aiDefaults"),
            ...AI_FUNCTIONS.flatMap((fn) => [
              aiFunctionLabel(fn),
              aiFunctionHint(fn),
              t("settings.aiProvider", { function: aiFunctionLabel(fn) }),
              t("settings.aiModel", { function: aiFunctionLabel(fn) }),
            ]),
          ],
          <>
            <h4>{t("settings.aiDefaults")}</h4>
            {AI_FUNCTIONS.map((fn) => {
              const problem = plan.aiProblems[fn];
              return (
                <fieldset
                  key={fn}
                  className="settings-field settings-group"
                  data-nr-part="settings-ai-function"
                >
                  <legend>{aiFunctionLabel(fn)}</legend>
                  <SelectBox
                    label={t("settings.aiProvider", { function: aiFunctionLabel(fn) })}
                    field={`ai.defaults.${fn}.provider`}
                    value={shown.ai[fn].provider}
                    options={providerOptions(aiProviderIds(config), shown.ai[fn].provider)}
                    problem={problem?.field === "provider" ? problem.message : undefined}
                    onChange={(provider) => changeAiTarget(fn, { provider })}
                  />
                  <NumberBox
                    label={t("settings.aiModel", { function: aiFunctionLabel(fn) })}
                    field={`ai.defaults.${fn}.model`}
                    hint={aiFunctionHint(fn)}
                    value={shown.ai[fn].model}
                    problem={problem?.field === "model" ? problem.message : undefined}
                    text
                    wide
                    onChange={(model) => changeAiTarget(fn, { model })}
                  />
                </fieldset>
              );
            })}
          </>,
        ),
        row(
          "footnote",
          [t("settings.aiFootnote")],
          <p className="settings-hint">{t("settings.aiFootnote")}</p>,
          true,
        ),
      ],
    },
    {
      id: "mods",
      title: t("settings.mods"),
      rows: [
        row(
          "list",
          [
            modRows.length === 0 ? t("settings.modsNone") : t("settings.modsHint"),
            ...modRows.map((modRow) => modRow.name),
          ],
          modRows.length === 0 ? (
            <p className="settings-hint">{t("settings.modsNone")}</p>
          ) : (
            <>
              <p className="settings-hint">{t("settings.modsHint")}</p>
              <ul className="settings-mods">
                {modRows.map((modRow, index) => (
                  <li key={modRow.name} className="settings-mod" data-nr-part="settings-mod">
                    <Toggle
                      label={modRow.name}
                      checked={modRow.on}
                      onChange={(on) => change({ mods: withMod(shown.mods, modRow.name, on) })}
                    />
                    {modRow.missing && (
                      <span className="settings-hint">{t("settings.modMissing")}</span>
                    )}
                    {modRow.on && (
                      <span className="settings-mod-move">
                        <button
                          type="button"
                          className="settings-link"
                          aria-label={t("settings.modEarlier", { name: modRow.name })}
                          disabled={index === 0}
                          onClick={() => change({ mods: movedMod(shown.mods, modRow.name, -1) })}
                        >
                          <ArrowUp size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="settings-link"
                          aria-label={t("settings.modLater", { name: modRow.name })}
                          disabled={index === shown.mods.length - 1}
                          onClick={() => change({ mods: movedMod(shown.mods, modRow.name, 1) })}
                        >
                          <ArrowDown size={12} aria-hidden="true" />
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ),
        ),
      ],
    },
    {
      id: "gallery",
      title: t("settings.gallery"),
      rows: [
        row(
          "gallery",
          [t("settings.galleryHint"), t("settings.galleryInstall")],
          <GalleryPanel backend={backend} />,
        ),
      ],
    },
    {
      id: "sync",
      title: t("settings.sync"),
      rows: [
        row(
          "sync",
          [
            t("settings.syncMethod"),
            t("settings.syncMethod.git"),
            t("settings.syncMethod.gist"),
            t("settings.syncHint"),
            t("settings.syncRemote"),
            t("settings.syncConnect"),
            t("settings.syncPull"),
            t("settings.syncPush"),
            t("settings.syncPushOnClose"),
            t("settings.gistToken"),
            t("settings.gistId"),
          ],
          <SyncPanel backend={backend} spaces={spaceSync} />,
        ),
      ],
    },
    ...(updates !== undefined
      ? [
          {
            id: "updates" as const,
            title: t("settings.updates"),
            rows: [
              row(
                "updates",
                [t("update.hint"), t("update.check"), t("update.install")],
                <UpdatePanel controller={updates} />,
              ),
            ],
          },
        ]
      : []),
    {
      id: "import",
      title: t("settings.import"),
      rows: [
        row(
          "import",
          [t("settings.importScheme"), t("settings.importProfiles")],
          <>
            <ActionRow
              hint={
                <p role="status" className="settings-hint" data-nr-part="settings-import-status">
                  {importStatus}
                </p>
              }
            >
              <button
                type="button"
                className="settings-link"
                onClick={() => schemeInputRef.current?.click()}
              >
                {t("settings.importScheme")}
              </button>
              <button
                ref={profilesButtonRef}
                type="button"
                className="settings-link"
                onClick={() => profilesInputRef.current?.click()}
              >
                {t("settings.importProfiles")}
              </button>
            </ActionRow>
            <input
              ref={schemeInputRef}
              type="file"
              hidden
              tabIndex={-1}
              aria-label={t("window.schemeFile")}
              data-nr-part="settings-scheme-file"
              onChange={onSchemeFile}
            />
            <input
              ref={profilesInputRef}
              type="file"
              hidden
              tabIndex={-1}
              aria-label={t("settings.profilesFile")}
              data-nr-part="settings-profiles-file"
              onChange={onProfilesFile}
            />
          </>,
        ),
      ],
    },
  ];

  // What the search keeps: the rows that have its words, and the sections that keep any. The rest
  // stays in the page, hidden, so what it holds survives the search.
  const words = searchWords(query);
  const filtered = sections.map((section) => {
    const flags = visibleRows(
      words,
      section.title,
      section.rows.map((r) => r.texts),
    );
    return { section, flags, shown: flags.some(Boolean) };
  });
  const shownSections = filtered.filter((entry) => entry.shown);
  const shownIds = shownSections.map((entry) => entry.section.id);
  const nothingFound = words.length > 0 && shownSections.length === 0;

  // The column follows the scroll: the section at the top of the content is the current one.
  const shownKey = shownIds.join(",");
  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const update = () => {
      const visible = [
        ...content.querySelectorAll<HTMLElement>("section.settings-section:not([hidden])"),
      ];
      if (visible.length === 0) return;
      const padTop = Number.parseFloat(getComputedStyle(content).paddingTop) || 0;
      const origin = content.getBoundingClientRect().top - content.scrollTop;
      const tops = visible.map((section) => section.getBoundingClientRect().top - origin - padTop);
      const id = visible[currentSection(tops, content.scrollTop)]?.dataset["nrSection"];
      if (isSettingsSection(id)) setActive(id);
    };
    update();
    content.addEventListener("scroll", update, { passive: true });
    return () => content.removeEventListener("scroll", update);
  }, [shownKey]);

  // The section the person asked for stays at the top while the page settles (a panel that finishes
  // loading above it, like the gallery or the models, would push it down); the person's own scroll,
  // a key or a click in the content lets go of it.
  const pinned = useRef<SettingsSection | null>(null);
  useEffect(() => {
    const content = contentRef.current;
    const sectionsBox = content?.querySelector(".settings-sections");
    if (
      content === null ||
      content === undefined ||
      sectionsBox === null ||
      sectionsBox === undefined
    ) {
      return;
    }
    const keep = () => {
      if (pinned.current !== null && !alignSection(content, pinned.current)) pinned.current = null;
    };
    const release = () => {
      pinned.current = null;
    };
    const observer = new ResizeObserver(keep);
    observer.observe(sectionsBox);
    const letGo = ["wheel", "pointerdown", "keydown", "touchstart"];
    for (const type of letGo) content.addEventListener(type, release, { passive: true });
    return () => {
      observer.disconnect();
      for (const type of letGo) content.removeEventListener(type, release);
    };
  }, []);

  // A search starts at the top of what it kept, not where the content happened to be scrolled.
  useEffect(() => {
    pinned.current = null;
    if (contentRef.current !== null) contentRef.current.scrollTop = 0;
  }, [query]);

  // A click (or Enter) on a section of the column scrolls it to the top of the content and takes the
  // keyboard there, so the next Tab is the first control of the section and not one far above it.
  const goTo = (id: SettingsSection) => {
    const content = contentRef.current;
    if (content === null) return;
    pinned.current = alignSection(content, id) ? id : null;
    setActive(id);
    content
      .querySelector<HTMLElement>(`[data-nr-part="${sectionPart(id)}"] h3`)
      ?.focus({ preventScroll: true });
  };

  const onColumnKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const from = buttons.findIndex((button) => button === document.activeElement);
    const next = columnMove(Math.max(0, from), event.key, buttons.length);
    if (next === undefined) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  const activeShown = shownIds.includes(active) ? active : shownIds[0];

  return (
    <>
      <div className="dialog-backdrop">
        <div
          ref={dialogRef}
          className="space-dialog settings-dialog"
          data-nr-part="settings"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onKeyDown={onKeyDown}
        >
          <div className="settings-header">
            <h2 id={titleId}>{t("settings.title")}</h2>
            <input
              type="search"
              className="settings-search"
              data-nr-part="settings-search"
              aria-label={t("settings.search")}
              placeholder={t("settings.search")}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          <form className="settings-form" onSubmit={onSubmit}>
            <nav
              className="settings-nav"
              aria-label={t("settings.sections")}
              data-nr-part="settings-nav"
            >
              <ul onKeyDown={onColumnKeyDown}>
                {shownSections.map(({ section }) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      className="settings-nav-item"
                      data-nr-part={navPart(section.id)}
                      aria-current={section.id === activeShown ? "true" : undefined}
                      tabIndex={section.id === activeShown ? 0 : -1}
                      onClick={() => goTo(section.id)}
                    >
                      {section.title}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="settings-content" ref={contentRef} data-nr-part="settings-content">
              <div className="settings-sections">
                {filtered.map(({ section, flags, shown: sectionShown }) => (
                  <section
                    key={section.id}
                    className={
                      section.id === shownIds[shownIds.length - 1]
                        ? "settings-section settings-section-last"
                        : "settings-section"
                    }
                    aria-label={section.label ?? section.title}
                    data-nr-part={sectionPart(section.id)}
                    data-nr-section={section.id}
                    hidden={!sectionShown}
                  >
                    <h3 tabIndex={-1}>{section.title}</h3>
                    <div className="settings-rows">
                      {section.rows.map((rowDef, index) => (
                        <div
                          key={rowDef.key}
                          className={rowDef.note ? "settings-row settings-note" : "settings-row"}
                          data-nr-row={`${section.id}.${rowDef.key}`}
                          hidden={!flags[index]}
                        >
                          {rowDef.node}
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
              {nothingFound && (
                <p role="status" className="settings-hint" data-nr-part="settings-search-none">
                  {t("settings.searchNone", { query: query.trim() })}
                </p>
              )}
            </div>
            <div className="settings-footer">
              <div className="settings-feedback">
                {firstError !== undefined && (
                  <p role="alert" className="settings-warning" data-nr-part="settings-file-problem">
                    {t("settings.fileProblem")} {describeConfigError(firstError)}
                  </p>
                )}
                {failure !== undefined && (
                  <p role="alert" className="settings-warning" data-nr-part="settings-failure">
                    {failure}
                  </p>
                )}
              </div>
              <div className="dialog-actions">
                <button type="button" onClick={onClose}>
                  {t("common.cancel")}
                </button>
                <button type="submit" className="primary" disabled={!canSave}>
                  {t("common.save")}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
      {importPlan !== undefined && (
        <ProfileImportDialog
          plan={importPlan}
          onImport={confirmProfileImport}
          onCancel={() => {
            setImportPlan(undefined);
            profilesButtonRef.current?.focus();
          }}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsDialog
          onClose={() => {
            setShortcutsOpen(false);
            shortcutsButtonRef.current?.focus();
          }}
        />
      )}
    </>
  );
}
