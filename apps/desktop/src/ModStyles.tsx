import { X } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { modWarnings } from "@noren/model";
import type { ModPlan } from "@noren/model";
import { syncModStyles } from "./mod-styles";
import { useModPlan } from "./use-mods";

/**
 * Applies the mods in force to the document, before paint, and says what it left out. It draws
 * nothing while every mod that is on is in use.
 */
export function ModStyles() {
  const plan = useModPlan();
  useLayoutEffect(() => {
    syncModStyles(document.head, plan.applied);
  }, [plan.applied]);
  return <ModsNotice plan={plan} />;
}

/**
 * The notice of a mod that is on but cannot be used: its file is not in the mods folder (it was
 * deleted or renamed) or the CSS would leave its layer. The mod is ignored and the rest still
 * apply; the notice floats over the content, never blocks it, and closing it hides these
 * sentences until they change.
 */
function ModsNotice({ plan }: { plan: ModPlan }) {
  const warnings = modWarnings(plan);
  const key = warnings.join("\n");
  const [dismissed, setDismissed] = useState("");
  if (warnings.length === 0 || dismissed === key) return null;
  return (
    <div className="config-notice mods-notice" role="status" data-nr-part="mods-notice">
      <div className="config-notice-text">
        {warnings.map((warning) => (
          <span key={warning} data-nr-part="mods-notice-line">
            {warning}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="config-notice-close"
        aria-label="Dismiss"
        onClick={() => setDismissed(key)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
