import { Ellipsis, Plus } from "lucide-react";
import type { MouseEvent } from "react";
import type { Id, Space } from "@noren/model";
import { SpaceIcon } from "./SpaceIcon";
import type { MenuPoint } from "./SpaceMenu";

interface SpaceSwitcherProps {
  spaces: readonly Space[];
  activeSpaceId: Id;
  onActivate(spaceId: Id): void;
  onNewSpace(): void;
  /** Asks for the menu of a space: right click on its icon, or the "..." button for the active one. */
  onMenu(spaceId: Id, point: MenuPoint): void;
}

/** The pointer position of a context-menu event; the key (Menu, Shift+F10) has none, so use the button. */
function menuPoint(event: MouseEvent<HTMLElement>): MenuPoint {
  if (event.clientX === 0 && event.clientY === 0) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }
  return { x: event.clientX, y: event.clientY };
}

/** Icons of the spaces at the foot of the sidebar: click one to switch, plus a button for a new one. */
export function SpaceSwitcher({
  spaces,
  activeSpaceId,
  onActivate,
  onNewSpace,
  onMenu,
}: SpaceSwitcherProps) {
  return (
    <nav className="space-switcher" data-nr-part="space-switcher" aria-label="Spaces">
      {spaces.map((space, index) => {
        const active = space.id === activeSpaceId;
        return (
          <button
            key={space.id}
            type="button"
            className="space-button"
            data-nr-state={active ? "active" : undefined}
            aria-current={active ? "true" : undefined}
            aria-label={space.name}
            title={index < 9 ? `${space.name} (Ctrl+Alt+${index + 1})` : space.name}
            style={{ "--nr-space-color": space.color } as React.CSSProperties}
            onClick={() => onActivate(space.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu(space.id, menuPoint(event));
            }}
          >
            <SpaceIcon name={space.icon} color={space.color} />
          </button>
        );
      })}
      <button
        type="button"
        className="space-button space-add"
        aria-label="New space"
        title="New space"
        onClick={onNewSpace}
      >
        <Plus size={18} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="space-button space-more"
        aria-label="Space options"
        title="Space options"
        aria-haspopup="menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(activeSpaceId, { x: rect.left, y: rect.top });
        }}
      >
        <Ellipsis size={18} aria-hidden="true" />
      </button>
    </nav>
  );
}
