import type { GroupNode, Id, Workspace } from "@noren/model";
import { ContextMenu } from "./ContextMenu";
import { useT } from "./i18n";
import type { MenuEntry } from "./ContextMenu";
import { itemMenuModel } from "./sidebar-tree";
import type { MenuPoint } from "./SpaceMenu";
import { activeSpaceOf } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

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
  /** Set when the (single) tab is the one a project action runs in: the menu offers Run or Stop. */
  projectAction?: ItemProjectAction;
  /** What the menu of a single tab does with the output of the commands of its focused pane. */
  outputActions?: OutputActions;
}

/** Select the output of a command, or copy the output of the last one, in one pane. */
export interface OutputActions {
  onSelect(): void;
  onCopy(): void;
}

/** The project action whose tab a menu is open on. */
export interface ItemProjectAction {
  label: string;
  running: boolean;
  onRun(): void;
  onStop(): void;
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
  projectAction,
  outputActions,
}: ItemContextMenuProps) {
  const t = useT();
  const space = activeSpaceOf(workspace);
  const model = itemMenuModel(space, workspace.favorites, targets);
  const { dispatch, groupItems, closeItems, closeOthers } = store.getState();
  const run = (act: () => void) => () => {
    onDone();
    act();
  };
  const each = (action: (itemId: Id) => void) => () => targets.forEach(action);

  const entries: MenuEntry[] = [
    ...(projectAction !== undefined && model.single
      ? [
          {
            label: projectAction.running
              ? t("menu.stop", { name: projectAction.label })
              : t("menu.run", { name: projectAction.label }),
            onSelect: run(projectAction.running ? projectAction.onStop : projectAction.onRun),
          },
        ]
      : []),
    {
      label: t("menu.rename"),
      disabled: !model.single,
      onSelect: () => onRename(targets[0] ?? ""),
    },
    {
      label: model.allPinned ? t("menu.unpin") : t("menu.pin"),
      onSelect: run(
        each((itemId) => dispatch({ type: model.allPinned ? "item/unpin" : "item/pin", itemId })),
      ),
    },
    ...(model.canReset
      ? [
          {
            label: t("menu.reset"),
            onSelect: run(() => dispatch({ type: "item/reset", itemId: targets[0] ?? "" })),
          },
        ]
      : []),
    {
      label: model.allFavorite ? t("menu.removeFavorite") : t("menu.addFavorite"),
      onSelect: run(
        each((itemId) =>
          dispatch({ type: model.allFavorite ? "item/unfavorite" : "item/favorite", itemId }),
        ),
      ),
    },
    {
      label: t("menu.addToNewGroup"),
      disabled: !model.canGroup,
      onSelect: () => {
        onDone();
        const groupId = groupItems(targets, t("tree.newGroup"));
        if (groupId !== undefined) onGrouped(groupId);
      },
    },
    ...workspace.spaces
      .filter((other) => other.id !== space.id)
      .map((other, index): MenuEntry => ({
        label: t("menu.moveTo", { name: other.name }),
        separated: index === 0,
        onSelect: run(each((itemId) => dispatch({ type: "item/move", itemId, spaceId: other.id }))),
      })),
    ...(outputActions !== undefined && model.single
      ? [
          {
            label: t("menu.selectOutput"),
            separated: true,
            onSelect: run(outputActions.onSelect),
          },
          { label: t("menu.copyOutput"), onSelect: run(outputActions.onCopy) },
        ]
      : []),
    {
      label: model.single ? t("menu.close") : t("menu.closeMany", { count: targets.length }),
      separated: true,
      onSelect: run(() => closeItems(targets)),
    },
    {
      label: t("menu.closeOthers"),
      disabled: model.others.length === 0,
      onSelect: run(() => closeOthers(targets)),
    },
  ];

  return (
    <ContextMenu
      label={model.single ? t("menu.tab") : t("menu.tabs")}
      point={point}
      entries={entries}
      onClose={onClose}
    />
  );
}

interface PaneContextMenuProps extends OutputActions {
  point: MenuPoint;
  onClose(): void;
}

/** What the menu button of a pane header offers. */
export function PaneContextMenu({ point, onClose, onSelect, onCopy }: PaneContextMenuProps) {
  const t = useT();
  const entries: MenuEntry[] = [
    {
      label: t("menu.selectOutput"),
      onSelect: () => {
        onClose();
        onSelect();
      },
    },
    {
      label: t("menu.copyOutput"),
      onSelect: () => {
        onClose();
        onCopy();
      },
    },
  ];
  return <ContextMenu label={t("menu.pane")} point={point} entries={entries} onClose={onClose} />;
}

interface FavoriteContextMenuProps {
  store: WorkspaceStore;
  itemId: Id;
  point: MenuPoint;
  onClose(): void;
}

/** What a right click on a tile of the Favorites grid offers. */
export function FavoriteContextMenu({ store, itemId, point, onClose }: FavoriteContextMenuProps) {
  const t = useT();
  const entries: MenuEntry[] = [
    {
      label: t("menu.removeFavorite"),
      onSelect: () => {
        onClose();
        store.getState().dispatch({ type: "item/unfavorite", itemId });
      },
    },
  ];
  return (
    <ContextMenu label={t("menu.favorite")} point={point} entries={entries} onClose={onClose} />
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
  const t = useT();
  const { dispatch } = store.getState();
  const run = (act: () => void) => () => {
    onClose();
    act();
  };
  const entries: MenuEntry[] = [
    { label: t("menu.rename"), onSelect: () => onRename(group.id) },
    {
      label: group.collapsed ? t("menu.expand") : t("menu.collapse"),
      onSelect: run(() =>
        dispatch({ type: "group/set-collapsed", groupId: group.id, collapsed: !group.collapsed }),
      ),
    },
    {
      label: t("menu.ungroup"),
      onSelect: run(() => dispatch({ type: "group/ungroup", groupId: group.id })),
    },
  ];
  return <ContextMenu label={t("menu.group")} point={point} entries={entries} onClose={onClose} />;
}
