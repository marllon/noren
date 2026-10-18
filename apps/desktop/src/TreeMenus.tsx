import type { GroupNode, Id, Workspace } from "@noren/model";
import { ContextMenu } from "./ContextMenu";
import type { MenuEntry } from "./ContextMenu";
import { itemMenuModel } from "./sidebar-tree";
import type { MenuPoint } from "./SpaceMenu";
import { activeSpaceOf } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

/** The default name of a group made from tabs; the name field opens right after so it is renamed. */
export const NEW_GROUP_NAME = "New group";

interface ItemContextMenuProps {
  store: WorkspaceStore;
  workspace: Workspace;
  /** The tabs the menu acts on, in sidebar order. */
  targets: readonly Id[];
  point: MenuPoint;
  onClose(): void;
  /** The menu did something: close it and drop the selection. */
  onDone(): void;
  onRename(itemId: Id): void;
  /** A group was made from the tabs. */
  onGrouped(groupId: Id): void;
}

/** What a right click on a tab (or on a multi-selection) offers. */
export function ItemContextMenu({
  store,
  workspace,
  targets,
  point,
  onClose,
  onDone,
  onRename,
  onGrouped,
}: ItemContextMenuProps) {
  const space = activeSpaceOf(workspace);
  const model = itemMenuModel(space, workspace.favorites, targets);
  const { dispatch, groupItems, closeItems, closeOthers } = store.getState();
  const run = (act: () => void) => () => {
    onDone();
    act();
  };
  const each = (action: (itemId: Id) => void) => () => targets.forEach(action);

  const entries: MenuEntry[] = [
    { label: "Rename", disabled: !model.single, onSelect: () => onRename(targets[0] ?? "") },
    {
      label: model.allPinned ? "Unpin" : "Pin",
      onSelect: run(
        each((itemId) => dispatch({ type: model.allPinned ? "item/unpin" : "item/pin", itemId })),
      ),
    },
    {
      label: model.allFavorite ? "Remove from favorites" : "Add to favorites",
      onSelect: run(
        each((itemId) =>
          dispatch({ type: model.allFavorite ? "item/unfavorite" : "item/favorite", itemId }),
        ),
      ),
    },
    {
      label: "Add to new group",
      disabled: !model.canGroup,
      onSelect: () => {
        onDone();
        const groupId = groupItems(targets, NEW_GROUP_NAME);
        if (groupId !== undefined) onGrouped(groupId);
      },
    },
    ...workspace.spaces
      .filter((other) => other.id !== space.id)
      .map((other, index): MenuEntry => ({
        label: `Move to ${other.name}`,
        separated: index === 0,
        onSelect: run(each((itemId) => dispatch({ type: "item/move", itemId, spaceId: other.id }))),
      })),
    {
      label: model.single ? "Close" : `Close ${targets.length} tabs`,
      separated: true,
      onSelect: run(() => closeItems(targets)),
    },
    {
      label: "Close others",
      disabled: model.others.length === 0,
      onSelect: run(() => closeOthers(targets)),
    },
  ];

  return (
    <ContextMenu
      label={model.single ? "Tab options" : "Selected tabs options"}
      point={point}
      entries={entries}
      onClose={onClose}
    />
  );
}

interface GroupContextMenuProps {
  store: WorkspaceStore;
  group: GroupNode;
  point: MenuPoint;
  onClose(): void;
  onRename(groupId: Id): void;
}

/** What a right click on a group header offers. */
export function GroupContextMenu({
  store,
  group,
  point,
  onClose,
  onRename,
}: GroupContextMenuProps) {
  const { dispatch } = store.getState();
  const run = (act: () => void) => () => {
    onClose();
    act();
  };
  const entries: MenuEntry[] = [
    { label: "Rename", onSelect: () => onRename(group.id) },
    {
      label: group.collapsed ? "Expand" : "Collapse",
      onSelect: run(() =>
        dispatch({ type: "group/set-collapsed", groupId: group.id, collapsed: !group.collapsed }),
      ),
    },
    {
      label: "Ungroup",
      onSelect: run(() => dispatch({ type: "group/ungroup", groupId: group.id })),
    },
  ];
  return <ContextMenu label="Group options" point={point} entries={entries} onClose={onClose} />;
}
