import { useDndMonitor } from "@dnd-kit/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { Id } from "@noren/model";
import { useT } from "./i18n";
import { PeekController } from "./peek-controller";
import type { PeekTimers } from "./peek-controller";

// The peek of a tab: stop the pointer on a tab of the sidebar and a small popover shows the last
// lines of its terminal. It is a tooltip: it never takes the keyboard (nothing in it can be
// focused) and never catches the pointer, so it cannot cover what the pointer is about to click.

/** Space kept between the popover and the tab, and between the popover and the window edge, in px. */
const GAP = 8;

/** The widest popover, in px. */
const MAX_WIDTH = 520;

interface PeekRect {
  left: number;
  right: number;
  top: number;
}

interface PeekView {
  itemId: Id;
  lines: readonly string[];
  anchor: PeekRect;
}

export interface PeekOptions {
  /** The timer the wait runs on; the tests move it by hand. */
  timers?: PeekTimers;
  delayMs?: number;
}

/** What to spread on the button of a tab so the pointer resting on it opens its peek. */
export interface PeekAnchorProps {
  onMouseEnter(event: MouseEvent<HTMLElement>): void;
  onMouseMove(event: MouseEvent<HTMLElement>): void;
  onMouseLeave(): void;
  onMouseDown(): void;
}

export interface PeekHandle {
  /** The peek that is up, with the lines it shows; `null` when there is none. */
  view: PeekView | null;
  /** Spread on the button of the tab `itemId`. */
  anchorProps(itemId: Id): PeekAnchorProps;
  /** Closes the peek, and cancels the one that is due (the tab went away, or the user acted). */
  close(): void;
}

/** The id of the popover of a tab; the tab's button points to it with `aria-describedby` while it is up. */
export const peekId = (itemId: Id): string => `peek-${itemId}`;

/**
 * Drives the peek of the tabs of one tree. It must sit inside the drag and drop context of the
 * sidebar: a drag, begun or under way, closes the peek and holds back the next one. `load` gives
 * the lines of a tab (it may be slow, as reading a saved file is); the popover opens when they
 * arrive, if the pointer is still on the tab.
 */
export function usePeek(
  load: (itemId: Id) => Promise<readonly string[]> | readonly string[],
  options: PeekOptions = {},
): PeekHandle {
  const [view, setView] = useState<PeekView | null>(null);
  const anchors = useRef(new Map<Id, HTMLElement>());
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);

  const [controller] = useState(() => {
    const created: PeekController = new PeekController({
      ...(options.timers !== undefined ? { timers: options.timers } : {}),
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      onShow: (itemId) => {
        void Promise.resolve()
          .then(() => loader.current(itemId))
          .catch(() => [] as readonly string[])
          .then((lines) => {
            // The pointer moved on, or something closed the peek, while the lines were read.
            if (created.shown !== itemId) return;
            const element = anchors.current.get(itemId);
            if (element === undefined || !element.isConnected) {
              // The button is gone (the tab is being renamed): nothing to show, and the next try starts clean.
              created.close();
              return;
            }
            const { left, right, top } = element.getBoundingClientRect();
            setView({ itemId, lines, anchor: { left, right, top } });
          });
      },
      onHide: () => setView(null),
    });
    return created;
  });

  useDndMonitor({
    onDragStart: () => controller.dragStart(),
    onDragEnd: () => controller.dragEnd(),
    onDragCancel: () => controller.dragEnd(),
  });

  useEffect(() => () => controller.dispose(), [controller]);

  // Escape, losing the window and scrolling the list (which moves the tab) close the peek.
  const open = view !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") controller.close();
    };
    const close = () => controller.close();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, controller]);

  const remember = (itemId: Id, element: HTMLElement) => anchors.current.set(itemId, element);
  return {
    view,
    anchorProps: (itemId) => ({
      onMouseEnter: (event) => {
        remember(itemId, event.currentTarget);
        controller.enter(itemId);
      },
      onMouseMove: (event) => {
        remember(itemId, event.currentTarget);
        controller.move(itemId);
      },
      onMouseLeave: () => controller.leave(itemId),
      onMouseDown: () => controller.close(),
    }),
    close: () => controller.close(),
  };
}

/**
 * The popover: the lines as plain text (React writes them as text nodes, so nothing in them is
 * markup), next to the tab on the side that faces the terminal.
 */
export function PeekPopover({ view }: { view: PeekView }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(view.anchor.top);
  const toRight = view.anchor.left + view.anchor.right < window.innerWidth;

  // Once it has a height, it is kept inside the window.
  useLayoutEffect(() => {
    const height = ref.current?.getBoundingClientRect().height ?? 0;
    setTop(Math.max(GAP, Math.min(view.anchor.top, window.innerHeight - height - GAP)));
  }, [view]);

  const side = toRight
    ? { left: view.anchor.right + GAP, maxWidth: window.innerWidth - view.anchor.right - 2 * GAP }
    : {
        right: window.innerWidth - view.anchor.left + GAP,
        maxWidth: view.anchor.left - 2 * GAP,
      };
  return createPortal(
    <div
      ref={ref}
      id={peekId(view.itemId)}
      role="tooltip"
      className="peek"
      data-nr-part="peek"
      style={{ top, ...side, maxWidth: Math.min(MAX_WIDTH, Math.max(120, side.maxWidth)) }}
    >
      {view.lines.length === 0 ? (
        <p className="peek-empty" data-nr-part="peek-empty">
          {t("output.none")}
        </p>
      ) : (
        <ol className="peek-lines" data-nr-part="peek-lines">
          {view.lines.map((line, index) => (
            <li key={index} className="peek-line" data-nr-part="peek-line">
              {line}
            </li>
          ))}
        </ol>
      )}
    </div>,
    document.body,
  );
}
