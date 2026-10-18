import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import { useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { GroupNode, Id, Space } from "@noren/model";
import { menuPoint } from "./ContextMenu";
import type { MenuPoint } from "./SpaceMenu";
import type { ClickModifiers, TreeRow } from "./sidebar-tree";
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
  onItemClick(itemId: Id, modifiers: ClickModifiers): void;
  onItemMenu(itemId: Id, point: MenuPoint): void;
  onGroupMenu(groupId: Id, point: MenuPoint): void;
  onToggleGroup(group: GroupNode): void;
  onStartEdit(editing: Editing): void;
  /** Enter or leaving the field: the new text of the name; `restoreFocus` is set for Enter. */
  onCommitEdit(editing: Editing, value: string, restoreFocus: boolean): void;
  onCancelEdit(): void;
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
  onItemClick,
  onItemMenu,
  onGroupMenu,
  onToggleGroup,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
}: SidebarTreeProps) {
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

  return (
    <ul key={space.id} className="tab-list" aria-label="Tabs">
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
            <li key={group.id} style={indent}>
              <button
                type="button"
                className="group-button"
                data-nr-part="group"
                data-nr-state={group.collapsed ? "collapsed" : "expanded"}
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
            </li>
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
        return (
          <li key={row.id} style={indent}>
            <button
              type="button"
              className="tab-button"
              data-nr-part="item"
              data-nr-state={isActive ? "active" : undefined}
              data-nr-selected={selected.includes(row.id) ? "true" : undefined}
              data-nr-pinned={row.pinned ? "true" : undefined}
              data-row-id={row.id}
              aria-current={isActive ? "true" : undefined}
              onClick={(event) => onItemClick(row.id, modifiersOf(event))}
              onDoubleClick={() => onStartEdit(edit)}
              onKeyDown={(event) => onRenameKey(event, edit)}
              onContextMenu={(event) => {
                event.preventDefault();
                onItemMenu(row.id, menuPoint(event));
              }}
            >
              {row.pinned && <Pin size={12} aria-hidden="true" />}
              {label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
