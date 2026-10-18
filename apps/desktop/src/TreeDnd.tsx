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
  dropSlots,
  outsideAction,
  outsideId,
  outsideOf,
  resolveDrop,
} from "./sidebar-drop";
import type { DragSource, DropTarget, OutsideDrop } from "./sidebar-drop";
import type { TreeRow } from "./sidebar-tree";
import { spaceItemIds } from "./workspace-store";

// Drag and drop of the sidebar on top of @dnd-kit. The library only moves the pointer (or the
// keyboard cursor) around and reports which droppable is under it; what that means is
// `sidebar-drop.ts`. One context covers the tree, the space icons, the Pinned list and the Favorites grid.

/** How far (px) the pointer travels before a press becomes a drag, so clicks stay clicks. */
const ACTIVATION_DISTANCE = 6;

/** Id of the text that tells keyboard and screen reader users how to move a row; the list points to it. */
export const DRAG_HELP_ID = "tree-drag-help";

const INSTRUCTIONS =
  "To move this item, press Space. Use the up and down arrow keys to choose a place, Space to drop it there, or Escape to cancel.";

interface DragState {
  /** The place in the tree the dragged row would land in. */
  target: DropTarget | null;
  /** The space icon or zone under the pointer, when dropping there would change something. */
  outside: OutsideDrop | null;
  /** Whether a drag is under way (the empty-state drop zones only show then). */
  dragging: boolean;
}

const DragStateContext = createContext<DragState>({
  target: null,
  outside: null,
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
          data: { droppableContainer: container, value: 0, y, top: rect.top, height: rect.height },
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
}

const NOWHERE: Place = { target: null, outside: null };

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
  children: ReactNode;
}

/**
 * Owns the one `DndContext` of the sidebar: it wraps the tree, the Pinned list, the Favorites grid
 * and the space icons, and keeps the place the dragged row would land in.
 */
export function TreeDnd({ spaces, favorites, space, rows, onAction, children }: TreeDndProps) {
  const [place, setPlace] = useState<Place>(NOWHERE);
  const [status, setStatus] = useState("");
  const [dragging, setDragging] = useState<Id | null>(null);
  const { target, outside } = place;

  const order = spaceItemIds(space);
  /** The name of a tab or group, for what is read aloud and shown on the ghost. */
  const labelOf = (id: Id): string => {
    const item = space.items[id];
    if (item) return item.title ?? `Tab ${order.indexOf(id) + 1}`;
    return treeGroups(space.tree).find((group) => group.id === id)?.name ?? id;
  };

  const describe = ({ target: spot, outside: away }: Place): string => {
    if (away) {
      if (away.kind === "pinned") return "Pin this tab.";
      if (away.kind === "favorites") return "Add this tab to the favorites.";
      const name = spaces.find((candidate) => candidate.id === away.spaceId)?.name ?? away.spaceId;
      return `Move to space ${name}.`;
    }
    if (!spot) return "No change at this spot.";
    const name = labelOf(spot.rowId);
    if (spot.edge === "inside") return `Into group ${name}.`;
    return spot.edge === "before" ? `Before ${name}.` : `After ${name}.`;
  };

  /** The place under the pointer or keyboard cursor, from the data of a drag event. */
  const placeOf = (event: DragMoveEvent | DragEndEvent): Place => {
    const source = sourceOf(event.active.data.current);
    const collision = event.collisions?.[0];
    if (!source || !collision) return NOWHERE;
    const away = outsideOf(String(collision.id));
    if (away) {
      const valid = outsideAction(spaces, favorites, source, away) !== undefined;
      return { target: null, outside: valid ? away : null };
    }
    const { y, top, height } = (collision.data ?? {}) as Record<string, unknown>;
    if (typeof y !== "number" || typeof top !== "number" || typeof height !== "number") {
      return NOWHERE;
    }
    const fraction = height > 0 ? Math.min(1, Math.max(0, (y - top) / height)) : 0.5;
    return {
      target: resolveDrop(space, rows, source, String(collision.id), fraction) ?? null,
      outside: null,
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
    onDragStart: ({ active }) => `Picked up ${labelOf(String(active.id))}.`,
    onDragOver: () => undefined,
    onDragMove: () => undefined,
    onDragEnd: ({ active }) => `Dropped ${labelOf(String(active.id))}.`,
    onDragCancel: ({ active }) => `Move of ${labelOf(String(active.id))} cancelled.`,
  };

  const onDragMove = (event: DragMoveEvent) => {
    const next = placeOf(event);
    if (sameTarget(target, next.target) && sameOutside(outside, next.outside)) return;
    setPlace(next);
    setStatus(describe(next));
  };

  const clear = () => {
    setDragging(null);
    setPlace(NOWHERE);
    setStatus("");
  };

  const onDragEnd = (event: DragEndEvent) => {
    const source = sourceOf(event.active.data.current);
    const landing = placeOf(event);
    clear();
    if (!source) return;
    let action: Action | undefined;
    if (landing.outside) action = outsideAction(spaces, favorites, source, landing.outside);
    else if (landing.target) action = dropAction(space, source, landing.target);
    if (action) onAction(action);
  };

  const onDragStart = (event: DragStartEvent) => {
    setDragging(String(event.active.id));
    setPlace(NOWHERE);
    setStatus("");
  };

  return (
    <DragStateContext value={{ target, outside, dragging: dragging !== null }}>
      <DndContext
        sensors={sensors}
        collisionDetection={rowCollision}
        accessibility={{ announcements, screenReaderInstructions: { draggable: INSTRUCTIONS } }}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={clear}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {dragging !== null && (
            <div className="drag-ghost" data-nr-part="drag-ghost">
              {labelOf(dragging)}
            </div>
          )}
        </DragOverlay>
        <span id={DRAG_HELP_ID} className="sr-only">
          {INSTRUCTIONS}
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
    <li ref={setDropRef} style={style}>
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
  const dragging = useDragging();
  if (!pinned && !favorites) return null;
  return (
    <div
      className="drop-zones"
      data-nr-part="drop-zones"
      data-nr-state={dragging ? "dragging" : undefined}
      aria-hidden="true"
    >
      {pinned && <DropZone drop={{ kind: "pinned" }} label="Pinned" />}
      {favorites && <DropZone drop={{ kind: "favorites" }} label="Favorites" />}
    </div>
  );
}
