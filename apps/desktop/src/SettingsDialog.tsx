import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { describeConfigError } from "@noren/model";
import type { Backend } from "@noren/model";
import { useConfigState, configManager } from "./config-store";
import type { Preset } from "./keybindings";
import type { Density, SidebarSide, TabsPlacement } from "./layout";
import { commitProfileImport, readProfileFile, takenProfileIds } from "./profile-import";
import type { ProfileImportPlan } from "./profile-import";
import { ProfileImportDialog } from "./ProfileImportDialog";
import { useProfiles } from "./profiles-store";
import { importSchemeFile } from "./scheme-import";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { addUserThemes, getUserThemes } from "./user-themes-store";
import { compactAvailable, keepOpenAvailable, planSave, shownSettings } from "./settings-screen";
import type { SettingsDraft } from "./settings-screen";

interface ChoiceProps<T extends string> {
  legend: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}

function Choice<T extends string>({ legend, name, value, options, onChange }: ChoiceProps<T>) {
  return (
    <fieldset className="settings-field">
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
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}

function Toggle({ label, checked, disabled = false, onChange }: ToggleProps) {
  return (
    <label className="settings-option">
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

interface NumberBoxProps {
  label: string;
  value: string;
  problem: string | undefined;
  onChange(text: string): void;
}

function NumberBox({ label, value, problem, onChange }: NumberBoxProps) {
  const hintId = useId();
  return (
    <div className="settings-number">
      <label className="settings-option">
        <span>{label}</span>
        <input
          type="text"
          inputMode="decimal"
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

const SIDES: readonly { value: SidebarSide; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

const TAB_PLACEMENTS: readonly { value: TabsPlacement; label: string }[] = [
  { value: "sidebar", label: "In the sidebar" },
  { value: "top", label: "On top" },
];

const DENSITIES: readonly { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const KEY_PRESETS: readonly { value: Preset; label: string }[] = [
  { value: "safe", label: "Safe" },
  { value: "browser", label: "Browser" },
];

interface SettingsDialogProps {
  /** Where an imported color scheme is written (the themes folder). */
  backend: Pick<Backend, "saveUserTheme">;
  onClose(): void;
}

/**
 * The settings screen: appearance and layout, shortcuts, notifications and importing. What is
 * changed in the first three is a draft until Save, which writes only the settings that differ from
 * the ones in force into `config.jsonc` (its comments stay) and closes the screen; the interface
 * follows the file, so the change shows without a reload. A file with a problem of its own is not
 * edited: Save waits until it is fixed. Importing is not part of the draft (see the Import section).
 */
export function SettingsDialog({ backend, onClose }: SettingsDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const shortcutsButtonRef = useRef<HTMLButtonElement>(null);
  const { config, errors } = useConfigState();
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Importing is not part of the draft: it acts at once (a color scheme) or after its own
  // confirmation (the profiles), and tells what happened in the line under its buttons.
  const schemeInputRef = useRef<HTMLInputElement>(null);
  const profilesInputRef = useRef<HTMLInputElement>(null);
  const profilesButtonRef = useRef<HTMLButtonElement>(null);
  const profiles = useProfiles();
  const [importStatus, setImportStatus] = useState("");
  const [importPlan, setImportPlan] = useState<ProfileImportPlan>();

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, []);

  const shown = shownSettings(config, draft);
  const plan = planSave(config, draft);
  const [firstError] = errors;
  const canSave =
    !saving &&
    firstError === undefined &&
    plan.changes.length > 0 &&
    Object.keys(plan.problems).length === 0;
  const change = (patch: SettingsDraft) => setDraft((now) => ({ ...now, ...patch }));

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
          <h2 id={titleId}>Settings</h2>
          <form className="settings-form" onSubmit={onSubmit}>
            <div className="settings-sections">
              <section className="settings-section" aria-label="Appearance">
                <h3>Appearance</h3>
                <Choice
                  legend="Sidebar side"
                  name="settings-side"
                  value={shown.side}
                  options={SIDES}
                  onChange={(side) => change({ side })}
                />
                <NumberBox
                  label="Sidebar width (px)"
                  value={shown.width}
                  problem={plan.problems.width}
                  onChange={(width) => change({ width })}
                />
                <Choice
                  legend="Tab position"
                  name="settings-tabs"
                  value={shown.tabs}
                  options={TAB_PLACEMENTS}
                  onChange={(tabs) => change({ tabs })}
                />
                <Choice
                  legend="Density"
                  name="settings-density"
                  value={shown.density}
                  options={DENSITIES}
                  onChange={(density) => change({ density })}
                />
                {/* With top tabs the sidebar always hides (it holds the spaces and favorites). */}
                <Toggle
                  label="Compact mode"
                  checked={shown.compact}
                  disabled={!compactAvailable(shown)}
                  onChange={(compact) => change({ compact })}
                />
                <Toggle
                  label="Keep sidebar open"
                  checked={shown.keepOpen}
                  disabled={!keepOpenAvailable(shown)}
                  onChange={(keepOpen) => change({ keepOpen })}
                />
                <Toggle
                  label="Pane headers"
                  checked={shown.paneHeaders}
                  onChange={(paneHeaders) => change({ paneHeaders })}
                />
              </section>
              <section className="settings-section" aria-label="Shortcuts">
                <h3>Shortcuts</h3>
                <Choice
                  legend="Shortcut preset"
                  name="settings-preset"
                  value={shown.preset}
                  options={KEY_PRESETS}
                  onChange={(preset) => change({ preset })}
                />
                <button
                  ref={shortcutsButtonRef}
                  type="button"
                  className="settings-link"
                  onClick={() => setShortcutsOpen(true)}
                >
                  Keyboard shortcuts
                </button>
              </section>
              <section className="settings-section" aria-label="Notifications">
                <h3>Notifications</h3>
                <Toggle
                  label="System notifications"
                  checked={shown.notifications}
                  onChange={(notifications) => change({ notifications })}
                />
                <NumberBox
                  label="Long command limit (seconds)"
                  value={shown.longCommandSeconds}
                  problem={plan.problems.longCommandSeconds}
                  onChange={(longCommandSeconds) => change({ longCommandSeconds })}
                />
              </section>
              <section className="settings-section" aria-label="Import">
                <h3>Import</h3>
                <button
                  type="button"
                  className="settings-link"
                  onClick={() => schemeInputRef.current?.click()}
                >
                  Import color scheme...
                </button>
                <button
                  ref={profilesButtonRef}
                  type="button"
                  className="settings-link"
                  onClick={() => profilesInputRef.current?.click()}
                >
                  Import profiles...
                </button>
                <p role="status" className="settings-hint" data-nr-part="settings-import-status">
                  {importStatus}
                </p>
                <input
                  ref={schemeInputRef}
                  type="file"
                  hidden
                  tabIndex={-1}
                  aria-label="Color scheme file"
                  data-nr-part="settings-scheme-file"
                  onChange={onSchemeFile}
                />
                <input
                  ref={profilesInputRef}
                  type="file"
                  hidden
                  tabIndex={-1}
                  aria-label="Settings file with profiles"
                  data-nr-part="settings-profiles-file"
                  onChange={onProfilesFile}
                />
              </section>
            </div>
            <div className="settings-feedback">
              {firstError !== undefined && (
                <p role="alert" className="settings-warning" data-nr-part="settings-file-problem">
                  config.jsonc has a problem, so nothing can be saved until it is fixed.{" "}
                  {describeConfigError(firstError)}
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
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!canSave}>
                Save
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
