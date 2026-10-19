import { X } from "lucide-react";
import { useState } from "react";
import { describeConfigError } from "@noren/model";
import type { ConfigState } from "@noren/model";
import { useConfigState } from "./config-store";
import { useT } from "./i18n";

/**
 * The notice of a problem with `config.jsonc`: it names the first problem with its line and says
 * the last valid settings stay in use. It floats over the content and never blocks it. Closing it
 * hides it for this text of the file; a new text with problems shows it again.
 */
export function ConfigErrorNotice() {
  const t = useT();
  const state = useConfigState();
  const [dismissed, setDismissed] = useState<ConfigState | null>(null);
  const [first, ...others] = state.errors;
  if (first === undefined || dismissed === state) return null;
  return (
    <div className="config-notice" role="alert" data-nr-part="config-notice">
      <div className="config-notice-text">
        <strong>{t("configNotice.title")}</strong>
        <span data-nr-part="config-notice-error">
          {first.line !== undefined && "config.jsonc, "}
          {describeConfigError(first)}
        </span>
        {others.length > 0 && (
          <span className="config-notice-more">
            {others.length === 1
              ? t("configNotice.more.one")
              : t("configNotice.more.other", { count: others.length })}
          </span>
        )}
      </div>
      <button
        type="button"
        className="config-notice-close"
        aria-label={t("configNotice.dismiss")}
        onClick={() => setDismissed(state)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
