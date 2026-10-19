import { Ellipsis, Plus } from "lucide-react";
import type { Id, Space } from "@noren/model";
import { menuPoint } from "./ContextMenu";
import { useT } from "./i18n";
import { marksWords, spaceMarks } from "./pane-info";
import { MarkBadges } from "./SidebarTree";
import { SpaceIcon } from "./SpaceIcon";
import type { MenuPoint } from "./SpaceMenu";
import { useOutsideDrop } from "./TreeDnd";

interface SpaceSwitcherProps {
  spaces: readonly Space[];
  activeSpaceId: Id;
  onActivate(spaceId: Id): void;
  onNewSpace(): void;
  /** Asks for the menu of a space: right click on its icon, or the "..." button for the active one. */
  onMenu(spaceId: Id, point: MenuPoint): void;
}

interface SpaceButtonProps {
  space: Space;
  index: number;
  active: boolean;
  onActivate(spaceId: Id): void;
  onMenu(spaceId: Id, point: MenuPoint): void;
}

/** The icon of a space; a tab dragged over it (from another space) is dropped into that space. */
function SpaceButton({ space, index, active, onActivate, onMenu }: SpaceButtonProps) {
  const drop = useOutsideDrop({ kind: "space", spaceId: space.id });
  const marks = spaceMarks(space);
  const words = marksWords(marks);
  const descriptionId = `space-info-${space.id}`;
  return (
    <button
      ref={drop.ref}
      type="button"
      className="space-button"
      data-nr-state={drop.over ? "drop-target" : active ? "active" : undefined}
      aria-current={active ? "true" : undefined}
      aria-label={space.name}
      aria-describedby={words.length > 0 ? descriptionId : undefined}
      title={index < 9 ? `${space.name} (Ctrl+Alt+${index + 1})` : space.name}
      style={{ "--nr-space-color": space.color } as React.CSSProperties}
      onClick={() => onActivate(space.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(space.id, menuPoint(event));
      }}
    >
      <SpaceIcon name={space.icon} color={space.color} />
      {words.length > 0 && (
        <span className="space-marks" data-nr-part="space-marks" aria-hidden="true">
          <MarkBadges marks={marks} />
        </span>
      )}
      {words.length > 0 && (
        <span id={descriptionId} className="sr-only">
          {words.join(". ")}
        </span>
      )}
    </button>
  );
}

/** Icons of the spaces at the foot of the sidebar: click one to switch, plus a button for a new one. */
export function SpaceSwitcher({
  spaces,
  activeSpaceId,
  onActivate,
  onNewSpace,
  onMenu,
}: SpaceSwitcherProps) {
  const t = useT();
  return (
    <nav className="space-switcher" data-nr-part="space-switcher" aria-label={t("spaces.nav")}>
      {spaces.map((space, index) => (
        <SpaceButton
          key={space.id}
          space={space}
          index={index}
          active={space.id === activeSpaceId}
          onActivate={onActivate}
          onMenu={onMenu}
        />
      ))}
      <button
        type="button"
        className="space-button space-add"
        aria-label={t("spaces.new")}
        title={t("spaces.new")}
        onClick={onNewSpace}
      >
        <Plus size={18} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="space-button space-more"
        aria-label={t("spaces.options")}
        title={t("spaces.options")}
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
