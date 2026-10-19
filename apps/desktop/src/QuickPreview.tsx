import { useEffect, useMemo, useRef, useState } from "react";
import { backend } from "./boot";
import {
  QUICK_OPEN_EVENT,
  QUICK_SESSION_EVENT,
  quickPreviewEvents,
  sessionOfPayload,
} from "./quick";
import { QuickApp } from "./QuickApp";

/** What the e2e tests read and press on the preview panel (`window.__norenQuick`). */
export interface QuickPreviewHook {
  /** What the Rust side does to show the window: ask for a shell and show the panel. */
  show(): Promise<void>;
  /** Whether the panel is shown (Esc and a promotion hide it). */
  shown(): boolean;
  /** How many times the window was asked to hide. */
  hideRequests(): number;
  /** The sessions the panel opened a shell for, in order (`quick-session`). */
  sessions(): number[];
}

declare global {
  interface Window {
    __norenQuick?: QuickPreviewHook;
  }
}

/**
 * The quick window drawn as a panel in a browser (`?quick-preview`), on the same backend and the same
 * events as the app next to it, as the two windows share the sessions and the events in the real app.
 * "Hiding" it only marks the panel, so a test can see the window was asked to hide.
 */
export function QuickPreview() {
  const [shown, setShown] = useState(false);
  const [hides, setHides] = useState(0);
  const hide = useMemo(
    () => async () => {
      setShown(false);
      setHides((count) => count + 1);
    },
    [],
  );
  // What the hook reads is what React rendered last.
  const opened = useRef<number[]>([]);
  const rendered = useRef({ shown, hides });
  rendered.current = { shown, hides };
  useEffect(() => {
    window.__norenQuick = {
      show: async () => {
        setShown(true);
        await quickPreviewEvents.emit(QUICK_OPEN_EVENT);
      },
      shown: () => rendered.current.shown,
      hideRequests: () => rendered.current.hides,
      sessions: () => [...opened.current],
    };
    const listening = quickPreviewEvents.listen(QUICK_SESSION_EVENT, (payload) => {
      const id = sessionOfPayload(payload);
      if (id !== undefined) opened.current.push(id);
    });
    return () => {
      delete window.__norenQuick;
      void listening.then((stop) => stop());
    };
  }, []);
  return (
    <section
      className="quick-preview"
      aria-label="Quick window preview"
      data-nr-part="quick-preview"
      data-nr-shown={shown ? "true" : "false"}
    >
      <QuickApp backend={backend} events={quickPreviewEvents} hide={hide} />
    </section>
  );
}
