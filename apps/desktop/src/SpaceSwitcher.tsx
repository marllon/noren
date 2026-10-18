import { Plus } from "lucide-react";
import type { Id, Space } from "@noren/model";
import { SpaceIcon } from "./SpaceIcon";

interface SpaceSwitcherProps {
  spaces: readonly Space[];
  activeSpaceId: Id;
  onActivate(spaceId: Id): void;
  onNewSpace(): void;
}

/** Icons of the spaces at the foot of the sidebar: click one to switch, plus a button for a new one. */
export function SpaceSwitcher({
  spaces,
  activeSpaceId,
  onActivate,
  onNewSpace,
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
    </nav>
  );
}
