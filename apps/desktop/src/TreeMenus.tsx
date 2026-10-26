import { favoriteLinkRef } from "@noren/model";
import type { FavoriteLink, FavoriteLinkRef, GroupNode, Id, Workspace } from "@noren/model";
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
  /** Splits the focused pane of the (single) tab; without it the menu offers no split. */
  onSplit?(dir: SplitDir): void;
}

/** The way a pane is split: side by side (`row`) or one above the other (`column`). */
export type SplitDir = "row" | "column";

/** Select the output of a command, or copy the output of the last one, in one pane. */
export interface OutputActions {
  onSelect(): void;
  onCopy(): void;
}

/** The project action whose tab a menu is open on. */
export interface ItemProjectAction {
  label: string;
  running: boolean;
  /** The action waits for its session to end (`stopWaits`): the menu offers to stop it now. */
  stopping: boolean;
  onRun(): void;
  onStop(): void;
  onStopNow(): void;
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
  onSplit,
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
            label: projectAction.stopping
              ? t("projects.stopNowMenu", { name: projectAction.label })
              : projectAction.running
                ? t("menu.stop", { name: projectAction.label })
                : t("menu.run", { name: projectAction.label }),
            onSelect: run(
              projectAction.stopping
                ? projectAction.onStopNow
                : projectAction.running
                  ? projectAction.onStop
                  : projectAction.onRun,
            ),
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
    ...(onSplit !== undefined && model.single
      ? [
          {
            label: t("menu.splitRight"),
            separated: true,
            onSelect: run(() => onSplit("row")),
          },
          { label: t("menu.splitDown"), onSelect: run(() => onSplit("column")) },
        ]
      : []),
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
  /** Rename pane: the name of the pane becomes a text field in its header; absent for a pane with no such field. */
  onRename?(): void;
}

/** What the menu button of a pane header offers. */
export function PaneContextMenu({
  point,
  onClose,
  onSelect,
  onCopy,
  onRename,
}: PaneContextMenuProps) {
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
    ...(onRename !== undefined
      ? [
          {
            label: t("menu.renamePane"),
            separated: true,
            onSelect: () => {
              onClose();
              onRename();
            },
          },
        ]
      : []),
  ];
  return <ContextMenu label={t("menu.pane")} point={point} entries={entries} onClose={onClose} />;
}

interface TerminalContextMenuProps {
  point: MenuPoint;
  /** Some text is selected, so Copy has something to copy. */
  hasSelection: boolean;
  /** The tab has more than one pane: only then is there a pane to close or to maximize. */
  inSplit: boolean;
  /** The pane fills the tab now, so the entry gives it back its place. */
  zoomed: boolean;
  /** Closes the menu with no choice made (Escape, a click outside): the keyboard goes back to the terminal. */
  onClose(): void;
  onCopy(): void;
  onPaste(): void;
  onSplit(dir: SplitDir): void;
  onClosePane(): void;
  onZoom(): void;
  /** Rename pane: the name of the pane becomes a text field in its header. */
  onRename(): void;
}

/**
 * What a right click in a terminal offers (the default of `terminal.rightClick`): Copy and Paste, a
 * split to the right or below, closing the pane and maximizing it. The entries that act on the layout
 * hand the keyboard to whichever pane the layout then focuses; Copy and Paste take it back to this one.
 */
export function TerminalContextMenu({
  point,
  hasSelection,
  inSplit,
  zoomed,
  onClose,
  onCopy,
  onPaste,
  onSplit,
  onClosePane,
  onZoom,
  onRename,
}: TerminalContextMenuProps) {
  const t = useT();
  const entries: MenuEntry[] = [
    {
      label: t("menu.copy"),
      disabled: !hasSelection,
      onSelect: () => {
        onClose();
        onCopy();
      },
    },
    {
      label: t("menu.paste"),
      onSelect: () => {
        onClose();
        onPaste();
      },
    },
    { label: t("menu.splitRight"), separated: true, onSelect: () => onSplit("row") },
    { label: t("menu.splitDown"), onSelect: () => onSplit("column") },
    {
      label: t("menu.closePane"),
      separated: true,
      disabled: !inSplit,
      onSelect: onClosePane,
    },
    {
      label: zoomed ? t("menu.restorePane") : t("menu.maximizePane"),
      disabled: !inSplit,
      onSelect: onZoom,
    },
    { label: t("menu.renamePane"), separated: true, onSelect: onRename },
  ];
  return (
    <ContextMenu label={t("menu.terminal")} point={point} entries={entries} onClose={onClose} />
  );
}

/** What a tile of the Favorites bar stands for: a favorite tab, or a profile or a project action. */
export type FavoriteTarget = { kind: "tab"; itemId: Id } | FavoriteLinkRef;

interface FavoriteContextMenuProps {
  store: WorkspaceStore;
  target: FavoriteTarget;
  point: MenuPoint;
  onClose(): void;
}

/** What a right click on a tile of the Favorites bar offers: to take it out of the bar. */
export function FavoriteContextMenu({ store, target, point, onClose }: FavoriteContextMenuProps) {
  const t = useT();
  const entries: MenuEntry[] = [
    {
      label: t("menu.removeFavorite"),
      onSelect: () => {
        onClose();
        store
          .getState()
          .dispatch(
            target.kind === "tab"
              ? { type: "item/unfavorite", itemId: target.itemId }
              : { type: "favorite/remove-link", link: target },
          );
      },
    },
  ];
  return (
    <ContextMenu label={t("menu.favorite")} point={point} entries={entries} onClose={onClose} />
  );
}

interface FavoriteLinkMenuProps {
  store: WorkspaceStore;
  /** The profile or action the menu is on, with the name the tile will carry. */
  link: FavoriteLink;
  /** It is in the bar already, so the menu offers to take it out. */
  inBar: boolean;
  point: MenuPoint;
  onClose(): void;
}

/**
 * What a right click on a profile (a row of the palette) or on a project action (a row of the header
 * of the space) offers: to put it in the Favorites bar, or, when it is there, to take it out.
 */
export function FavoriteLinkMenu({ store, link, inBar, point, onClose }: FavoriteLinkMenuProps) {
  const t = useT();
  const entries: MenuEntry[] = [
    {
      label: inBar ? t("menu.removeFavorite") : t("menu.addFavorite"),
      onSelect: () => {
        onClose();
        store
          .getState()
          .dispatch(
            inBar
              ? { type: "favorite/remove-link", link: favoriteLinkRef(link) }
              : { type: "favorite/add-link", link },
          );
      },
    },
  ];
  return (
    <ContextMenu
      label={link.kind === "profile" ? t("menu.profile") : t("menu.action")}
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
