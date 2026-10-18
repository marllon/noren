import * as fc from "fast-check";
import {
  DEFAULT_MAX_PANES,
  type ArchivedItem,
  type ClosedItem,
  type Id,
  type Item,
  type LastCommand,
  type LayoutNode,
  type Node,
  type Pane,
  type Space,
  type SpaceDefaults,
  type Workspace,
} from "./types";

// Generation is two-step so ids stay stable: fast-check builds id-free "shapes", then a pure,
// deterministic pass walks each shape in order and hands out ids from one counter. Shrinking a
// shape therefore never reuses or shuffles ids by position in a collection.

type Maybe<T> = T | undefined;

interface PaneShape {
  profileId: string;
  cwd: Maybe<string>;
  status: Pane["status"];
  exitCode: number;
  lastCommand: Maybe<{ text: Maybe<string>; exitCode: Maybe<number>; durationMs: Maybe<number> }>;
  unread: boolean;
  bell: boolean;
  hasSession: boolean;
  scrollbackRef: Maybe<string>;
}

type LayoutShape =
  | { kind: "pane"; pane: PaneShape }
  | { kind: "split"; dir: "row" | "column"; weights: number[]; children: LayoutShape[] };

interface ItemShape {
  title: Maybe<string>;
  titleLocked: boolean;
  layout: LayoutShape;
  focusIndex: number;
  zoomIndex: Maybe<number>;
  origin: Maybe<{ cwd: string; profileId: string; command: Maybe<string> }>;
  lastActivityAt: number;
  favorite: boolean;
}

type TreeShape =
  | { kind: "item"; item: ItemShape }
  | { kind: "group"; name: string; color: string; collapsed: boolean; children: TreeShape[] };

interface SpaceShape {
  name: string;
  icon: string;
  color: string;
  themeId: Maybe<string>;
  modIds: string[];
  defaults: {
    profileId: Maybe<string>;
    cwd: Maybe<string>;
    env: Record<string, string>;
    gitIdentity: Maybe<{ name: string; email: string }>;
  };
  aiEnabled: boolean;
  saveScrollback: boolean;
  pinned: ItemShape[];
  tree: TreeShape[];
}

interface ArchivedShape {
  item: ItemShape;
  spaceIndex: number;
  at: number;
}

interface WorkspaceShape {
  spaces: SpaceShape[];
  activeIndex: number;
  closed: ArchivedShape[];
  archive: ArchivedShape[];
}

const optional = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<Maybe<T>> =>
  fc.option(arb, { nil: undefined });

const arbText = fc.string({ minLength: 1, maxLength: 12 });
const arbProfile = fc.constantFrom("pwsh", "cmd", "bash", "zsh", "wsl:Ubuntu");
const arbCwd = fc.constantFrom("/home/user", "/tmp", "C:\\Projects\\noren", "~/proj");
const arbColor = fc.constantFrom("#6b8afd", "#e06c75", "#98c379", "#e5c07b", "red", "teal");

const arbPaneShape: fc.Arbitrary<PaneShape> = fc.record({
  profileId: arbProfile,
  cwd: optional(arbCwd),
  status: fc.constantFrom("running", "idle", "exited"),
  exitCode: fc.integer({ min: 0, max: 255 }),
  lastCommand: optional(
    fc.record({
      text: optional(arbText),
      exitCode: optional(fc.integer({ min: 0, max: 255 })),
      durationMs: optional(fc.nat({ max: 600_000 })),
    }),
  ),
  unread: fc.boolean(),
  bell: fc.boolean(),
  hasSession: fc.boolean(),
  scrollbackRef: optional(fc.constantFrom("sb-1.bin", "sb-2.bin")),
});

/** Splits `total` into `parts` positive integers. */
const arbPartition = (total: number, parts: number): fc.Arbitrary<number[]> =>
  fc
    .uniqueArray(fc.integer({ min: 1, max: total - 1 }), {
      minLength: parts - 1,
      maxLength: parts - 1,
    })
    .map((cuts) => {
      const sorted = [0, ...cuts.toSorted((a, b) => a - b), total];
      return sorted.slice(1).map((cut, index) => cut - (sorted[index] ?? 0));
    });

/** A layout with exactly `leaves` panes; every split has at least 2 children. */
const arbLayoutShape = (leaves: number): fc.Arbitrary<LayoutShape> => {
  if (leaves <= 1) {
    return arbPaneShape.map((pane): LayoutShape => ({ kind: "pane", pane }));
  }
  return fc
    .integer({ min: 2, max: leaves })
    .chain((count) =>
      fc
        .tuple(
          arbPartition(leaves, count),
          fc.constantFrom<"row" | "column">("row", "column"),
          fc.array(fc.integer({ min: 1, max: 10 }), { minLength: count, maxLength: count }),
        )
        .chain(([parts, dir, weights]) =>
          fc
            .tuple(...parts.map(arbLayoutShape))
            .map((children): LayoutShape => ({ kind: "split", dir, weights, children })),
        ),
    );
};

const arbItemShape = (maxPanes: number): fc.Arbitrary<ItemShape> =>
  fc.record({
    title: optional(arbText),
    titleLocked: fc.boolean(),
    layout: fc.integer({ min: 1, max: maxPanes }).chain(arbLayoutShape),
    focusIndex: fc.nat({ max: 7 }),
    zoomIndex: optional(fc.nat({ max: 7 })),
    origin: optional(fc.record({ cwd: arbCwd, profileId: arbProfile, command: optional(arbText) })),
    lastActivityAt: fc.nat({ max: 2_000_000_000_000 }),
    favorite: fc.boolean(),
  });

/** Sidebar nodes; `groupLevels` is how many more levels of groups may open (2 at the top). */
const arbTreeShapes = (maxPanes: number, groupLevels: number): fc.Arbitrary<TreeShape[]> => {
  const item = arbItemShape(maxPanes).map((it): TreeShape => ({ kind: "item", item: it }));
  const node =
    groupLevels > 0
      ? fc.oneof(
          { weight: 3, arbitrary: item },
          {
            weight: 1,
            arbitrary: fc
              .record({
                name: arbText,
                color: arbColor,
                collapsed: fc.boolean(),
                children: arbTreeShapes(maxPanes, groupLevels - 1),
              })
              .map((group): TreeShape => ({ kind: "group", ...group })),
          },
        )
      : item;
  return fc.array(node, { maxLength: 4 });
};

const arbSpaceShape = (maxPanes: number): fc.Arbitrary<SpaceShape> =>
  fc.record({
    name: arbText,
    icon: fc.constantFrom("terminal", "rocket", "🚀", "folder"),
    color: arbColor,
    themeId: optional(fc.constantFrom("dark", "light")),
    modIds: fc.uniqueArray(fc.constantFrom("mod-a", "mod-b", "mod-c"), { maxLength: 3 }),
    defaults: fc.record({
      profileId: optional(arbProfile),
      cwd: optional(arbCwd),
      env: fc.dictionary(fc.constantFrom("EDITOR", "LANG", "PATH"), fc.string({ maxLength: 8 }), {
        maxKeys: 3,
      }),
      gitIdentity: optional(fc.record({ name: arbText, email: arbText })),
    }),
    aiEnabled: fc.boolean(),
    saveScrollback: fc.boolean(),
    pinned: fc.array(arbItemShape(maxPanes), { maxLength: 3 }),
    tree: arbTreeShapes(maxPanes, 2),
  });

const arbArchivedShape = (maxPanes: number): fc.Arbitrary<ArchivedShape> =>
  fc.record({
    item: arbItemShape(maxPanes),
    spaceIndex: fc.nat({ max: 7 }),
    at: fc.nat({ max: 2_000_000_000_000 }),
  });

const arbWorkspaceShape = (maxPanes: number): fc.Arbitrary<WorkspaceShape> =>
  fc.record({
    spaces: fc.array(arbSpaceShape(maxPanes), { minLength: 1, maxLength: 3 }),
    activeIndex: fc.nat({ max: 7 }),
    closed: fc.array(arbArchivedShape(maxPanes), { maxLength: 3 }),
    archive: fc.array(arbArchivedShape(maxPanes), { maxLength: 3 }),
  });

/** Element at `index` wrapped around the length; the lists used here are never empty. */
function nth<T>(list: T[], index: number): T {
  const value = list[index % list.length];
  if (value === undefined) throw new Error("empty list");
  return value;
}

/** Turns shapes into model values, handing out ids in traversal order. */
class Builder {
  #next = 0;
  readonly favorites: Id[] = [];

  /** One counter for the whole workspace; the prefix keeps kinds apart. */
  id(kind: string): Id {
    return `${kind}${++this.#next}`;
  }

  pane(shape: PaneShape): Pane {
    const exited = shape.status === "exited";
    const last = shape.lastCommand;
    const lastCommand: LastCommand | undefined = last && {
      ...(last.text !== undefined ? { text: last.text } : {}),
      ...(last.exitCode !== undefined ? { exitCode: last.exitCode } : {}),
      ...(last.durationMs !== undefined ? { durationMs: last.durationMs } : {}),
    };
    return {
      id: this.id("p"),
      type: "terminal",
      ...(shape.hasSession ? { sessionId: this.id("x") } : {}),
      profileId: shape.profileId,
      ...(shape.cwd !== undefined ? { cwd: shape.cwd } : {}),
      status: shape.status,
      ...(exited ? { exitCode: shape.exitCode } : {}),
      ...(lastCommand ? { lastCommand } : {}),
      unread: shape.unread,
      bell: shape.bell,
      ...(shape.scrollbackRef !== undefined ? { scrollbackRef: shape.scrollbackRef } : {}),
    };
  }

  layout(shape: LayoutShape, panes: Pane[]): LayoutNode {
    if (shape.kind === "pane") {
      const pane = this.pane(shape.pane);
      panes.push(pane);
      return { kind: "pane", pane };
    }
    const total = shape.weights.reduce((sum, w) => sum + w, 0);
    const sizes = shape.weights.map((w) => (w * 100) / total);
    // Close the sum exactly: the last size absorbs the floating-point remainder.
    sizes[sizes.length - 1] = 100 - sizes.slice(0, -1).reduce((sum, s) => sum + s, 0);
    return {
      kind: "split",
      dir: shape.dir,
      sizes,
      children: shape.children.map((child) => this.layout(child, panes)),
    };
  }

  item(shape: ItemShape): Item {
    const id = this.id("i");
    const panes: Pane[] = [];
    const layout = this.layout(shape.layout, panes);
    const pick = (index: number): Id => nth(panes, index).id;
    const origin = shape.origin;
    return {
      id,
      ...(shape.title !== undefined ? { title: shape.title } : {}),
      titleLocked: shape.titleLocked,
      layout,
      focusedPaneId: pick(shape.focusIndex),
      ...(shape.zoomIndex !== undefined ? { zoomedPaneId: pick(shape.zoomIndex) } : {}),
      ...(origin
        ? {
            origin: {
              cwd: origin.cwd,
              profileId: origin.profileId,
              ...(origin.command !== undefined ? { command: origin.command } : {}),
            },
          }
        : {}),
      lastActivityAt: shape.lastActivityAt,
    };
  }

  space(shape: SpaceShape): Space {
    const id = this.id("s");
    const items: Record<Id, Item> = {};
    const add = (itemShape: ItemShape): Id => {
      const item = this.item(itemShape);
      items[item.id] = item;
      if (itemShape.favorite) this.favorites.push(item.id);
      return item.id;
    };
    const pinned = shape.pinned.map(add);
    const node = (tree: TreeShape): Node => {
      if (tree.kind === "item") return { kind: "item", id: add(tree.item) };
      const groupId = this.id("g");
      return {
        kind: "group",
        id: groupId,
        name: tree.name,
        color: tree.color,
        collapsed: tree.collapsed,
        children: tree.children.map(node),
      };
    };
    const tree = shape.tree.map(node);
    const d = shape.defaults;
    const defaults: SpaceDefaults = {
      ...(d.profileId !== undefined ? { profileId: d.profileId } : {}),
      ...(d.cwd !== undefined ? { cwd: d.cwd } : {}),
      env: d.env,
      ...(d.gitIdentity ? { gitIdentity: d.gitIdentity } : {}),
    };
    return {
      id,
      name: shape.name,
      icon: shape.icon,
      color: shape.color,
      ...(shape.themeId !== undefined ? { themeId: shape.themeId } : {}),
      modIds: shape.modIds,
      defaults,
      aiEnabled: shape.aiEnabled,
      saveScrollback: shape.saveScrollback,
      pinned,
      tree,
      items,
    };
  }

  workspace(shape: WorkspaceShape): Workspace {
    const spaces = shape.spaces.map((s) => this.space(s));
    const spaceIdAt = (index: number): Id => nth(spaces, index).id;
    const closed: ClosedItem[] = shape.closed.map((c) => ({
      item: this.item(c.item),
      spaceId: spaceIdAt(c.spaceIndex),
      closedAt: c.at,
    }));
    const archive: ArchivedItem[] = shape.archive.map((a) => ({
      item: this.item(a.item),
      spaceId: spaceIdAt(a.spaceIndex),
      archivedAt: a.at,
    }));
    return {
      version: 1,
      spaces,
      activeSpaceId: spaceIdAt(shape.activeIndex),
      favorites: this.favorites,
      closed,
      archive,
    };
  }
}

export interface WorkspaceArbitraryOptions {
  /** Most panes per item. Defaults to 4; must be at least 1. */
  maxPanes?: number;
}

/**
 * Arbitrary of valid workspaces: 1 to 3 spaces with pinned items, groups nested up to 2 levels,
 * splits of 2 to `maxPanes` panes (nested too), favorites, and closed and archived items.
 * Every generated value has no violation under `checkInvariants`.
 */
export function arbWorkspace(options: WorkspaceArbitraryOptions = {}): fc.Arbitrary<Workspace> {
  const maxPanes = Math.max(1, options.maxPanes ?? DEFAULT_MAX_PANES);
  return arbWorkspaceShape(maxPanes).map((shape) => new Builder().workspace(shape));
}
