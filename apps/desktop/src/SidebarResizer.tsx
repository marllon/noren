import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useT } from "./i18n";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, widthAfterDrag, widthAfterKey } from "./layout";
import type { SidebarSide } from "./layout";

interface SidebarResizerProps {
  side: SidebarSide;
  width: number;
  /** The pointer moved the edge: show this width, without saving it yet. */
  onPreview(width: number): void;
  /** The move ended (the pointer was released, a key was pressed): save this width. */
  onCommit(width: number): void;
  /** The width cannot be saved now (the settings file has a problem): the handle does nothing. */
  disabled?: boolean;
}

/**
 * The handle on the inner edge of the sidebar. Dragging it with the pointer or pressing the arrows
 * (Shift for a larger step, Home and End for the limits) changes the width of the sidebar.
 */
export function SidebarResizer({
  side,
  width,
  onPreview,
  onCommit,
  disabled = false,
}: SidebarResizerProps) {
  const t = useT();
  const drag = useRef<{ startX: number; startWidth: number; last: number; moved: boolean } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    drag.current = { startX: event.clientX, startWidth: width, last: width, moved: false };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const started = drag.current;
    if (!started) return;
    started.moved = true;
    started.last = widthAfterDrag(started.startWidth, started.startX, event.clientX, side);
    onPreview(started.last);
  };

  const stop = () => {
    const ended = drag.current;
    drag.current = null;
    setDragging(false);
    // A press with no move has no width to save; a move that came back to where it began still
    // ends the preview, which saving the same width does.
    if (ended?.moved === true) onCommit(ended.last);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = widthAfterKey(width, event.key, side, event.shiftKey);
    if (next === undefined) return;
    event.preventDefault();
    onCommit(next);
  };

  return (
    <div
      className="sidebar-resize"
      data-nr-part="sidebar-resize"
      data-nr-state={dragging ? "dragging" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("window.resizeSidebar")}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      aria-disabled={disabled ? true : undefined}
      title={disabled ? t("window.resizeBlocked") : undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
    />
  );
}
