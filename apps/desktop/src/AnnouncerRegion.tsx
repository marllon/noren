import { useEffect, useSyncExternalStore } from "react";
import { ANNOUNCE_CLEAR_MS, announcer } from "./announcer";

/**
 * The one live region of the window, drawn once in the app shell. Two elements sit in it because a
 * live region has a single urgency: the polite one speaks when the screen reader is idle, the
 * assertive one cuts in and only ever holds an error. Neither is visible, and neither is a landmark
 * or has a role of its own, so the notice line (`role="status"`) stays the only status in the page.
 * What is put in them comes from `announcer.ts`; they are emptied a few seconds after the last
 * announcement so no stale sentence is left for a screen reader to read by hand.
 */
export function AnnouncerRegion() {
  const state = useSyncExternalStore(
    (listener) => announcer.subscribe(listener),
    () => announcer.state,
  );
  const { polite, assertive } = state;

  useEffect(() => {
    if (polite === "" && assertive === "") return;
    const timer = setTimeout(() => announcer.clear(), ANNOUNCE_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [polite, assertive]);

  return (
    <div className="sr-only" data-nr-part="announcer">
      <div aria-live="polite" aria-atomic="true" data-nr-part="announcer-polite">
        {polite}
      </div>
      <div aria-live="assertive" aria-atomic="true" data-nr-part="announcer-assertive">
        {assertive}
      </div>
    </div>
  );
}
