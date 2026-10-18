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
import type { Action, Id, Space } from "@noren/model";
import { dropAction, dropSlots, resolveDrop } from "./sidebar-drop";
import type { DragSource, DropTarget } from "./sidebar-drop";
import type { TreeRow } from "./sidebar-tree";

// Drag and drop of the sidebar tree on top of @dnd-kit. The library only moves the pointer (or the
// keyboard cursor) around and reports which row is under it; what that means is `sidebar-drop.ts`.

/** How far (px) the pointer travels before a press becomes a drag, so clicks stay clicks. */
const ACTIVATION_DISTANCE = 6;

/** Id of the text that tells keyboard and screen reader users how to move a row; the list points to it. */
export const DRAG_HELP_ID = "tree-drag-help";

const INSTRUCTIONS =
  "To move this item, press Space. Use the up and down arrow keys to choose a place, Space to drop it there, or Escape to cancel.";

interface DragState {
  target: DropTarget | null;
}

const DragStateContext = createContext<DragState>({ target: null });

/** Where the pointer is, or the middle of the dragged row when the keyboard drives. */
const rowCollision: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
  pointerCoordinates,
}) => {
  const x = pointerCoordinates?.x ?? collisionRect.left + collisionRect.width / 2;
  const y = pointerCoordinates?.y ?? collisionRect.top + collisionRect.height / 2;
  for (const container of droppableContainers) {
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

const sameTarget = (a: DropTarget | null, b: DropTarget | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.rowId === b.rowId &&
    a.edge === b.edge &&
    a.groupId === b.groupId &&
    a.index === b.index);

interface TreeDndProps {
  space: Space;
  rows: readonly TreeRow[];
  /** The name of a tab or group, for what is read aloud. */
  labelOf(id: Id): string;
  /** A drop that changes the tree. */
  onAction(action: Action): void;
  children: ReactNode;
}

/** Wraps the tree with the drag sensors and keeps the place the dragged row would land in. */
export function TreeDnd({ space, rows, labelOf, onAction, children }: TreeDndProps) {
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [status, setStatus] = useState("");
  const [dragging, setDragging] = useState<Id | null>(null);

  const describe = (place: DropTarget | null): string => {
    if (!place) return "No change at this spot.";
    const name = labelOf(place.rowId);
    if (place.edge === "inside") return `Into group ${name}.`;
    return place.edge === "before" ? `Before ${name}.` : `After ${name}.`;
  };

  /** The place under the pointer or keyboard cursor, from the data of a drag event. */
  const targetOf = (event: DragMoveEvent | DragEndEvent): DropTarget | null => {
    const source = sourceOf(event.active.data.current);
    const collision = event.collisions?.[0];
    const { y, top, height } = (collision?.data ?? {}) as Record<string, unknown>;
    if (!source || !collision) return null;
    if (typeof y !== "number" || typeof top !== "number" || typeof height !== "number") return null;
    const fraction = height > 0 ? Math.min(1, Math.max(0, (y - top) / height)) : 0.5;
    return resolveDrop(space, rows, source, String(collision.id), fraction) ?? null;
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
    const middle = collisionRect.top + collisionRect.height / 2;
    // Step to the next place the rule allows, in the direction of the arrow.
    const spots = dropSlots(space, rows, source).flatMap((slot) => {
      const rect = droppableRects.get(slot.rowId);
      return rect ? [rect.top + slot.fraction * rect.height] : [];
    });
    const next = down ? spots.find((y) => y > middle + 1) : spots.findLast((y) => y < middle - 1);
    if (next === undefined) return undefined;
    return { x: currentCoordinates.x, y: next - collisionRect.height / 2 };
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

  const update = (next: DropTarget | null) => {
    setTarget((current) => (sameTarget(current, next) ? current : next));
    setStatus(describe(next));
  };

  const onDragMove = (event: DragMoveEvent) => {
    const next = targetOf(event);
    if (!sameTarget(target, next)) update(next);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const source = sourceOf(event.active.data.current);
    const place = targetOf(event);
    clear();
    const action = source && place ? dropAction(space, source, place) : undefined;
    if (action) onAction(action);
  };

  const onDragStart = (event: DragStartEvent) => {
    setDragging(String(event.active.id));
    setTarget(null);
    setStatus("");
  };

  const clear = () => {
    setDragging(null);
    setTarget(null);
    setStatus("");
  };

  return (
    <DragStateContext value={{ target }}>
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
