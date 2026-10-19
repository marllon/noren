import {
  Bell,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  GitBranch,
  LoaderCircle,
  Pin,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { GroupNode, Id, Item, Space } from "@noren/model";
import { menuPoint } from "./ContextMenu";
import { layoutThumbnail, paneEntries } from "./item-panes";
import type { PaneEntry } from "./item-panes";
import {
  BELL_LABEL,
  RUNNING_LABEL,
  UNREAD_LABEL,
  commandWords,
  exitText,
  failureLabel,
  groupMarks,
  indicatorLabels,
  marksWords,
  shortCwd,
  summarizeItem,
} from "./pane-info";
import type { CommandInfo, ItemSummary, UnreadMarks } from "./pane-info";
import type { MenuPoint } from "./SpaceMenu";
import type { ClickModifiers, TreeRow } from "./sidebar-tree";
import { DRAG_HELP_ID, DragRow, useOutsideDrop } from "./TreeDnd";
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
  /** A pane was clicked in the list of a split tab: show that tab and focus the pane. */
  onPaneClick(itemId: Id, paneId: Id): void;
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

/** The unread dot and the bell of a tab, group or space (the same marks wherever they sit). */
export function MarkBadges({ marks }: { marks: UnreadMarks }) {
  return (
    <>
      {marks.unread && (
        <span className="tab-badge" data-nr-indicator="unread" title={UNREAD_LABEL}>
          <span className="unread-dot" />
        </span>
      )}
      {marks.bell && (
        <span className="tab-badge" data-nr-indicator="bell" title={BELL_LABEL}>
          <Bell size={12} aria-hidden="true" />
        </span>
      )}
    </>
  );
}

/** The status marks of a tab (running, failed, unread, bell); read through the tab's description. */
export function TabBadges({ summary }: { summary: ItemSummary }) {
  return (
    <span className="tab-badges" aria-hidden="true">
      {summary.running && (
        <span className="tab-badge" data-nr-indicator="running" title={RUNNING_LABEL}>
          <LoaderCircle size={12} className="spin" aria-hidden="true" />
        </span>
      )}
      {summary.failed !== undefined && (
        <span className="tab-badge" data-nr-indicator="failed" title={failureLabel(summary.failed)}>
          <CircleAlert size={12} aria-hidden="true" />
        </span>
      )}
      <MarkBadges marks={summary} />
    </span>
  );
}

/**
 * The command of a pane in a line: its text, then its exit code and how long it took (or
 * `running`). `part` names the line for the tests; the text is cut by the stylesheet.
 */
function CommandLine({ info, part }: { info: CommandInfo; part: string }) {
  return (
    <span className={part} data-nr-part={part} data-nr-state={info.state} aria-hidden="true">
      {info.text !== undefined && (
        <span className="command-text" data-nr-part={`${part}-text`} title={info.text}>
          {info.text}
        </span>
      )}
      {info.state === "running" ? (
        <span className="command-code" data-nr-part={`${part}-code`}>
          running
        </span>
      ) : (
        <>
          {info.exitCode !== undefined && (
            <span className="command-code" data-nr-part={`${part}-code`}>
              {exitText(info)}
            </span>
          )}
          {info.duration !== undefined && (
            <span className="command-time" data-nr-part={`${part}-time`}>
              {info.duration}
            </span>
          )}
        </>
      )}
    </span>
  );
}

/** A small drawing of how a split tab is laid out; the focused pane is filled. */
function LayoutThumb({ item }: { item: Item }) {
  return (
    <span className="item-thumb" data-nr-part="item-layout" aria-hidden="true">
      {layoutThumbnail(item.layout).map((cell) => (
        <span
          key={cell.paneId}
          className="item-thumb-cell"
          data-nr-state={cell.paneId === item.focusedPaneId ? "focused" : undefined}
          style={{
            left: `${cell.x}%`,
            top: `${cell.y}%`,
            width: `${cell.w}%`,
            height: `${cell.h}%`,
          }}
        />
      ))}
    </span>
  );
}

interface PaneListProps {
  itemId: Id;
  /** Name of the tab, for the name of the list. */
  label: string;
  entries: readonly PaneEntry[];
  onPaneClick(itemId: Id, paneId: Id): void;
}

/** The panes of a split tab, one button each; the pane that has the keyboard is marked. */
function PaneList({ itemId, label, entries, onPaneClick }: PaneListProps) {
  return (
    <ul className="item-panes" data-nr-part="item-panes" aria-label={`Panes of ${label}`}>
      {entries.map((entry) => (
        <li key={entry.paneId}>
          <button
            type="button"
            className="item-pane"
            data-nr-part="item-pane"
            data-nr-pane={entry.paneId}
            aria-current={entry.focused ? "true" : undefined}
            aria-label={`${entry.title}, ${entry.status}`}
            onClick={() => onPaneClick(itemId, entry.paneId)}
          >
            <span className="item-pane-title">{entry.title}</span>
            {entry.command !== undefined && (
              <CommandLine info={entry.command} part="item-pane-command" />
            )}
            <span className="item-pane-status" data-nr-part="item-pane-status" aria-hidden="true">
              {entry.status}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A text field that replaces a name: Enter confirms, Escape cancels and leaving the field confirms. */
export function InlineName({ label, initial, onCommit, onCancel }: InlineNameProps) {
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

/**
 * The pinned tabs of the space as a list of their own above the tree; also the place a tab is
 * dropped to pin it. It is only rendered when something is pinned (the drop zone stands in then).
 */
function PinnedList({ children }: { children: ReactNode }) {
  const drop = useOutsideDrop({ kind: "pinned" });
  return (
    <li
      ref={drop.ref}
      className="pinned"
      data-nr-part="pinned-list"
      data-nr-state={drop.over ? "over" : undefined}
    >
      <ul className="pinned-list" aria-label="Pinned">
        {children}
      </ul>
    </li>
  );
}

/**
 * The tabs of the active space: the pinned list first, then tabs and groups (groups fold away). It
 * must sit inside the `TreeDnd` of the sidebar, which owns the drag and drop.
 */
export function SidebarTree({
  space,
  rows,
  activeId,
  selected,
  editing,
  home,
  onItemClick,
  onPaneClick,
  onItemMenu,
  onGroupMenu,
  onToggleGroup,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
}: SidebarTreeProps) {
  const order = spaceItemIds(space);
  // The pane lists the user folded; a split tab is expanded unless it is here. Only in memory: it
  // is not part of the saved workspace.
  const [folded, setFolded] = useState<ReadonlySet<Id>>(new Set());
  const toggleFolded = (itemId: Id) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(itemId)) next.add(itemId);
      return next;
    });
  const modifiersOf = (event: MouseEvent): ClickModifiers => ({
    toggle: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
  });

  const onRenameKey = (event: KeyboardEvent, edit: Editing) => {
    if (event.key !== "F2") return;
    event.preventDefault();
    onStartEdit(edit);
  };

  const renderRow = (row: TreeRow) => {
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
      const marks = groupMarks(space, group);
      const words = marksWords(marks);
      const descriptionId = `group-info-${group.id}`;
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
              aria-describedby={words.length > 0 ? descriptionId : undefined}
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
              <span className="group-dot" style={{ background: group.color }} aria-hidden="true" />
              <span className="group-name">{group.name}</span>
              {words.length > 0 && (
                <span className="tab-badges" data-nr-part="group-marks" aria-hidden="true">
                  <MarkBadges marks={marks} />
                </span>
              )}
              {words.length > 0 && (
                <span id={descriptionId} className="sr-only">
                  {words.join(". ")}
                </span>
              )}
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
      ...(summary.command !== undefined ? [commandWords(summary.command)] : []),
    ];
    const descriptionId = `tab-info-${row.id}`;
    const entries = paneEntries(item, space.defaults.cwd, home);
    const isSplit = entries.length > 0;
    const expanded = isSplit && !folded.has(row.id);
    // An open pane list shows the command of each pane; otherwise the tab shows the focused one.
    const command = expanded ? undefined : summary.command;
    // Pinned tabs sit still: they are not dragged, but a tab can be dropped on the Pinned zone.
    const content = (drag?: DragHandle) => (
      <>
        <button
          type="button"
          className="tab-button"
          data-nr-part="item"
          data-nr-state={isActive ? "active" : undefined}
          data-nr-selected={selected.includes(row.id) ? "true" : undefined}
          data-nr-pinned={row.pinned ? "true" : undefined}
          data-nr-split={isSplit ? "true" : undefined}
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
            {isSplit && <LayoutThumb item={item} />}
            <TabBadges summary={summary} />
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
          {command !== undefined && <CommandLine info={command} part="item-command" />}
        </button>
        {isSplit && (
          <button
            type="button"
            className="pane-toggle"
            data-nr-part="item-panes-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? "Hide panes" : "Show panes"}
            onClick={() => toggleFolded(row.id)}
          >
            {expanded ? (
              <ChevronDown size={14} aria-hidden="true" />
            ) : (
              <ChevronRight size={14} aria-hidden="true" />
            )}
          </button>
        )}
        {words.length > 0 && (
          <span id={descriptionId} className="sr-only">
            {words.join(". ")}
          </span>
        )}
        {expanded && (
          <PaneList itemId={row.id} label={label} entries={entries} onPaneClick={onPaneClick} />
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
  };

  const pinnedRows = rows.filter((row) => row.kind === "item" && row.pinned);
  const treeRows = rows.filter((row) => !(row.kind === "item" && row.pinned));
  return (
    <ul key={space.id} className="tab-list" aria-label="Tabs" aria-describedby={DRAG_HELP_ID}>
      {pinnedRows.length > 0 && <PinnedList>{pinnedRows.map(renderRow)}</PinnedList>}
      {treeRows.map(renderRow)}
    </ul>
  );
}
