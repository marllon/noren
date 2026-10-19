import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { Space } from "@noren/model";
import type { SpaceModOption } from "./mod-options";
import type { SpaceThemeOption } from "./space-theme";

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
  /** The themes the space can take, and "Use global theme" (see `spaceThemeOptions`). */
  themes: readonly SpaceThemeOption[];
  /** The mods of the mods folder, and the ones the space lists that the folder lacks (see `spaceModOptions`). */
  mods: readonly SpaceModOption[];
  point: MenuPoint;
  /** The user picked a theme for the space, or (`null`) the global theme again. */
  onTheme(themeId: string | null): void;
  /** The user turned a mod on or off for this space; the menu stays open for the next one. */
  onMod(name: string, on: boolean): void;
  /** The space has a picture of its own behind its terminals. */
  hasBackground: boolean;
  /** The user wants to choose the picture of the space (the dialog opens). */
  onBackground(): void;
  /** The user took the picture of the space away. */
  onClearBackground(): void;
  /** The AI is on in the settings (`ai.enabled`); a space can still turn it off for itself. */
  aiOn: boolean;
  /** The user turned the AI on or off for this space; the menu stays open. */
  onAi(enabled: boolean): void;
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
  themes,
  mods,
  point,
  onTheme,
  onMod,
  hasBackground,
  onBackground,
  onClearBackground,
  aiOn,
  onAi,
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
        <div className="menu-heading" role="presentation">
          Theme
        </div>
        {themes.map((option) => (
          <button
            key={option.themeId ?? "global"}
            type="button"
            role="menuitemradio"
            aria-checked={option.current}
            onClick={() => onTheme(option.themeId)}
          >
            {option.label}
          </button>
        ))}
        <div className="menu-heading" role="presentation">
          Background
        </div>
        {item("Background image…", onBackground)}
        {hasBackground && item("Remove background image", onClearBackground)}
        <div className="menu-heading" role="presentation">
          AI
        </div>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={space.aiEnabled}
          title={aiOn ? undefined : "The AI is off in the settings, so it is off in every space"}
          onClick={() => onAi(!space.aiEnabled)}
        >
          AI in this space
        </button>
        {/* Nothing is drawn for a folder with no mods, so the menu stays as it was. */}
        {mods.length > 0 && (
          <div className="menu-heading" role="presentation">
            Mods
          </div>
        )}
        {mods.map((mod) => (
          <button
            key={mod.name}
            type="button"
            role="menuitemcheckbox"
            aria-checked={mod.on}
            // A mod that is on for every space is turned off in the settings screen.
            disabled={mod.global}
            title={
              mod.global
                ? "On for every space; turn it off in the settings"
                : mod.missing
                  ? "Not in the mods folder, so it is ignored"
                  : undefined
            }
            onClick={() => onMod(mod.name, !mod.on)}
          >
            {mod.global ? `${mod.name} (all spaces)` : mod.name}
            {mod.missing ? " (missing)" : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
