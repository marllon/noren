import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, widthAfterDrag, widthAfterKey } from "./layout";
import type { SidebarSide } from "./layout";

interface SidebarResizerProps {
  side: SidebarSide;
  width: number;
  onResize(width: number): void;
}

/**
 * The handle on the inner edge of the sidebar. Dragging it with the pointer or pressing the arrows
 * (Shift for a larger step, Home and End for the limits) changes the width of the sidebar.
 */
export function SidebarResizer({ side, width, onResize }: SidebarResizerProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    drag.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(widthAfterDrag(drag.current.startWidth, drag.current.startX, event.clientX, side));
  };

  const stop = () => {
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = widthAfterKey(width, event.key, side, event.shiftKey);
    if (next === undefined) return;
    event.preventDefault();
    onResize(next);
  };

  return (
    <div
      className="sidebar-resize"
      data-nr-part="sidebar-resize"
      data-nr-state={dragging ? "dragging" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
    />
  );
}
