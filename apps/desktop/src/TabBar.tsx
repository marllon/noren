import { ChevronDown, ChevronRight, Pin, Plus } from "lucide-react";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import type { GroupNode, Id, Space } from "@noren/model";
import { menuPoint } from "./ContextMenu";
import { indicatorLabels, summarizeItem } from "./pane-info";
import type { ClickModifiers } from "./sidebar-tree";
import { InlineName, TabBadges } from "./SidebarTree";
import type { Editing } from "./SidebarTree";
import type { MenuPoint } from "./SpaceMenu";
import { barFocusTarget, barNodes } from "./tab-bar";
import type { BarNode } from "./tab-bar";
import { spaceItemIds } from "./workspace-store";

interface TabBarProps {
  space: Space;
  activeId: Id | undefined;
  /** Tabs of the multi-selection (empty when nothing is selected). */
  selected: readonly Id[];
  editing: Editing | null;
  onItemClick(itemId: Id, modifiers: ClickModifiers): void;
  onItemMenu(itemId: Id, point: MenuPoint): void;
  onGroupMenu(groupId: Id, point: MenuPoint): void;
  onToggleGroup(group: GroupNode): void;
  onStartEdit(editing: Editing): void;
  onCommitEdit(editing: Editing, value: string, restoreFocus: boolean): void;
  onCancelEdit(): void;
  onNewTab(): void;
}

/**
 * The tabs of the active space as a horizontal bar above the terminal (the top tabs layout). It
 * shows what the sidebar tree shows, in the same order: pinned tabs first, then tabs and groups,
 * where an open group is an island in the color of the group and a folded one is only its header.
 * It takes the same actions as the tree and opens the same menus (Shell owns both).
 */
export function TabBar({
  space,
  activeId,
  selected,
  editing,
  onItemClick,
  onItemMenu,
  onGroupMenu,
  onToggleGroup,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onNewTab,
}: TabBarProps) {
  const order = spaceItemIds(space);
  const modifiersOf = (event: MouseEvent): ClickModifiers => ({
    toggle: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
  });

  const onRenameKey = (event: KeyboardEvent, edit: Editing) => {
    if (event.key !== "F2") return;
    event.preventDefault();
    onStartEdit(edit);
  };

  const renderGroup = (node: Extract<BarNode, { kind: "group" }>) => {
    const { group, count, nodes } = node;
    const edit: Editing = { kind: "group", id: group.id };
    const island = { "--nr-island": group.color } as CSSProperties;
    const header =
      editing?.kind === "group" && editing.id === group.id ? (
        <InlineName
          label="Group name"
          initial={group.name}
          onCommit={(value, restoreFocus) => onCommitEdit(edit, value, restoreFocus)}
          onCancel={onCancelEdit}
        />
      ) : (
        <button
          type="button"
          className="bar-group"
          data-nr-part="group"
          data-nr-state={group.collapsed ? "collapsed" : "expanded"}
          data-nr-bar-control=""
          data-row-id={group.id}
          aria-label={group.name}
          aria-expanded={!group.collapsed}
          onClick={() => onToggleGroup(group)}
          onDoubleClick={() => onStartEdit(edit)}
          onKeyDown={(event) => onRenameKey(event, edit)}
          onContextMenu={(event) => {
            event.preventDefault();
            onGroupMenu(group.id, menuPoint(event));
          }}
        >
          {group.collapsed ? (
            <ChevronRight size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )}
          <span className="bar-group-name">{group.name}</span>
          <span
            className="group-count"
            data-nr-part="group-count"
            title={count === 1 ? "1 tab" : `${count} tabs`}
          >
            {count}
          </span>
        </button>
      );
    return (
      <li
        key={group.id}
        className="bar-island"
        data-nr-part="island"
        data-nr-state={group.collapsed ? "collapsed" : "expanded"}
        style={island}
      >
        {header}
        {nodes.length > 0 && (
          <ul className="bar-list" aria-label={`${group.name} tabs`}>
            {nodes.map(renderNode)}
          </ul>
        )}
      </li>
    );
  };

  const renderItem = (node: Extract<BarNode, { kind: "item" }>) => {
    const item = space.items[node.id];
    if (!item) return null;
    const label = item.title ?? `Tab ${order.indexOf(node.id) + 1}`;
    const edit: Editing = { kind: "item", id: node.id };
    if (editing?.kind === "item" && editing.id === node.id) {
      return (
        <li key={node.id} className="bar-slot">
          <InlineName
            label="Tab name"
            initial={label}
            onCommit={(value, restoreFocus) => onCommitEdit(edit, value, restoreFocus)}
            onCancel={onCancelEdit}
          />
        </li>
      );
    }
    const isActive = node.id === activeId;
    const summary = summarizeItem(item, space.defaults.cwd);
    const words = indicatorLabels(summary);
    const descriptionId = `bar-info-${node.id}`;
    return (
      <li key={node.id} className="bar-slot">
        <button
          type="button"
          className="bar-tab"
          data-nr-part="item"
          data-nr-state={isActive ? "active" : undefined}
          data-nr-selected={selected.includes(node.id) ? "true" : undefined}
          data-nr-pinned={node.pinned ? "true" : undefined}
          data-nr-bar-control=""
          data-row-id={node.id}
          aria-current={isActive ? "true" : undefined}
          aria-label={label}
          aria-describedby={words.length > 0 ? descriptionId : undefined}
          title={label}
          onClick={(event) => onItemClick(node.id, modifiersOf(event))}
          onDoubleClick={() => onStartEdit(edit)}
          onKeyDown={(event) => onRenameKey(event, edit)}
          onContextMenu={(event) => {
            event.preventDefault();
            onItemMenu(node.id, menuPoint(event));
          }}
        >
          {node.pinned && <Pin size={12} aria-hidden="true" />}
          <span className="bar-tab-title" data-nr-part="item-title">
            {label}
          </span>
          <TabBadges summary={summary} />
        </button>
        {words.length > 0 && (
          <span id={descriptionId} className="sr-only">
            {words.join(". ")}
          </span>
        )}
      </li>
    );
  };

  const renderNode = (node: BarNode) =>
    node.kind === "group" ? renderGroup(node) : renderItem(node);

  // Left and Right (and Home and End) move between the tabs and group headers; Tab leaves the bar.
  const onBarKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || !(event.target instanceof HTMLElement)) return;
    if (!event.target.matches("[data-nr-bar-control]")) return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-nr-bar-control]"),
    );
    const target = barFocusTarget(event.key, controls.indexOf(event.target), controls.length);
    if (target === undefined) return;
    event.preventDefault();
    controls[target]?.focus();
  };

  return (
    <nav className="tab-bar" aria-label="Tab bar" onKeyDown={onBarKeyDown}>
      <ul className="bar-list bar-root" data-nr-part="tabbar" aria-label="Tabs">
        {barNodes(space).map(renderNode)}
      </ul>
      <button
        type="button"
        className="bar-new"
        data-nr-bar-control=""
        aria-label="New tab"
        title="New tab"
        onClick={onNewTab}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </nav>
  );
}
