import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { describeProfile } from "./profile-import";
import type { ProfileImportPlan } from "./profile-import";

interface ProfileImportDialogProps {
  plan: ProfileImportPlan;
  /** Adds the profiles to the file. Resolves to why it could not, or `undefined` when it did. */
  onImport(): Promise<string | undefined>;
  onCancel(): void;
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/**
 * Shows what importing a settings file would add, before anything is written: every profile with
 * its name and the command line that would start it, how many hidden ones the file had (they are
 * ignored) and what was left out and why. Nothing is written until the person presses Import; the
 * profiles are only added to the list, never started. Focus starts on Cancel; Esc cancels.
 */
export function ProfileImportDialog({ plan, onImport, onCancel }: ProfileImportDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const count = plan.profiles.length;
  const importLabel = `Import ${count} ${plural(count, "profile", "profiles")}`;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    const problem = await onImport();
    setBusy(false);
    if (problem !== undefined) setFailure(problem);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  return (
    <div className="dialog-backdrop">
      <div
        className="space-dialog profile-import-dialog"
        data-nr-part="profile-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>Import profiles</h2>
        <p className="dialog-message">
          {`${count} ${plural(count, "profile", "profiles")} from "${plan.fileName}" will be added to config.jsonc. They are only added to the list: nothing is started or run.`}
        </p>
        <ul className="profile-import-list" aria-label="Profiles to import">
          {plan.profiles.map((profile) => {
            const { name, command } = describeProfile(profile);
            return (
              <li key={profile.id}>
                <span className="profile-import-name">{name}</span>
                <code className="profile-import-command">{command}</code>
              </li>
            );
          })}
        </ul>
        {plan.hidden > 0 && (
          <p className="settings-hint" data-nr-part="profile-import-hidden">
            {plan.hidden} hidden {plural(plan.hidden, "profile", "profiles")} in the file{" "}
            {plural(plan.hidden, "was", "were")} ignored.
          </p>
        )}
        {plan.skipped.length > 0 && (
          <p className="settings-hint" data-nr-part="profile-import-skipped">
            Left out:{" "}
            {plan.skipped.map((skipped) => `${skipped.name} (${skipped.reason})`).join("; ")}.
          </p>
        )}
        {plan.warnings.length > 0 && (
          <p className="settings-hint" data-nr-part="profile-import-warnings">
            {plan.warnings.join("; ")}.
          </p>
        )}
        {failure !== undefined && (
          <p role="alert" className="settings-warning" data-nr-part="profile-import-failure">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>
            {importLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
