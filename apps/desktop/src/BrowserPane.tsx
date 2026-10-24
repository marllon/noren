import type { Pane } from "@noren/model";
import { useId, useLayoutEffect, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { addressProblemText, readAddress } from "./browser-address";
import { BrowserPaneView } from "./browser-view";
import type { BrowserViewBackend } from "./browser-view";
import { useT } from "./i18n";
import { useWindowCovered } from "./native-cover";
import { observeMove, observeSettle } from "./observe-move";

interface BrowserPaneProps {
  backend: BrowserViewBackend;
  pane: Pane;
  /**
   * True when the pane is where the person can see it: its tab and its space are on screen and no
   * other pane of the tab is zoomed over it. A dialog or a menu over the window is added here.
   */
  visible: boolean;
  /** The address bar was submitted with a page the pane may show. */
  onNavigate(url: string): void;
}

/** What the view of a pane is asked to show. */
interface Wish {
  url: string;
  show: boolean;
}

/**
 * Tells `view` where the area `host` is now and what it shows. An area with nothing in it (the pane
 * sits in a tab that is not on screen) is out of view too, whatever `show` says.
 */
function place(host: HTMLElement | null, view: BrowserPaneView | null, wish: Wish): void {
  if (host === null || view === null) return;
  const rect = host.getBoundingClientRect();
  const seen = wish.show && rect.width > 0 && rect.height > 0;
  view.want({
    url: wish.url,
    bounds: seen
      ? {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      : undefined,
  });
}

/**
 * A pane that shows a web page: an address bar, and under it the area the web view of the shell is
 * laid over. The page is not drawn by this component. The web view is opened when the pane first
 * shows, follows the area as it moves and resizes, steps out of view while the pane is not seen and
 * is closed when the pane goes away (`BrowserPaneView`).
 */
export function BrowserPane({ backend, pane, visible, onNavigate }: BrowserPaneProps) {
  const t = useT();
  const covered = useWindowCovered();
  const url = pane.url ?? "";
  const show = visible && !covered;

  // The text in the field is the person's until the pane goes to another page; then it is that page.
  const [draft, setDraft] = useState(url);
  const [seen, setSeen] = useState(url);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [openFailure, setOpenFailure] = useState<string | undefined>(undefined);
  if (seen !== url) {
    setSeen(url);
    setDraft(url);
    setProblem(undefined);
  }

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<BrowserPaneView | null>(null);
  const wishRef = useRef<Wish>({ url, show });
  const messageId = useId();

  // One view of the shell per pane, for as long as the pane is mounted. It is made before the
  // placement below runs, so the first render already puts it where the area is.
  useLayoutEffect(() => {
    const view = new BrowserPaneView(backend, pane.id, setOpenFailure);
    viewRef.current = view;
    place(hostRef.current, view, wishRef.current);
    return () => {
      viewRef.current = null;
      view.close();
    };
  }, [backend, pane.id]);

  // After every render: what this render wants, and where the area is now (a layout above the pane
  // may have moved it without changing its size). The view ignores a wish it already has.
  useLayoutEffect(() => {
    wishRef.current = { url, show };
    place(hostRef.current, viewRef.current, wishRef.current);
  });

  // The area also changes with no render here: a separator is dragged, the sidebar is resized, the
  // window is, and a panel beside it moves it without changing its size (`observeMove`).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const follow = () => place(hostRef.current, viewRef.current, wishRef.current);
    // A resize says the area changed: it may also have got or lost its area, which the watch for
    // a move needs to know.
    const mover = observeMove(host, follow);
    const observer = new ResizeObserver(() => {
      follow();
      mover.refresh();
    });
    observer.observe(host);
    // An animation above the pane (the space sliding in) ends where the watch for a move may not
    // notice it: the web view would stay a pixel off. Look again, and watch from the new place.
    const stopSettle = observeSettle(host, () => {
      follow();
      mover.refresh();
    });
    window.addEventListener("resize", follow);
    return () => {
      stopSettle();
      observer.disconnect();
      mover.stop();
      window.removeEventListener("resize", follow);
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const reading = readAddress(draft);
    if (!reading.ok) {
      setProblem(reading.problem);
      return;
    }
    setProblem(undefined);
    setDraft(reading.url);
    onNavigate(reading.url);
  };

  const message =
    problem !== undefined
      ? addressProblemText(problem)
      : openFailure !== undefined
        ? t("browser.openFailed", { reason: openFailure })
        : undefined;

  return (
    <div
      className="browser-pane"
      data-nr-part="browser-pane"
      role="group"
      aria-label={t("browser.pane")}
    >
      <form className="browser-bar" data-nr-part="browser-bar" onSubmit={submit} noValidate>
        <input
          type="text"
          className="browser-address"
          data-nr-part="browser-address"
          aria-label={t("browser.address")}
          aria-invalid={problem !== undefined}
          aria-describedby={message !== undefined ? messageId : undefined}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
      {message !== undefined && (
        <p className="browser-problem" id={messageId} role="alert" data-nr-part="browser-problem">
          {message}
        </p>
      )}
      <div
        ref={hostRef}
        className="browser-view"
        data-nr-part="browser-view"
        data-nr-state={show ? "shown" : "hidden"}
      />
    </div>
  );
}
