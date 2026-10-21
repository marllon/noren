import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import {
  AI_FUNCTIONS,
  BELL_STYLES,
  CURSOR_STYLES,
  LANGUAGES,
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
  WindowEffect,
} from "@noren/model";
import { useConfigState, configManager } from "./config-store";
import { LANGUAGE_NAMES, t, useT } from "./i18n";
import { effectName, fieldDescription } from "./i18n/names";
import { resolveBindings } from "./keybindings";
import type { Preset } from "./keybindings";
import { useKeybindings } from "./keybindings-store";
import type { Density, SidebarSide, TabsPlacement } from "./layout";
import { settingsModRows } from "./mod-options";
import { useModFiles } from "./mods-store";
import { commitProfileImport, readProfileFile, takenProfileIds } from "./profile-import";
import type { ProfileImportPlan } from "./profile-import";
import { ProfileImportDialog } from "./ProfileImportDialog";
import { BenchPanel } from "./BenchPanel";
import { GalleryPanel } from "./GalleryPanel";
import { ModelsPanel } from "./ModelsPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { useProfiles } from "./profiles-store";
import { QUICK_TOGGLE_ACTION, quickShortcutLine } from "./quick-shortcut";
import { useQuickShortcutStatus } from "./quick-shortcut-store";
import { importSchemeFile } from "./scheme-import";
import { NumberBox, SelectBox } from "./SettingsFields";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { addUserThemes, getUserThemes } from "./user-themes-store";
import {
  compactAvailable,
  hasProblems,
  keepOpenAvailable,
  planSave,
  shownSettings,
} from "./settings-screen";
import type { SettingsDraft } from "./settings-screen";
import { isSshRow, withNewProfile, withProfileEdited, withoutProfile } from "./settings-profiles";
import type { ProfileField, ProfileRow } from "./settings-profiles";
import { aiProviderIds, fontChoice } from "./settings-sections";
import type { AiTargetDraft } from "./settings-sections";
import { useWindowEffectReport, windowEffectNote } from "./window-effect-store";

/** The description of a field in the language in force, for the `title` of its control. */
const describe = (field: string | undefined): string | undefined =>
  field === undefined ? undefined : fieldDescription(field) || undefined;

interface ChoiceProps<T extends string> {
  legend: string;
  /** The path of the field in the schema, whose description is the tooltip of the group. */
  field?: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}

function Choice<T extends string>({
  legend,
  field,
  name,
  value,
  options,
  onChange,
}: ChoiceProps<T>) {
  return (
    <fieldset className="settings-field" title={describe(field)}>
      <legend>{legend}</legend>
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
    </fieldset>
  );
}

interface ToggleProps {
  label: string;
  field?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}

function Toggle({ label, field, checked, disabled = false, onChange }: ToggleProps) {
  return (
    <label className="settings-option" title={describe(field)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

interface TextAreaProps {
  label: string;
  field?: string;
  value: string;
  problem: string | undefined;
  onChange(text: string): void;
}

/** A box of several lines, such as the arguments of a program, one to a line. */
function TextArea({ label, field, value, problem, onChange }: TextAreaProps) {
  const hintId = useId();
  return (
    <div className="settings-number settings-wide">
      <label className="settings-option" title={describe(field)}>
        <span>{label}</span>
        <textarea
          rows={2}
          spellCheck={false}
          autoComplete="off"
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

interface SettingsDialogProps {
  /** Where an imported color scheme is written (the themes folder), and the gallery. */
  backend: Pick<
    Backend,
    | "saveUserTheme"
    | "listMonospaceFonts"
    | "ai"
    | "listBenchResults"
    | "readHardware"
    | "galleryIndex"
    | "galleryInstalled"
    | "galleryInstall"
    | "listUserThemes"
    | "listMods"
  >;
  /**
   * Puts text at the prompt of the focused terminal without Enter, for the install command of a
   * recommended model; false when there is no terminal.
   */
  onInsert(text: string): boolean;
  onClose(): void;
}

/**
 * The settings screen: appearance and layout, shortcuts, notifications and importing. What is
 * changed in the first three is a draft until Save, which writes only the settings that differ from
 * the ones in force into `config.jsonc` (its comments stay) and closes the screen; the interface
 * follows the file, so the change shows without a reload. A file with a problem of its own is not
 * edited: Save waits until it is fixed. Importing is not part of the draft (see the Import section).
 */
export function SettingsDialog({ backend, onInsert, onClose }: SettingsDialogProps) {
  const t = useT();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const shortcutsButtonRef = useRef<HTMLButtonElement>(null);
  const { config, errors } = useConfigState();
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
          <h2 id={titleId}>{t("settings.title")}</h2>
          <form className="settings-form" onSubmit={onSubmit}>
            <div className="settings-sections">
              <section className="settings-section" aria-label={t("settings.appearance")}>
                <h3>{t("settings.appearance")}</h3>
                <Choice
                  legend={t("settings.language")}
                  field="language"
                  name="settings-language"
                  value={shown.language}
                  options={languageOptions()}
                  onChange={(language) => change({ language })}
                />
                <p className="settings-hint">{t("settings.language.hint")}</p>
                <Choice
                  legend={t("settings.sidebarSide")}
                  field="appearance.sidebar.position"
                  name="settings-side"
                  value={shown.side}
                  options={sideOptions()}
                  onChange={(side) => change({ side })}
                />
                <NumberBox
                  label={t("settings.sidebarWidth")}
                  field="appearance.sidebar.width"
                  value={shown.width}
                  problem={plan.problems.width}
                  onChange={(width) => change({ width })}
                />
                <Choice
                  legend={t("settings.tabPosition")}
                  field="appearance.tabs"
                  name="settings-tabs"
                  value={shown.tabs}
                  options={tabPlacementOptions()}
                  onChange={(tabs) => change({ tabs })}
                />
                <Choice
                  legend={t("settings.density")}
                  field="appearance.density"
                  name="settings-density"
                  value={shown.density}
                  options={densityOptions()}
                  onChange={(density) => change({ density })}
                />
                {/* With top tabs the sidebar always hides (it holds the spaces and favorites). */}
                <Toggle
                  label={t("settings.compactMode")}
                  field="appearance.sidebar.compact"
                  checked={shown.compact}
                  disabled={!compactAvailable(shown)}
                  onChange={(compact) => change({ compact })}
                />
                <Toggle
                  label={t("settings.keepOpen")}
                  field="appearance.sidebar.keepOpen"
                  checked={shown.keepOpen}
                  disabled={!keepOpenAvailable(shown)}
                  onChange={(keepOpen) => change({ keepOpen })}
                />
                <Toggle
                  label={t("settings.paneHeaders")}
                  field="appearance.paneHeaders"
                  checked={shown.paneHeaders}
                  onChange={(paneHeaders) => change({ paneHeaders })}
                />
              </section>
              <section
                className="settings-section"
                aria-label={t("settings.window")}
                data-nr-part="settings-window"
              >
                <h3>{t("settings.window")}</h3>
                <Choice
                  legend={t("settings.windowEffect")}
                  field="appearance.window.effect"
                  name="settings-window-effect"
                  value={shown.windowEffect}
                  options={windowEffectOptions()}
                  onChange={(windowEffect) => change({ windowEffect })}
                />
                <p className="settings-hint">{t("settings.windowEffectHint")}</p>
                {effectNote !== "" && (
                  <p
                    role="status"
                    className="settings-hint"
                    data-nr-part="settings-window-effect-note"
                  >
                    {effectNote}
                  </p>
                )}
                <NumberBox
                  label={t("settings.windowOpacity")}
                  field="appearance.window.opacity"
                  value={shown.windowOpacity}
                  problem={plan.problems.windowOpacity}
                  onChange={(windowOpacity) => change({ windowOpacity })}
                />
                <p className="settings-hint">{t("settings.windowOpacityHint")}</p>
              </section>
              <section
                className="settings-section"
                aria-label={t("settings.background")}
                data-nr-part="settings-background"
              >
                <h3>{t("settings.background")}</h3>
                <NumberBox
                  label={t("settings.backgroundImage")}
                  field="appearance.background.image"
                  value={shown.backgroundImage}
                  problem={plan.problems.backgroundImage}
                  text
                  onChange={(backgroundImage) => change({ backgroundImage })}
                />
                <NumberBox
                  label={t("settings.backgroundOpacity")}
                  field="appearance.background.opacity"
                  value={shown.backgroundOpacity}
                  problem={plan.problems.backgroundOpacity}
                  onChange={(backgroundOpacity) => change({ backgroundOpacity })}
                />
                <NumberBox
                  label={t("settings.backgroundBlur")}
                  field="appearance.background.blur"
                  value={shown.backgroundBlur}
                  problem={plan.problems.backgroundBlur}
                  onChange={(backgroundBlur) => change({ backgroundBlur })}
                />
                <p className="settings-hint">{t("settings.backgroundHint")}</p>
              </section>
              <section
                className="settings-section"
                aria-label={t("settings.terminal")}
                data-nr-part="settings-terminal"
              >
                <h3>{t("settings.terminal")}</h3>
                <NumberBox
                  label={t("settings.fontList")}
                  field="terminal.font.family"
                  value={shown.terminal.fontFamily}
                  problem={plan.terminalProblems.fontFamily}
                  text
                  wide
                  onChange={(fontFamily) => changeTerminal({ fontFamily })}
                />
                {fonts.length > 0 && (
                  <label className="settings-option">
                    <span>{t("settings.installedFont")}</span>
                    <select
                      value=""
                      onChange={(event) => {
                        const name = event.target.value;
                        if (name !== "") changeTerminal({ fontFamily: fontChoice(name) });
                      }}
                    >
                      <option value="">{t("settings.chooseOne")}</option>
                      {fonts.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <NumberBox
                  label={t("settings.fontSize")}
                  field="terminal.font.size"
                  value={shown.terminal.fontSize}
                  problem={plan.terminalProblems.fontSize}
                  onChange={(fontSize) => changeTerminal({ fontSize })}
                />
                <NumberBox
                  label={t("settings.lineHeight")}
                  field="terminal.font.lineHeight"
                  value={shown.terminal.lineHeight}
                  problem={plan.terminalProblems.lineHeight}
                  onChange={(lineHeight) => changeTerminal({ lineHeight })}
                />
                <Toggle
                  label={t("settings.ligatures")}
                  field="terminal.font.ligatures"
                  checked={shown.terminal.ligatures}
                  onChange={(ligatures) => changeTerminal({ ligatures })}
                />
                <p className="settings-hint">{t("settings.ligaturesHint")}</p>
                <Choice
                  legend={t("settings.cursorShape")}
                  field="terminal.cursor.style"
                  name="settings-cursor"
                  value={shown.terminal.cursorStyle}
                  options={cursorOptions()}
                  onChange={(cursorStyle) => changeTerminal({ cursorStyle })}
                />
                <Toggle
                  label={t("settings.cursorBlinks")}
                  field="terminal.cursor.blink"
                  checked={shown.terminal.cursorBlink}
                  onChange={(cursorBlink) => changeTerminal({ cursorBlink })}
                />
                <NumberBox
                  label={t("settings.scrollback")}
                  field="terminal.scrollback"
                  value={shown.terminal.scrollback}
                  problem={plan.terminalProblems.scrollback}
                  onChange={(scrollback) => changeTerminal({ scrollback })}
                />
                <Choice
                  legend={t("settings.bell")}
                  field="terminal.bell"
                  name="settings-bell"
                  value={shown.terminal.bell}
                  options={bellOptions()}
                  onChange={(bell) => changeTerminal({ bell })}
                />
              </section>
              <section
                className="settings-section"
                aria-label={t("settings.profiles")}
                data-nr-part="settings-profiles"
              >
                <h3>{t("settings.profiles")}</h3>
                {shown.profiles.length === 0 ? (
                  <p className="settings-hint">{t("settings.profilesNone")}</p>
                ) : (
                  <ul className="settings-profiles">
                    {shown.profiles.map((row, index) => {
                      const problems = plan.profileProblems[row.key];
                      const heading = row.saved
                        ? (config.profiles?.find((profile) => profile.id === row.key)?.name ??
                          row.key)
                        : t("settings.profileNew", { n: index + 1 });
                      return (
                        <li key={row.key}>
                          <fieldset
                            className="settings-profile"
                            aria-label={heading}
                            data-nr-part="settings-profile"
                          >
                            <NumberBox
                              label={t("settings.profileName")}
                              field="profiles.item.name"
                              value={row.name}
                              problem={problems?.name}
                              text
                              wide
                              onChange={(name) => editProfile(row.key, { name })}
                            />
                            {isSshRow(row) && (
                              <>
                                <NumberBox
                                  label={t("settings.profileHost")}
                                  field="profiles.item.host"
                                  value={row.host ?? ""}
                                  problem={problems?.host}
                                  text
                                  wide
                                  onChange={(host) => editProfile(row.key, { host })}
                                />
                                <NumberBox
                                  label={t("settings.profileUser")}
                                  field="profiles.item.user"
                                  value={row.user ?? ""}
                                  problem={problems?.user}
                                  text
                                  wide
                                  onChange={(user) => editProfile(row.key, { user })}
                                />
                                <NumberBox
                                  label={t("settings.profilePort")}
                                  field="profiles.item.port"
                                  value={row.port ?? ""}
                                  problem={problems?.port}
                                  onChange={(port) => editProfile(row.key, { port })}
                                />
                                <NumberBox
                                  label={t("settings.profileIdentityFile")}
                                  field="profiles.item.identityFile"
                                  value={row.identityFile ?? ""}
                                  problem={problems?.identityFile}
                                  text
                                  wide
                                  onChange={(identityFile) =>
                                    editProfile(row.key, { identityFile })
                                  }
                                />
                                <NumberBox
                                  label={t("settings.profileKnownHostsFile")}
                                  field="profiles.item.knownHostsFile"
                                  value={row.knownHostsFile ?? ""}
                                  problem={problems?.knownHostsFile}
                                  text
                                  wide
                                  onChange={(knownHostsFile) =>
                                    editProfile(row.key, { knownHostsFile })
                                  }
                                />
                              </>
                            )}
                            <NumberBox
                              label={t(
                                isSshRow(row)
                                  ? "settings.profileRemoteProgram"
                                  : "settings.profileProgram",
                              )}
                              field="profiles.item.program"
                              value={row.program}
                              problem={problems?.program}
                              text
                              wide
                              onChange={(program) => editProfile(row.key, { program })}
                            />
                            <TextArea
                              label={t("settings.profileArgs")}
                              field="profiles.item.args"
                              value={row.args}
                              problem={problems?.args}
                              onChange={(args) => editProfile(row.key, { args })}
                            />
                            <NumberBox
                              label={t(
                                isSshRow(row) ? "settings.profileRemoteCwd" : "settings.profileCwd",
                              )}
                              field="profiles.item.cwd"
                              value={row.cwd}
                              problem={problems?.cwd}
                              text
                              wide
                              onChange={(cwd) => editProfile(row.key, { cwd })}
                            />
                            <button
                              type="button"
                              className="settings-link"
                              onClick={() =>
                                changeProfiles((rows) => withoutProfile(rows, row.key))
                              }
                            >
                              {t("settings.profileRemove")}
                            </button>
                          </fieldset>
                        </li>
                      );
                    })}
                  </ul>
                )}
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
                <p className="settings-hint">{t("settings.profilesHint")}</p>
                {shown.profiles.some(isSshRow) && (
                  <p className="settings-hint">{t("settings.profilesSshHint")}</p>
                )}
              </section>
              <section className="settings-section" aria-label={t("settings.shortcuts")}>
                <h3>{t("settings.shortcuts")}</h3>
                <Choice
                  legend={t("settings.preset")}
                  field="keybindings.preset"
                  name="settings-preset"
                  value={shown.preset}
                  options={keyPresetOptions()}
                  onChange={(preset) => change({ preset })}
                />
                <button
                  ref={shortcutsButtonRef}
                  type="button"
                  className="settings-link"
                  onClick={() => setShortcutsOpen(true)}
                >
                  {t("settings.keyboardShortcuts")}
                </button>
                <p className="settings-hint" data-nr-part="quick-shortcut">
                  {quickShortcutLine(quickChord, quickStatus)}
                </p>
              </section>
              <section className="settings-section" aria-label={t("settings.notifications")}>
                <h3>{t("settings.notifications")}</h3>
                <Toggle
                  label={t("settings.systemNotifications")}
                  field="notifications.enabled"
                  checked={shown.notifications}
                  onChange={(notifications) => change({ notifications })}
                />
                <NumberBox
                  label={t("settings.longCommand")}
                  field="notifications.longCommandSeconds"
                  value={shown.longCommandSeconds}
                  problem={plan.problems.longCommandSeconds}
                  onChange={(longCommandSeconds) => change({ longCommandSeconds })}
                />
              </section>
              <section
                className="settings-section"
                aria-label={t("settings.archive")}
                data-nr-part="settings-archive"
              >
                <h3>{t("settings.archive")}</h3>
                <Toggle
                  label={t("settings.archiveIdle")}
                  field="archive.enabled"
                  checked={shown.archive.enabled}
                  onChange={(enabled) => changeArchive({ enabled })}
                />
                <NumberBox
                  label={t("settings.archiveAfter")}
                  field="archive.afterHours"
                  value={shown.archive.afterHours}
                  problem={plan.archiveProblems.afterHours}
                  onChange={(afterHours) => changeArchive({ afterHours })}
                />
                <p className="settings-hint">{t("settings.archiveHint")}</p>
              </section>
              <section
                className="settings-section"
                aria-label={t("settings.ai")}
                data-nr-part="settings-ai"
              >
                <h3>{t("settings.ai")}</h3>
                <Toggle
                  label={t("settings.aiOn")}
                  field="ai.enabled"
                  checked={shown.ai.enabled}
                  onChange={(enabled) => changeAi({ enabled })}
                />
                <ProvidersPanel backend={backend} />
                <ModelsPanel backend={backend} onInsert={onInsert} />
                <BenchPanel backend={backend} />
                <h4>{t("settings.aiDefaults")}</h4>
                {AI_FUNCTIONS.map((fn) => {
                  const problem = plan.aiProblems[fn];
                  return (
                    <fieldset
                      key={fn}
                      className="settings-field"
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
                        value={shown.ai[fn].model}
                        problem={problem?.field === "model" ? problem.message : undefined}
                        text
                        wide
                        onChange={(model) => changeAiTarget(fn, { model })}
                      />
                      <p className="settings-hint">{aiFunctionHint(fn)}</p>
                    </fieldset>
                  );
                })}
                <p className="settings-hint">{t("settings.aiFootnote")}</p>
              </section>
              <section
                className="settings-section"
                aria-label={t("settings.mods")}
                data-nr-part="settings-mods"
              >
                <h3>{t("settings.mods")}</h3>
                {modRows.length === 0 ? (
                  <p className="settings-hint">{t("settings.modsNone")}</p>
                ) : (
                  <>
                    <p className="settings-hint">{t("settings.modsHint")}</p>
                    <ul className="settings-mods">
                      {modRows.map((row, index) => (
                        <li key={row.name} className="settings-mod" data-nr-part="settings-mod">
                          <Toggle
                            label={row.name}
                            checked={row.on}
                            onChange={(on) => change({ mods: withMod(shown.mods, row.name, on) })}
                          />
                          {row.missing && (
                            <span className="settings-hint">{t("settings.modMissing")}</span>
                          )}
                          {row.on && (
                            <span className="settings-mod-move">
                              <button
                                type="button"
                                className="settings-link"
                                aria-label={t("settings.modEarlier", { name: row.name })}
                                disabled={index === 0}
                                onClick={() => change({ mods: movedMod(shown.mods, row.name, -1) })}
                              >
                                <ArrowUp size={12} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="settings-link"
                                aria-label={t("settings.modLater", { name: row.name })}
                                disabled={index === shown.mods.length - 1}
                                onClick={() => change({ mods: movedMod(shown.mods, row.name, 1) })}
                              >
                                <ArrowDown size={12} aria-hidden="true" />
                              </button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
              <section
                className="settings-section"
                aria-label={t("settings.gallery")}
                data-nr-part="settings-gallery"
              >
                <h3>{t("settings.gallery")}</h3>
                <GalleryPanel backend={backend} />
              </section>
              <section className="settings-section" aria-label={t("settings.import")}>
                <h3>{t("settings.import")}</h3>
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
                <p role="status" className="settings-hint" data-nr-part="settings-import-status">
                  {importStatus}
                </p>
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
              </section>
            </div>
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
