import {
  Bell,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  GitBranch,
  LoaderCircle,
  Pin,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { treeGroups } from "@noren/model";
import type { Action, GroupNode, Id, Space } from "@noren/model";
import { menuPoint } from "./ContextMenu";
import {
  BELL_LABEL,
  RUNNING_LABEL,
  UNREAD_LABEL,
  failureLabel,
  indicatorLabels,
  shortCwd,
  summarizeItem,
} from "./pane-info";
import type { MenuPoint } from "./SpaceMenu";
import type { ClickModifiers, TreeRow } from "./sidebar-tree";
import { DRAG_HELP_ID, DragRow, TreeDnd } from "./TreeDnd";
import type { DragHandle } from "./TreeDnd";
import { spaceItemIds } from "./workspace-store";

/** What is being renamed on the spot. */
export interface Editing {
  kind: "item" | "group";
  id: Id;
}

interface SidebarTreeProps {
  space: Space;
  rows: readonly TreeRow[];
  activeId: Id | undefined;
  /** Tabs of the multi-selection (empty when nothing is selected). */
  selected: readonly Id[];
  editing: Editing | null;
  /** Home folder of the user: a folder under it shows as `~`. */
  home?: string | undefined;
  onItemClick(itemId: Id, modifiers: ClickModifiers): void;
  onItemMenu(itemId: Id, point: MenuPoint): void;
  onGroupMenu(groupId: Id, point: MenuPoint): void;
  onToggleGroup(group: GroupNode): void;
  onStartEdit(editing: Editing): void;
  /** Enter or leaving the field: the new text of the name; `restoreFocus` is set for Enter. */
  onCommitEdit(editing: Editing, value: string, restoreFocus: boolean): void;
  onCancelEdit(): void;
  /** A drop that moves a tab or a group. */
  onMove(action: Action): void;
}

interface InlineNameProps {
  label: string;
  initial: string;
  onCommit(value: string, restoreFocus: boolean): void;
  onCancel(): void;
}

/** A text field that replaces a name: Enter confirms, Escape cancels and leaving the field confirms. */
function InlineName({ label, initial, onCommit, onCancel }: InlineNameProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (confirm: boolean, value: string, byKey = false) => {
    // The field also blurs when it unmounts after Enter or Escape; the first outcome wins.
    if (finished.current) return;
    finished.current = true;
    if (confirm) onCommit(value, byKey);
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true, event.currentTarget.value, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false, "");
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className="inline-name"
      aria-label={label}
      defaultValue={initial}
      spellCheck={false}
      onKeyDown={onKeyDown}
      onBlur={(event) => finish(true, event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

/** The tree of the active space: pinned tabs first, then tabs and groups (groups fold away). */
export function SidebarTree({
  space,
  rows,
  activeId,
  selected,
  editing,
  home,
  onItemClick,
  onItemMenu,
  onGroupMenu,
  onToggleGroup,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onMove,
}: SidebarTreeProps) {
  const order = spaceItemIds(space);
  const labelOf = (id: Id): string => {
    const item = space.items[id];
    if (item) return item.title ?? `Tab ${order.indexOf(id) + 1}`;
    return treeGroups(space.tree).find((group) => group.id === id)?.name ?? id;
  };

  const modifiersOf = (event: MouseEvent): ClickModifiers => ({
    toggle: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
  });

  const onRenameKey = (event: KeyboardEvent, edit: Editing) => {
    if (event.key !== "F2") return;
    event.preventDefault();
    onStartEdit(edit);
  };

  return (
    <TreeDnd space={space} rows={rows} labelOf={labelOf} onAction={onMove}>
      <ul key={space.id} className="tab-list" aria-label="Tabs" aria-describedby={DRAG_HELP_ID}>
        {rows.map((row) => {
          const indent = { marginInlineStart: row.depth * 14 };
          if (row.kind === "group") {
            const { group, count } = row;
            const edit: Editing = { kind: "group", id: group.id };
            if (editing?.kind === "group" && editing.id === group.id) {
              return (
                <li key={group.id} style={indent}>
                  <InlineName
                    label="Group name"
                    initial={group.name}
                    onCommit={(value, restoreFocus) => onCommitEdit(edit, value, restoreFocus)}
                    onCancel={onCancelEdit}
                  />
                </li>
              );
            }
            return (
              <DragRow key={group.id} id={group.id} kind="group" style={indent}>
                {(drag) => (
                  <button
                    type="button"
                    className="group-button"
                    data-nr-part="group"
                    data-nr-state={group.collapsed ? "collapsed" : "expanded"}
                    data-row-id={group.id}
                    data-nr-depth={row.depth}
                    aria-label={group.name}
                    aria-expanded={!group.collapsed}
                    {...drag.buttonProps}
                    onClick={() => onToggleGroup(group)}
                    onDoubleClick={() => onStartEdit(edit)}
                    onKeyDown={(event) => {
                      drag.onKeyDown(event);
                      onRenameKey(event, edit);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onGroupMenu(group.id, menuPoint(event));
                    }}
                  >
                    {group.collapsed ? (
                      <ChevronRight size={14} aria-hidden="true" />
                    ) : (
                      <ChevronDown size={14} aria-hidden="true" />
                    )}
                    <span
                      className="group-dot"
                      style={{ background: group.color }}
                      aria-hidden="true"
                    />
                    <span className="group-name">{group.name}</span>
                    <span
                      className="group-count"
                      data-nr-part="group-count"
                      title={count === 1 ? "1 tab" : `${count} tabs`}
                    >
                      {count}
                    </span>
                  </button>
                )}
              </DragRow>
            );
          }

          const item = space.items[row.id];
          if (!item) return null;
          const label = item.title ?? `Tab ${order.indexOf(row.id) + 1}`;
          const edit: Editing = { kind: "item", id: row.id };
          if (editing?.kind === "item" && editing.id === row.id) {
            return (
              <li key={row.id} style={indent}>
                <InlineName
                  label="Tab name"
                  initial={label}
                  onCommit={(value, restoreFocus) => onCommitEdit(edit, value, restoreFocus)}
                  onCancel={onCancelEdit}
                />
              </li>
            );
          }
          const isActive = row.id === activeId;
          const summary = summarizeItem(item, space.defaults.cwd);
          const cwdText = summary.cwd !== undefined ? shortCwd(summary.cwd, home) : "";
          const hasMeta = cwdText !== "" || summary.gitBranch !== undefined;
          // The button is named by the title alone; the rest is read as its description.
          const words = [
            ...indicatorLabels(summary),
            ...(cwdText !== "" ? [`Folder ${cwdText}`] : []),
            ...(summary.gitBranch !== undefined ? [`Branch ${summary.gitBranch}`] : []),
          ];
          const descriptionId = `tab-info-${row.id}`;
          // Pinned tabs sit still: moving them in and out of Pinned is the next task.
          const content = (drag?: DragHandle) => (
            <>
              <button
                type="button"
                className="tab-button"
                data-nr-part="item"
                data-nr-state={isActive ? "active" : undefined}
                data-nr-selected={selected.includes(row.id) ? "true" : undefined}
                data-nr-pinned={row.pinned ? "true" : undefined}
                data-row-id={row.id}
                data-nr-depth={row.depth}
                aria-current={isActive ? "true" : undefined}
                aria-label={label}
                aria-describedby={words.length > 0 ? descriptionId : undefined}
                {...drag?.buttonProps}
                onClick={(event) => onItemClick(row.id, modifiersOf(event))}
                onDoubleClick={() => onStartEdit(edit)}
                onKeyDown={(event) => {
                  drag?.onKeyDown(event);
                  onRenameKey(event, edit);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onItemMenu(row.id, menuPoint(event));
                }}
              >
                <span className="tab-line">
                  {row.pinned && <Pin size={12} aria-hidden="true" />}
                  <span className="tab-title" data-nr-part="item-title">
                    {label}
                  </span>
                  <span className="tab-badges" aria-hidden="true">
                    {summary.running && (
                      <span className="tab-badge" data-nr-indicator="running" title={RUNNING_LABEL}>
                        <LoaderCircle size={12} className="spin" aria-hidden="true" />
                      </span>
                    )}
                    {summary.failed !== undefined && (
                      <span
                        className="tab-badge"
                        data-nr-indicator="failed"
                        title={failureLabel(summary.failed)}
                      >
                        <CircleAlert size={12} aria-hidden="true" />
                      </span>
                    )}
                    {summary.unread && (
                      <span className="tab-badge" data-nr-indicator="unread" title={UNREAD_LABEL}>
                        <span className="unread-dot" />
                      </span>
                    )}
                    {summary.bell && (
                      <span className="tab-badge" data-nr-indicator="bell" title={BELL_LABEL}>
                        <Bell size={12} aria-hidden="true" />
                      </span>
                    )}
                  </span>
                </span>
                {hasMeta && (
                  <span className="tab-meta" data-nr-part="item-meta" aria-hidden="true">
                    {cwdText !== "" && (
                      <span className="tab-cwd" data-nr-part="item-cwd" title={summary.cwd}>
                        {cwdText}
                      </span>
                    )}
                    {summary.gitBranch !== undefined && (
                      <span className="tab-branch" data-nr-part="item-branch">
                        <GitBranch size={11} aria-hidden="true" className="tab-branch-icon" />
                        <span className="tab-branch-name">{summary.gitBranch}</span>
                      </span>
                    )}
                  </span>
                )}
              </button>
              {words.length > 0 && (
                <span id={descriptionId} className="sr-only">
                  {words.join(". ")}
                </span>
              )}
            </>
          );
          if (row.pinned) {
            return (
              <li key={row.id} style={indent}>
                {content()}
              </li>
            );
          }
          return (
            <DragRow key={row.id} id={row.id} kind="item" style={indent}>
              {content}
            </DragRow>
          );
        })}
      </ul>
    </TreeDnd>
  );
}
