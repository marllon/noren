import {
  DEFAULT_MAX_PANES,
  MAX_CLOSED,
  MAX_GROUP_DEPTH,
  type Id,
  type Item,
  type LayoutNode,
  type Node,
  type Workspace,
} from "./types";

/** Floating-point slack allowed when checking that split sizes sum to 100. */
export const SIZE_SUM_TOLERANCE = 1e-6;

export type ViolationCode =
  | "malformed"
  | "duplicate-id"
  | "pane-in-multiple-items"
  | "session-shared"
  | "active-space-missing"
  | "active-item-missing"
  | "item-key-mismatch"
  | "item-unplaced"
  | "item-duplicated"
  | "dangling-reference"
  | "group-too-deep"
  | "split-too-few-children"
  | "split-too-many-panes"
  | "split-sizes-length"
  | "split-size-not-positive"
  | "split-sizes-sum"
  | "focused-pane-missing"
  | "zoomed-pane-missing"
  | "favorite-missing"
  | "favorite-duplicate"
  | "closed-overflow";

export interface Violation {
  code: ViolationCode;
  /** Where in the workspace, e.g. `spaces[0].items.i1.layout.children[1]`. */
  path: string;
  message: string;
}

export interface InvariantOptions {
  /** Most panes one item may hold. Defaults to `DEFAULT_MAX_PANES` (4). */
  maxPanes?: number;
}

interface IdOwner {
  kind: "space" | "item" | "group" | "pane";
  /** The item that owns the id (panes) or the id's own path (others). */
  owner: string;
}

/**
 * Checks every structural invariant of a workspace and returns the violations (empty = valid).
 * Never throws: input that cannot even be walked yields a single `malformed` violation.
 */
export function checkInvariants(ws: Workspace, opts: InvariantOptions = {}): Violation[] {
  const violations: Violation[] = [];
  try {
    run(ws, opts.maxPanes ?? DEFAULT_MAX_PANES, violations);
  } catch (error) {
    violations.push({
      code: "malformed",
      path: "",
      message: `workspace cannot be traversed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return violations;
}

function run(ws: Workspace, maxPanes: number, out: Violation[]): void {
  const add = (code: ViolationCode, path: string, message: string): void => {
    out.push({ code, path, message });
  };

  // Ids are unique across spaces, items, groups and panes (closed and archived items included).
  const ids = new Map<Id, IdOwner>();
  const register = (kind: IdOwner["kind"], id: Id, path: string, owner: string): void => {
    const previous = ids.get(id);
    if (!previous) {
      ids.set(id, { kind, owner });
    } else if (kind === "pane" && previous.kind === "pane" && previous.owner !== owner) {
      add("pane-in-multiple-items", path, `pane ${id} is in ${previous.owner} and in ${owner}`);
    } else {
      add("duplicate-id", path, `id ${id} is used by a ${previous.kind} and by a ${kind}`);
    }
  };
  const sessions = new Map<Id, string>();

  const checkLayout = (layout: LayoutNode, path: string, owner: string, panes: Id[]): void => {
    if (layout.kind === "pane") {
      register("pane", layout.pane.id, `${path}.pane`, owner);
      panes.push(layout.pane.id);
      const sessionId = layout.pane.sessionId;
      if (sessionId !== undefined) {
        const holder = sessions.get(sessionId);
        if (holder !== undefined) {
          add(
            "session-shared",
            `${path}.pane`,
            `session ${sessionId} is used by panes ${holder} and ${layout.pane.id}`,
          );
        } else {
          sessions.set(sessionId, layout.pane.id);
        }
      }
      return;
    }
    if (layout.children.length < 2) {
      add(
        "split-too-few-children",
        path,
        `split has ${layout.children.length} children, needs at least 2`,
      );
    }
    if (layout.sizes.length !== layout.children.length) {
      add(
        "split-sizes-length",
        path,
        `split has ${layout.children.length} children but ${layout.sizes.length} sizes`,
      );
    }
    if (layout.sizes.some((size) => !(size > 0))) {
      add("split-size-not-positive", path, `split sizes must be positive: ${layout.sizes.join()}`);
    }
    const total = layout.sizes.reduce((sum, size) => sum + size, 0);
    if (!(Math.abs(total - 100) <= SIZE_SUM_TOLERANCE)) {
      add("split-sizes-sum", path, `split sizes sum to ${total}, not 100`);
    }
    layout.children.forEach((child, index) => {
      checkLayout(child, `${path}.children[${index}]`, owner, panes);
    });
  };

  const checkItem = (item: Item, path: string): void => {
    register("item", item.id, path, item.id);
    const panes: Id[] = [];
    checkLayout(item.layout, `${path}.layout`, item.id, panes);
    if (panes.length > maxPanes) {
      add(
        "split-too-many-panes",
        `${path}.layout`,
        `item has ${panes.length} panes, max ${maxPanes}`,
      );
    }
    if (!panes.includes(item.focusedPaneId)) {
      add("focused-pane-missing", path, `focused pane ${item.focusedPaneId} is not in the item`);
    }
    if (item.zoomedPaneId !== undefined && !panes.includes(item.zoomedPaneId)) {
      add("zoomed-pane-missing", path, `zoomed pane ${item.zoomedPaneId} is not in the item`);
    }
  };

  ws.spaces.forEach((space, spaceIndex) => {
    const spacePath = `spaces[${spaceIndex}]`;
    register("space", space.id, spacePath, space.id);

    // The item a space shows must be one of its own.
    if (space.activeItemId !== undefined && !Object.hasOwn(space.items, space.activeItemId)) {
      add(
        "active-item-missing",
        `${spacePath}.activeItemId`,
        `active item ${space.activeItemId} is not an item of space ${space.id}`,
      );
    }

    for (const [key, item] of Object.entries(space.items)) {
      if (key !== item.id) {
        add(
          "item-key-mismatch",
          `${spacePath}.items.${key}`,
          `item ${item.id} is stored under ${key}`,
        );
      }
      checkItem(item, `${spacePath}.items.${key}`);
    }

    // Placement: every item exactly once among pinned and tree; nothing points at a missing item.
    const placed = new Map<Id, number>();
    const reference = (id: Id, path: string): void => {
      if (!Object.hasOwn(space.items, id)) {
        add("dangling-reference", path, `${id} is not an item of space ${space.id}`);
      }
      placed.set(id, (placed.get(id) ?? 0) + 1);
    };
    space.pinned.forEach((id, index) => {
      reference(id, `${spacePath}.pinned[${index}]`);
    });
    const walkTree = (nodes: Node[], path: string, depth: number): void => {
      nodes.forEach((node, index) => {
        const nodePath = `${path}[${index}]`;
        if (node.kind === "item") {
          reference(node.id, nodePath);
          return;
        }
        register("group", node.id, nodePath, node.id);
        if (depth > MAX_GROUP_DEPTH) {
          add(
            "group-too-deep",
            nodePath,
            `group ${node.id} is at depth ${depth}, max ${MAX_GROUP_DEPTH}`,
          );
        }
        walkTree(node.children, `${nodePath}.children`, depth + 1);
      });
    };
    walkTree(space.tree, `${spacePath}.tree`, 1);

    for (const id of Object.keys(space.items)) {
      const count = placed.get(id) ?? 0;
      if (count === 0) {
        add(
          "item-unplaced",
          `${spacePath}.items.${id}`,
          `item ${id} is neither pinned nor in the tree`,
        );
      }
    }
    for (const [id, count] of placed) {
      if (count > 1 && Object.hasOwn(space.items, id)) {
        add("item-duplicated", spacePath, `item ${id} appears ${count} times in pinned and tree`);
      }
    }
  });

  ws.closed.forEach((entry, index) => {
    checkItem(entry.item, `closed[${index}].item`);
  });
  ws.archive.forEach((entry, index) => {
    checkItem(entry.item, `archive[${index}].item`);
  });

  if (!ws.spaces.some((space) => space.id === ws.activeSpaceId)) {
    add("active-space-missing", "activeSpaceId", `active space ${ws.activeSpaceId} does not exist`);
  }

  const seenFavorites = new Set<Id>();
  ws.favorites.forEach((id, index) => {
    const path = `favorites[${index}]`;
    if (!ws.spaces.some((space) => Object.hasOwn(space.items, id))) {
      add("favorite-missing", path, `favorite ${id} is not an item of any space`);
    }
    if (seenFavorites.has(id)) {
      add("favorite-duplicate", path, `favorite ${id} is listed twice`);
    }
    seenFavorites.add(id);
  });

  if (ws.closed.length > MAX_CLOSED) {
    add("closed-overflow", "closed", `closed holds ${ws.closed.length} items, max ${MAX_CLOSED}`);
  }
}
