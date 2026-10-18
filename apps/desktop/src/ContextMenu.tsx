import { useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { MenuPoint } from "./SpaceMenu";

/** The pointer position of a context-menu event; the key (Menu, Shift+F10) has none, so use the element. */
export function menuPoint(event: MouseEvent<HTMLElement>): MenuPoint {
  if (event.clientX === 0 && event.clientY === 0) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }
  return { x: event.clientX, y: event.clientY };
}

/** One line of a context menu. */
export interface MenuEntry {
  label: string;
  onSelect(): void;
  disabled?: boolean;
  /** A thin rule above the entry, to set a group of entries apart. */
  separated?: boolean;
}

interface ContextMenuProps {
  /** Accessible name of the menu. */
  label: string;
  point: MenuPoint;
  entries: readonly MenuEntry[];
  onClose(): void;
}

/**
 * A menu that opens at the pointer. The first enabled entry takes the focus; the arrows, Home and
 * End move through the enabled entries, Tab stays inside, Escape and a click outside close it.
 */
export function ContextMenu({ label, point, entries, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  // Keeps the menu on screen: it opens down and right of the pointer, and flips when it would not fit.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(0, Math.min(point.x, window.innerWidth - rect.width));
    const top = Math.max(0, Math.min(point.y, window.innerHeight - rect.height));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [point]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (at + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (at <= 0 ? buttons.length : at) - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "Tab") next = at;
    if (next === undefined) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

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
        className="context-menu"
        role="menu"
        aria-label={label}
        style={{ left: point.x, top: point.y }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
      >
        {entries.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            className={entry.separated ? "separated" : undefined}
            disabled={entry.disabled}
            onClick={entry.onSelect}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}
