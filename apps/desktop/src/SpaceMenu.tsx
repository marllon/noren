import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { Space } from "@noren/model";
import { useT } from "./i18n";
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
  /** The user listed the space in the Projects section or took it out; the menu stays open. */
  onInProjects(listed: boolean): void;
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
  onInProjects,
  onEdit,
  onMove,
  onDelete,
  onClose,
}: SpaceMenuProps) {
  const t = useT();
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
        aria-label={t("spaceMenu.label", { name: space.name })}
        style={{ left: point.x, bottom: window.innerHeight - point.y }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
      >
        {item(t("spaceMenu.edit"), onEdit)}
        {item(t("spaceMenu.moveLeft"), () => onMove(-1), index === 0)}
        {item(t("spaceMenu.moveRight"), () => onMove(1), index === count - 1)}
        {count > 1 && item(t("spaceMenu.delete"), onDelete)}
        <div className="menu-heading" role="presentation">
          {t("spaceMenu.theme")}
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
          {t("spaceMenu.background")}
        </div>
        {item(t("spaceMenu.backgroundImage"), onBackground)}
        {hasBackground && item(t("spaceMenu.removeBackground"), onClearBackground)}
        <div className="menu-heading" role="presentation">
          {t("spaceMenu.ai")}
        </div>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={space.aiEnabled}
          title={aiOn ? undefined : t("spaceMenu.aiOff")}
          onClick={() => onAi(!space.aiEnabled)}
        >
          {t("spaceMenu.aiInSpace")}
        </button>
        <div className="menu-heading" role="presentation">
          {t("spaceMenu.projects")}
        </div>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={space.inProjects !== false}
          onClick={() => onInProjects(space.inProjects === false)}
        >
          {t("spaceMenu.showInProjects")}
        </button>
        {/* Nothing is drawn for a folder with no mods, so the menu stays as it was. */}
        {mods.length > 0 && (
          <div className="menu-heading" role="presentation">
            {t("spaceMenu.mods")}
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
                ? t("spaceMenu.modGlobal")
                : mod.missing
                  ? t("spaceMenu.modMissingHint")
                  : undefined
            }
            onClick={() => onMod(mod.name, !mod.on)}
          >
            {mod.global ? t("spaceMenu.modAllSpaces", { name: mod.name }) : mod.name}
            {mod.missing ? ` ${t("spaceMenu.modMissing")}` : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
