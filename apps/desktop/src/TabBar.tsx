import { ChevronDown, ChevronRight, Pin, Plus } from "lucide-react";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import type { GroupNode, Id, Space } from "@noren/model";
import { useAgentOfPane } from "./agent-store";
import { useAgentStateOfPane } from "./agent-state-store";
import { useLinkOfPane } from "./session-link-store";
import { menuPoint } from "./ContextMenu";
import { tabCount, useT } from "./i18n";
import { indicatorLabels, linkShort, linkText, summarizeItem } from "./pane-info";
import type { ClickModifiers } from "./sidebar-tree";
import { InlineName, RetryLinkButton, TabBadges } from "./SidebarTree";
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
  /** Try again on a tab whose connection to its shell failed: connect its sessions once more. */
  onRetryLink?(itemId: Id): void;
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
  onRetryLink,
}: TabBarProps) {
  const t = useT();
  const agentOf = useAgentOfPane();
  const agentStateOf = useAgentStateOfPane();
  const linkOf = useLinkOfPane();
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
          label={t("tree.groupName")}
          initial={group.name}
          onCommit={(value, restoreFocus) => onCommitEdit(edit, value, restoreFocus)}
          onCancel={onCancelEdit}
        />
      ) : (
        // A tab list owns only tabs, so the header of a group is a tab too: it opens or folds the
        // group instead of showing a panel, which `aria-expanded` says.
        <button
          type="button"
          role="tab"
          className="bar-group"
          data-nr-part="group"
          data-nr-state={group.collapsed ? "collapsed" : "expanded"}
          data-nr-bar-control=""
          data-row-id={group.id}
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
            title={tabCount(count)}
            aria-hidden="true"
          >
            {count}
          </span>
        </button>
      );
    return (
      <li
        key={group.id}
        role="none"
        className="bar-island"
        data-nr-part="island"
        data-nr-state={group.collapsed ? "collapsed" : "expanded"}
        style={island}
      >
        {header}
        {nodes.length > 0 && (
          <ul className="bar-list" role="none">
            {nodes.map(renderNode)}
          </ul>
        )}
      </li>
    );
  };

  const renderItem = (node: Extract<BarNode, { kind: "item" }>) => {
    const item = space.items[node.id];
    if (!item) return null;
    const label = item.title ?? t("tree.tabDefault", { n: order.indexOf(node.id) + 1 });
    const edit: Editing = { kind: "item", id: node.id };
    if (editing?.kind === "item" && editing.id === node.id) {
      return (
        <li key={node.id} role="none" className="bar-slot">
          <InlineName
            label={t("tree.tabName")}
            initial={label}
            onCommit={(value, restoreFocus) => onCommitEdit(edit, value, restoreFocus)}
            onCancel={onCancelEdit}
          />
        </li>
      );
    }
    const isActive = node.id === activeId;
    const summary = summarizeItem(item, space.defaults.cwd, agentOf, agentStateOf, linkOf);
    const words = indicatorLabels(summary);
    const descriptionId = `bar-info-${node.id}`;
    return (
      <li key={node.id} role="none" className="bar-slot" data-nr-link-state={summary.link?.state}>
        <button
          type="button"
          role="tab"
          className="bar-tab"
          data-nr-part="item"
          data-nr-state={isActive ? "active" : undefined}
          data-nr-selected={selected.includes(node.id) ? "true" : undefined}
          data-nr-pinned={node.pinned ? "true" : undefined}
          data-nr-bar-control=""
          data-row-id={node.id}
          aria-selected={isActive}
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
          {summary.link !== undefined && (
            <span
              className="bar-tab-link"
              data-nr-part="item-link"
              data-nr-link-state={summary.link.state}
              aria-hidden="true"
              title={linkText(summary.link)}
            >
              {linkShort(summary.link)}
            </span>
          )}
        </button>
        {summary.link?.state === "failed" && onRetryLink !== undefined && (
          <RetryLinkButton tab={label} onRetry={() => onRetryLink(node.id)} />
        )}
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
    <nav className="tab-bar" aria-label={t("tabBar.label")} onKeyDown={onBarKeyDown}>
      <ul
        className="bar-list bar-root"
        data-nr-part="tabbar"
        role="tablist"
        aria-label={t("tree.tabs")}
      >
        {barNodes(space).map(renderNode)}
      </ul>
      <button
        type="button"
        className="bar-new"
        data-nr-bar-control=""
        aria-label={t("tabBar.newTab")}
        title={t("tabBar.newTab")}
        onClick={onNewTab}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </nav>
  );
}
