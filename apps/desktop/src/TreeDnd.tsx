import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  Announcements,
  CollisionDetection,
  DragEndEvent,
  DragMoveEvent,
  DragStartEvent,
  KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { createContext, useContext, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { treeGroups } from "@noren/model";
import type { Action, Id, Space } from "@noren/model";
import {
  FAVORITES_DROP_ID,
  PINNED_DROP_ID,
  dropAction,
  canDropOnPane,
  dropSlots,
  leavesWindow,
  outsideAction,
  outsideId,
  outsideOf,
  paneDragId,
  paneDropId,
  paneOf,
  paneZone,
  resolveDrop,
  swapTarget,
} from "./sidebar-drop";
import type { DragSource, DropTarget, OutsideDrop, PaneDrop, PaneZone } from "./sidebar-drop";
import type { TreeRow } from "./sidebar-tree";
import { t, useT } from "./i18n";
import { spaceItemIds } from "./workspace-store";

// Drag and drop of the sidebar on top of @dnd-kit. The library only moves the pointer (or the
// keyboard cursor) around and reports which droppable is under it; what that means is
// `sidebar-drop.ts`. One context covers the tree, the space icons, the Pinned list and the Favorites grid.

/** How far (px) the pointer travels before a press becomes a drag, so clicks stay clicks. */
const ACTIVATION_DISTANCE = 6;

/** Id of the text that tells keyboard and screen reader users how to move a row; the list points to it. */
export const DRAG_HELP_ID = "tree-drag-help";

interface DragState {
  /** The place in the tree the dragged row would land in. */
  target: DropTarget | null;
  /** The space icon or zone under the pointer, when dropping there would change something. */
  outside: OutsideDrop | null;
  /** The zone of a pane of the tab on screen under the pointer, when dropping there would join the tab. */
  pane: PaneDrop | null;
  /** The pane that a dragged pane would swap with, when it is under the pointer. */
  swap: Id | null;
  /** The pointer is beyond the edge of the window with a tab: dropping it there takes it to a window of its own. */
  window: boolean;
  /** Whether a drag is under way (the empty-state drop zones only show then). */
  dragging: boolean;
}

const DragStateContext = createContext<DragState>({
  target: null,
  outside: null,
  pane: null,
  swap: null,
  window: false,
  dragging: false,
});

/**
 * Where the pointer is, or the middle of the dragged row when the keyboard drives. The space icons
 * and the zones (prefixed ids) are tried before the rows, which have no prefix.
 */
const rowCollision: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
  pointerCoordinates,
}) => {
  const x = pointerCoordinates?.x ?? collisionRect.left + collisionRect.width / 2;
  const y = pointerCoordinates?.y ?? collisionRect.top + collisionRect.height / 2;
  const isOutside = (id: string | number) => outsideOf(String(id)) !== undefined;
  const ordered = [
    ...droppableContainers.filter((container) => isOutside(container.id)),
    ...droppableContainers.filter((container) => !isOutside(container.id)),
  ];
  for (const container of ordered) {
    const rect = droppableRects.get(container.id);
    if (!rect || container.disabled) continue;
    // One pixel of slack covers the gap between rows.
    if (x >= rect.left && x <= rect.right && y >= rect.top - 1 && y <= rect.bottom + 1) {
      // `over` of a drag event lags one render behind, so the row and the spot travel in here.
      return [
        {
          id: container.id,
          data: {
            droppableContainer: container,
            value: 0,
            x,
            y,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
        },
      ];
    }
  }
  return [];
};

function sourceOf(data: unknown): DragSource | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { kind, id } = data as Partial<DragSource>;
  return (kind === "item" || kind === "group") && typeof id === "string" ? { kind, id } : undefined;
}

const sameOutside = (a: OutsideDrop | null, b: OutsideDrop | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    (a.kind !== "space" || (b.kind === "space" && a.spaceId === b.spaceId)));

const samePane = (a: PaneDrop | null, b: PaneDrop | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.paneId === b.paneId && a.dir === b.dir && a.side === b.side);

/** A pane header being dragged: the pane, and the text its ghost and announcements use. */
interface PaneSource {
  paneId: Id;
  title: string;
}

function paneSourceOf(data: unknown): PaneSource | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { kind, id, title } = data as { kind?: unknown; id?: unknown; title?: unknown };
  return kind === "pane" && typeof id === "string"
    ? { paneId: id, title: typeof title === "string" ? title : t("pane.title") }
    : undefined;
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.rowId === b.rowId &&
    a.edge === b.edge &&
    a.groupId === b.groupId &&
    a.index === b.index);

/** Where a drag event currently points: a place in the tree, or a space icon or zone. */
interface Place {
  target: DropTarget | null;
  outside: OutsideDrop | null;
  pane: PaneDrop | null;
  swap: Id | null;
  window: boolean;
}

const NOWHERE: Place = { target: null, outside: null, pane: null, swap: null, window: false };

/**
 * Where the pointer is at the end of a drag started with the mouse, in the client coordinates of
 * the page: where it was pressed plus how far it travelled. `undefined` for a drag the keyboard
 * drives, which never leaves the window.
 */
function pointerAt(event: DragMoveEvent | DragEndEvent): { x: number; y: number } | undefined {
  const start = event.activatorEvent as Partial<{ clientX: number; clientY: number }>;
  if (typeof start.clientX !== "number" || typeof start.clientY !== "number") return undefined;
  return { x: start.clientX + event.delta.x, y: start.clientY + event.delta.y };
}

/** Whether a tab is being let go beyond the edge of the window. */
function beyondWindow(event: DragMoveEvent | DragEndEvent): boolean {
  const point = pointerAt(event);
  const root = document.documentElement;
  return (
    point !== undefined &&
    leavesWindow(point, { width: root.clientWidth, height: root.clientHeight })
  );
}

const SIDE_WORDS = {
  row: { before: "drag.side.left", after: "drag.side.right" },
  column: { before: "drag.side.above", after: "drag.side.below" },
} as const;

interface TreeDndProps {
  /** Every space: a tab can be dropped on the icon of any of them. */
  spaces: readonly Space[];
  /** The global favorites. */
  favorites: readonly Id[];
  /** The active space, the one whose tree is on screen. */
  space: Space;
  rows: readonly TreeRow[];
  /** A drop that changes the workspace. */
  onAction(action: Action): void;
  /** The tab on screen, whose panes take drops; undefined when no pane can take one. */
  paneItemId: Id | undefined;
  /** A tab was dropped on a pane of the tab on screen: join it there (or refuse). */
  onPaneDrop(sourceId: Id, drop: PaneDrop): void;
  /** A pane header was dropped on the middle of another pane: swap the two. */
  onPaneSwap(paneId: Id, otherPaneId: Id): void;
  /**
   * A tab was let go beyond the edge of the window: take it to a window of its own. Left out where
   * the page cannot show another window, so the drop there does nothing.
   */
  onDragOut?(itemId: Id): void;
  children: ReactNode;
}

/**
 * Owns the one `DndContext` of the sidebar: it wraps the tree, the Pinned list, the Favorites grid
 * and the space icons, and keeps the place the dragged row would land in.
 */
export function TreeDnd({
  spaces,
  favorites,
  space,
  rows,
  onAction,
  paneItemId,
  onPaneDrop,
  onPaneSwap,
  onDragOut,
  children,
}: TreeDndProps) {
  // Draws again when the language changes: the instructions and announcements are read from `t`.
  useT();
  const [place, setPlace] = useState<Place>(NOWHERE);
  const [status, setStatus] = useState("");
  /** What the ghost says: the name of the tab, group or pane being dragged. */
  const [dragging, setDragging] = useState<string | null>(null);
  const { target, outside, pane, swap, window: leaving } = place;

  const order = spaceItemIds(space);
  /** The name of a tab or group, for what is read aloud and shown on the ghost. */
  const labelOf = (id: Id): string => {
    const item = space.items[id];
    if (item) return item.title ?? t("tree.tabDefault", { n: order.indexOf(id) + 1 });
    return treeGroups(space.tree).find((group) => group.id === id)?.name ?? id;
  };

  /** The name of what a drag started on, from the data its draggable carries. */
  const labelOfActive = (active: { id: string | number; data: { current?: unknown } }): string =>
    paneSourceOf(active.data.current)?.title ?? labelOf(String(active.id));

  const describe = ({
    target: spot,
    outside: away,
    pane: beside,
    swap: other,
    window: toWindow,
  }: Place): string => {
    if (toWindow) return t("drag.toWindow");
    if (other !== null) return t("drag.swap");
    if (beside) return t("drag.beside", { side: t(SIDE_WORDS[beside.dir][beside.side]) });
    if (away) {
      if (away.kind === "pinned") return t("drag.pin");
      if (away.kind === "favorites") return t("drag.favorite");
      const name = spaces.find((candidate) => candidate.id === away.spaceId)?.name ?? away.spaceId;
      return t("drag.moveToSpace", { name });
    }
    if (!spot) return t("drag.noChange");
    const name = labelOf(spot.rowId);
    if (spot.edge === "inside") return t("drag.inside", { name });
    return spot.edge === "before" ? t("drag.before", { name }) : t("drag.after", { name });
  };

  /** The place under the pointer or keyboard cursor, from the data of a drag event. */
  const placeOf = (event: DragMoveEvent | DragEndEvent): Place => {
    const collision = event.collisions?.[0];
    // A pane header only ever lands on the middle of another pane of the tab on screen.
    const dragged = paneSourceOf(event.active.data.current);
    if (dragged) {
      const over = collision && paneOf(String(collision.id));
      if (!collision || over === undefined) return NOWHERE;
      const { x, y, left, top, width, height } = (collision.data ?? {}) as Record<string, unknown>;
      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        typeof left !== "number" ||
        typeof top !== "number" ||
        typeof width !== "number" ||
        typeof height !== "number"
      ) {
        return NOWHERE;
      }
      const other = swapTarget(dragged.paneId, over, { left, top, width, height }, { x, y });
      return other === undefined ? NOWHERE : { ...NOWHERE, swap: other };
    }
    const source = sourceOf(event.active.data.current);
    // A tab let go beyond the edge of the window leaves it (a group stays; pinned tabs do not drag).
    if (source?.kind === "item" && onDragOut !== undefined && beyondWindow(event)) {
      return { ...NOWHERE, window: true };
    }
    if (!source || !collision) return NOWHERE;
    const away = outsideOf(String(collision.id));
    if (away) {
      const valid = outsideAction(spaces, favorites, source, away) !== undefined;
      return { ...NOWHERE, outside: valid ? away : null };
    }
    const { x, y, left, top, width, height } = (collision.data ?? {}) as Record<string, unknown>;
    if (typeof y !== "number" || typeof top !== "number" || typeof height !== "number") {
      return NOWHERE;
    }
    const paneId = paneOf(String(collision.id));
    if (paneId !== undefined) {
      if (!canDropOnPane(source, paneItemId)) return NOWHERE;
      if (typeof x !== "number" || typeof left !== "number" || typeof width !== "number") {
        return NOWHERE;
      }
      const zone = paneZone({ left, top, width, height }, { x, y });
      return zone ? { ...NOWHERE, pane: { paneId, ...zone } } : NOWHERE;
    }
    const fraction = height > 0 ? Math.min(1, Math.max(0, (y - top) / height)) : 0.5;
    return {
      ...NOWHERE,
      target: resolveDrop(space, rows, source, String(collision.id), fraction) ?? null,
    };
  };

  const keyboardCoordinates: KeyboardCoordinateGetter = (
    event,
    { context, currentCoordinates },
  ) => {
    const down = event.code === "ArrowDown";
    if (!down && event.code !== "ArrowUp") return undefined;
    event.preventDefault();
    const source = sourceOf(context.active?.data.current);
    const { collisionRect, droppableRects } = context;
    if (!source || !collisionRect) return undefined;
    const middle = {
      x: collisionRect.left + collisionRect.width / 2,
      y: collisionRect.top + collisionRect.height / 2,
    };
    // The places outside the tree come after the rows: Pinned, Favorites, then the space icons.
    const away = [
      PINNED_DROP_ID,
      FAVORITES_DROP_ID,
      ...spaces.map((candidate) => outsideId({ kind: "space", spaceId: candidate.id })),
    ].flatMap((id) => {
      const drop = outsideOf(id);
      const rect = droppableRects.get(id);
      if (!drop || !rect || !outsideAction(spaces, favorites, source, drop)) return [];
      return [{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }];
    });
    const centered = (spot: { x: number; y: number }) => ({
      x: spot.x - collisionRect.width / 2,
      y: spot.y - collisionRect.height / 2,
    });
    // The rows keep the column the row was picked up in.
    const column = context.active?.rect.current.initial?.left ?? currentCoordinates.x;
    const rowSpots = dropSlots(space, rows, source).flatMap((slot) => {
      const rect = droppableRects.get(slot.rowId);
      return rect ? [rect.top + slot.fraction * rect.height] : [];
    });
    const onRow = (y: number | undefined) =>
      y === undefined ? undefined : { x: column, y: y - collisionRect.height / 2 };

    const at = away.findIndex(
      (spot) => Math.abs(spot.x - middle.x) < 1 && Math.abs(spot.y - middle.y) < 1,
    );
    if (at >= 0) {
      const neighbor = away[down ? at + 1 : at - 1];
      if (neighbor) return centered(neighbor);
      return down ? undefined : onRow(rowSpots.at(-1));
    }
    // Step to the next place the rule allows, in the direction of the arrow.
    const next = down
      ? rowSpots.find((y) => y > middle.y + 1)
      : rowSpots.findLast((y) => y < middle.y - 1);
    if (next === undefined) {
      const first = down ? away[0] : undefined;
      return first ? centered(first) : undefined;
    }
    return onRow(next);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: ACTIVATION_DISTANCE } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      // Enter keeps activating a tab; only Space picks it up.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const announcements: Announcements = {
    onDragStart: ({ active }) => t("drag.pickedUp", { name: labelOfActive(active) }),
    onDragOver: () => undefined,
    onDragMove: () => undefined,
    onDragEnd: ({ active }) => t("drag.dropped", { name: labelOfActive(active) }),
    onDragCancel: ({ active }) => t("drag.cancelled", { name: labelOfActive(active) }),
  };

  const onDragMove = (event: DragMoveEvent) => {
    const next = placeOf(event);
    if (
      sameTarget(target, next.target) &&
      sameOutside(outside, next.outside) &&
      samePane(pane, next.pane) &&
      swap === next.swap &&
      leaving === next.window
    ) {
      return;
    }
    setPlace(next);
    setStatus(describe(next));
  };

  const clear = () => {
    setDragging(null);
    setPlace(NOWHERE);
    setStatus("");
  };

  const onDragEnd = (event: DragEndEvent) => {
    const dragged = paneSourceOf(event.active.data.current);
    const source = sourceOf(event.active.data.current);
    const landing = placeOf(event);
    clear();
    if (dragged) {
      if (landing.swap !== null) onPaneSwap(dragged.paneId, landing.swap);
      return;
    }
    if (!source) return;
    let action: Action | undefined;
    if (landing.window) onDragOut?.(source.id);
    else if (landing.pane) onPaneDrop(source.id, landing.pane);
    else if (landing.outside) action = outsideAction(spaces, favorites, source, landing.outside);
    else if (landing.target) action = dropAction(space, source, landing.target);
    if (action) onAction(action);
  };

  const onDragStart = (event: DragStartEvent) => {
    setDragging(labelOfActive(event.active));
    setPlace(NOWHERE);
    setStatus("");
  };

  return (
    <DragStateContext
      value={{ target, outside, pane, swap, window: leaving, dragging: dragging !== null }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={rowCollision}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t("drag.instructions") },
        }}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={clear}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {dragging !== null && (
            <div className="drag-ghost" data-nr-part="drag-ghost">
              {dragging}
            </div>
          )}
        </DragOverlay>
        <span id={DRAG_HELP_ID} className="sr-only">
          {t("drag.instructions")}
        </span>
        <div className="sr-only" role="status" aria-live="polite" data-nr-part="drop-status">
          {status}
        </div>
      </DndContext>
    </DragStateContext>
  );
}

/** What a row needs to become the handle of its own drag. */
export interface DragHandle {
  /** Spread on the button that starts the drag. */
  buttonProps: {
    ref(node: HTMLElement | null): void;
    onPointerDown(event: PointerEvent): void;
    "aria-roledescription": string;
  };
  /** Call from the button's own key handler first; Space then picks the row up. */
  onKeyDown(event: KeyboardEvent): void;
  dragging: boolean;
}

interface DragRowProps {
  id: Id;
  kind: DragSource["kind"];
  style?: CSSProperties;
  children(handle: DragHandle): ReactNode;
}

/** A row of the tree that can be dragged and dropped on. */
export function DragRow({ id, kind, style, children }: DragRowProps) {
  const { target } = useContext(DragStateContext);
  const { setNodeRef: setDropRef } = useDroppable({ id });
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id,
    data: { kind, id },
  });
  const mark = target?.rowId === id ? target : null;
  const press = listeners?.["onPointerDown"] as ((event: PointerEvent) => void) | undefined;
  const key = listeners?.["onKeyDown"] as ((event: KeyboardEvent) => void) | undefined;

  const handle: DragHandle = {
    buttonProps: {
      ref: setActivatorNodeRef,
      onPointerDown: (event) => press?.(event),
      "aria-roledescription": attributes["aria-roledescription"],
    },
    onKeyDown: (event) => key?.(event),
    dragging: isDragging,
  };

  return (
    <li ref={setDropRef} role="none" style={style}>
      <div
        ref={setNodeRef}
        className="drag-slot"
        data-nr-state={isDragging ? "dragging" : undefined}
      >
        {children(handle)}
      </div>
      {mark && (
        <span
          className="drop-indicator"
          data-nr-part="drop-indicator"
          data-nr-position={mark.edge}
          aria-hidden="true"
        />
      )}
    </li>
  );
}

/** What a space icon, the Pinned list, the Favorites grid or a zone needs to be a drop place outside the tree. */
export interface OutsideDropHandle {
  ref(node: HTMLElement | null): void;
  /** The dragged tab would land here if dropped now. */
  over: boolean;
}

/** Makes an element a drop place outside the tree; `over` follows the same rule the drop uses. */
export function useOutsideDrop(drop: OutsideDrop): OutsideDropHandle {
  const { outside } = useContext(DragStateContext);
  const { setNodeRef } = useDroppable({ id: outsideId(drop) });
  return { ref: setNodeRef, over: sameOutside(outside, drop) };
}

/** What a pane needs to take the drop of a tab; `zone` is the side the tab would land on. */
export interface PaneDropHandle {
  ref(node: HTMLElement | null): void;
  zone: PaneZone | undefined;
  /** A dragged pane would swap places with this pane if dropped now. */
  swap: boolean;
}

/** Makes a pane a drop place; `zone` and `swap` follow the same rules the drop uses. */
export function usePaneDrop(paneId: Id, enabled: boolean): PaneDropHandle {
  const { pane, swap } = useContext(DragStateContext);
  const { setNodeRef } = useDroppable({ id: paneDropId(paneId), disabled: !enabled });
  return {
    ref: setNodeRef,
    zone: enabled && pane?.paneId === paneId ? pane : undefined,
    swap: enabled && swap === paneId,
  };
}

/** What the title of a pane header needs to drag the pane. */
export interface PaneDragHandle {
  /** Spread on the element that starts the drag (the title, not the buttons). */
  handleProps: {
    ref(node: HTMLElement | null): void;
    onPointerDown(event: PointerEvent): void;
  };
  dragging: boolean;
}

/** Makes the title of a pane header the handle that drags the pane (to swap it with another). */
export function usePaneDrag(paneId: Id, title: string, enabled: boolean): PaneDragHandle {
  const { setActivatorNodeRef, setNodeRef, listeners, isDragging } = useDraggable({
    id: paneDragId(paneId),
    data: { kind: "pane", id: paneId, title },
    disabled: !enabled,
  });
  const press = listeners?.["onPointerDown"] as ((event: PointerEvent) => void) | undefined;
  return {
    // The handle is also the draggable node: the title is all that moves.
    handleProps: {
      ref: (node) => {
        setNodeRef(node);
        setActivatorNodeRef(node);
      },
      onPointerDown: (event) => press?.(event),
    },
    dragging: isDragging,
  };
}

function DropZone({ drop, label }: { drop: OutsideDrop; label: string }) {
  const zone = useOutsideDrop(drop);
  return (
    <div
      ref={zone.ref}
      className="drop-zone"
      data-nr-part={drop.kind === "pinned" ? "drop-pinned" : "drop-favorites"}
      data-nr-state={zone.over ? "over" : undefined}
    >
      {label}
    </div>
  );
}

/** Whether a drag is under way (what the empty-state drop zones wait for). */
export function useDragging(): boolean {
  return useContext(DragStateContext).dragging;
}

interface DropZonesProps {
  /** The Pinned list is empty, so it has no drop place of its own: offer a zone instead. */
  pinned: boolean;
  /** The Favorites grid is empty (and so not on screen): offer a zone instead. */
  favorites: boolean;
}

/**
 * Stand-ins for the Pinned list and the Favorites grid while they are empty. Those two are real
 * drop places only when they hold something, because an empty one takes no room, and making room
 * at the start of a drag would move every row under the pointer. The zones cover the "New tab"
 * button and only show while a drag is under way, so the sidebar at rest looks the same.
 */
export function DropZones({ pinned, favorites }: DropZonesProps) {
  const t = useT();
  const dragging = useDragging();
  if (!pinned && !favorites) return null;
  return (
    <div
      className="drop-zones"
      data-nr-part="drop-zones"
      data-nr-state={dragging ? "dragging" : undefined}
      aria-hidden="true"
    >
      {pinned && <DropZone drop={{ kind: "pinned" }} label={t("tree.pinned")} />}
      {favorites && <DropZone drop={{ kind: "favorites" }} label={t("tree.favorites")} />}
    </div>
  );
}
