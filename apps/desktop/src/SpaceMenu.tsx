import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { Space } from "@noren/model";

/** Where the menu opens: the pointer, or the corner of the button that asked for it. */
export interface MenuPoint {
  x: number;
  y: number;
}

interface SpaceMenuProps {
  space: Space;
  /** Zero-based position of the space in the switcher and how many spaces there are. */
  index: number;
  count: number;
  point: MenuPoint;
  onEdit(): void;
  onMove(delta: -1 | 1): void;
  onDelete(): void;
  onClose(): void;
}

/** The actions of one space. It opens upward because the switcher sits at the foot of the sidebar. */
export function SpaceMenu({
  space,
  index,
  count,
  point,
  onEdit,
  onMove,
  onDelete,
  onClose,
}: SpaceMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (at + 1) % items.length;
    else if (event.key === "ArrowUp") next = (at <= 0 ? items.length : at) - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Tab") next = at;
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const item = (label: string, action: () => void, disabled = false) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={action}>
      {label}
    </button>
  );

  return (
    <div
      className="menu-backdrop"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        ref={menuRef}
        className="space-menu"
        role="menu"
        aria-label={`${space.name} options`}
        style={{ left: point.x, bottom: window.innerHeight - point.y }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
      >
        {item("Edit space…", onEdit)}
        {item("Move left", () => onMove(-1), index === 0)}
        {item("Move right", () => onMove(1), index === count - 1)}
        {count > 1 && item("Delete space…", onDelete)}
      </div>
    </div>
  );
}
