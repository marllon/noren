import * as fc from "fast-check";
import type { Action, Placement } from "./actions";
import { splitAt, splitPaths } from "./layout";
import { layoutPanes } from "./sessions";
import { treeGroups, treeItemIds } from "./tree";
import type { Id, Item, Workspace } from "./types";

const tag = <T extends string>(type: T): fc.Arbitrary<T> => fc.constant(type);

/** An id that is in no workspace. */
const arbGhost = fc.constantFrom("ghost-1", "ghost-2");

/** An id of the list most of the time, now and then one the workspace does not have. */
const arbIdOf = (ids: readonly Id[]): fc.Arbitrary<Id> =>
  ids.length === 0
    ? arbGhost
    : fc.oneof(
        { weight: 12, arbitrary: fc.constantFrom(...ids) },
        { weight: 1, arbitrary: arbGhost },
      );

/** Mostly real names; a blank one now and then. */
const arbName = fc.oneof(
  { weight: 8, arbitrary: fc.stringMatching(/^[A-Za-z0-9]{1,8}$/) },
  { weight: 1, arbitrary: fc.constantFrom("", "   ") },
);
const arbColor = fc.constantFrom("#6b8afd", "#e06c75", "teal", "red");
const arbIcon = fc.constantFrom("terminal", "rocket", "folder");
/** A theme id, `null` (back to the global theme) or a blank one now and then. */
const arbThemeId = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom("noren-dusk", "noren-paper", "from-a-later-build") },
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constantFrom("", "  ") },
);
/** Lists of mod names: mostly valid ones, repeats and names that are not mod names now and then. */
const arbModIds = fc.array(
  fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom("mod-a.css", "mod-b.css", "mod-c.css") },
    { weight: 1, arbitrary: fc.constantFrom("", "../x.css", "con.css", "Mod B.css", "mod-a") },
  ),
  { maxLength: 5 },
);
/** A background, a blank one, one that is not a path to a picture, or `null` (back to the settings). */
const arbBackground = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record(
      {
        image: fc.constantFrom("C:\\Pictures\\sky.png", "/home/me/sky.jpg", "backgrounds/sky.webp"),
        opacity: fc.double({ min: -1, max: 2, noNaN: true }),
        blur: fc.double({ min: -10, max: 150, noNaN: true }),
      },
      { requiredKeys: ["image"] },
    ),
  },
  { weight: 2, arbitrary: fc.constant(null) },
  {
    weight: 1,
    arbitrary: fc.record({
      image: fc.constantFrom("", "  ", "https://example.com/a.png", "notes.txt"),
    }),
  },
);
const arbProfile = fc.constantFrom("pwsh", "bash", "wsl:Ubuntu");
const arbProfileOrBlank = fc.oneof(
  { weight: 3, arbitrary: arbProfile },
  { weight: 1, arbitrary: fc.constant("") },
);
/** Mostly valid environments, now and then one with a name the reducer refuses. */
const arbEnv = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.dictionary(
      fc.constantFrom("EDITOR", "LANG", "NOREN_X"),
      fc.string({ maxLength: 6 }),
      {
        maxKeys: 3,
      },
    ),
  },
  { weight: 1, arbitrary: fc.constant({ "BAD=NAME": "x" }) },
);
/** An identity, a blank one (clears it) or, now and then, one the reducer refuses. */
const arbIdentity = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      name: fc.constantFrom("Ada", " Grace ", ""),
      email: fc.constantFrom("ada@example.com", ""),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ name: "", email: "" }) },
  { weight: 1, arbitrary: fc.constant({ name: "A\u0000B", email: "a@x.io" }) },
);
const arbCwd = fc.constantFrom("/home/user", "C:\\Projects\\noren", "~/proj");
/** Reaches both ends and a little past them. */
const arbIndex = fc.integer({ min: -1, max: 8 });

/**
 * Actions that make sense for `ws` as it is now: targets are ids that exist in it (with a few
 * made-up ones mixed in so the invalid paths run too). Built from the state, never from loose
 * positions, so a generated sequence has to be played step by step, asking for the next action
 * with the workspace the previous one produced (`fc.gen()` does that).
 */
export function arbAction(ws: Workspace): fc.Arbitrary<Action> {
  const spaceIds = ws.spaces.map((space) => space.id);
  const itemIds = ws.spaces.flatMap((space) => Object.keys(space.items));
  const groupIds = ws.spaces.flatMap((space) => treeGroups(space.tree).map((group) => group.id));
  const closedIds = ws.closed.map((entry) => entry.item.id);

  const spaceId = arbIdOf(spaceIds);
  const itemId = arbIdOf(itemIds);
  const groupId = arbIdOf(groupIds);

  const placement: fc.Arbitrary<Placement> = fc.oneof(
    fc.record({ to: tag("pinned"), index: arbIndex }, { requiredKeys: ["to"] }),
    fc.record({ to: tag("tree"), groupId, index: arbIndex }, { requiredKeys: ["to"] }),
  );

  // Selections to group: mostly tree items of one real space, sometimes any mix of ids.
  const sameSpaceSelection: fc.Arbitrary<Id[]> =
    ws.spaces.length === 0
      ? fc.constant([])
      : fc.constantFrom(...ws.spaces).chain((space) => {
          const ids = treeItemIds(space.tree);
          return ids.length === 0 ? fc.constant<Id[]>([]) : fc.subarray(ids, { minLength: 1 });
        });
  const anySelection = fc.subarray(itemIds);
  const itemIdList: fc.Arbitrary<Id[]> = fc.oneof(
    { weight: 6, arbitrary: sameSpaceSelection },
    { weight: 1, arbitrary: anySelection },
  );

  // Splits: an item with one of its panes (mostly real, now and then a made-up id).
  const items = ws.spaces.flatMap((space) => Object.values(space.items));
  const paneIds = items.flatMap((item) => layoutPanes(item.layout).map((pane) => pane.id));
  const paneOf = (item: Item): fc.Arbitrary<Id> =>
    arbIdOf(layoutPanes(item.layout).map((pane) => pane.id));
  const target: fc.Arbitrary<{ itemId: Id; paneId: Id }> =
    items.length === 0
      ? fc.record({ itemId: arbGhost, paneId: arbGhost })
      : fc.oneof(
          {
            weight: 12,
            arbitrary: fc
              .constantFrom(...items)
              .chain((item) => paneOf(item).map((paneId) => ({ itemId: item.id, paneId }))),
          },
          { weight: 1, arbitrary: fc.record({ itemId, paneId: arbIdOf(paneIds) }) },
        );
  const dir = fc.constantFrom("row", "column");
  const side = fc.constantFrom("before", "after");
  const direction = fc.constantFrom("left", "right", "up", "down");

  /** Sizes for a split of an item: mostly the right count, positive; sometimes broken ones. */
  const resize: fc.Arbitrary<Action> =
    items.length === 0
      ? fc.constant({ type: "pane/resize", itemId: "ghost-1", path: [], sizes: [1, 1] })
      : fc.constantFrom(...items).chain((item) => {
          const paths = splitPaths(item.layout);
          if (paths.length === 0) {
            return fc.constant<Action>({
              type: "pane/resize",
              itemId: item.id,
              path: [],
              sizes: [1],
            });
          }
          return fc.constantFrom(...paths).chain((path) => {
            const count = splitAt(item.layout, path)?.children.length ?? 2;
            const weight = fc.double({ min: 0.05, max: 1000, noNaN: true });
            const sizes = fc.oneof(
              { weight: 10, arbitrary: fc.array(weight, { minLength: count, maxLength: count }) },
              { weight: 1, arbitrary: fc.array(weight, { minLength: 1, maxLength: 5 }) },
              {
                weight: 1,
                arbitrary: fc.array(fc.constantFrom(0, -1, Number.NaN, Infinity), {
                  minLength: count,
                  maxLength: count,
                }),
              },
            );
            return sizes.map((s): Action => ({
              type: "pane/resize",
              itemId: item.id,
              path,
              sizes: s,
            }));
          });
        });

  const weighted = (weight: number, arbitrary: fc.Arbitrary<Action>) => ({ weight, arbitrary });

  return fc.oneof(
    // Spaces
    weighted(
      1,
      fc.record(
        {
          type: tag("space/create"),
          name: arbName,
          icon: arbIcon,
          color: arbColor,
          profileId: arbProfile,
          cwd: arbCwd,
          env: arbEnv,
          activate: fc.boolean(),
        },
        { requiredKeys: ["type", "name"] },
      ),
    ),
    weighted(
      1,
      fc.record(
        {
          type: tag("space/set-defaults"),
          spaceId,
          profileId: arbProfileOrBlank,
          cwd: arbCwd,
          env: arbEnv,
          gitIdentity: arbIdentity,
        },
        { requiredKeys: ["type", "spaceId"] },
      ),
    ),
    weighted(1, fc.record({ type: tag("space/rename"), spaceId, name: arbName })),
    weighted(1, fc.record({ type: tag("space/set-color"), spaceId, color: arbColor })),
    weighted(1, fc.record({ type: tag("space/set-icon"), spaceId, icon: arbIcon })),
    weighted(1, fc.record({ type: tag("space/set-theme"), spaceId, themeId: arbThemeId })),
    weighted(
      1,
      fc.record({ type: tag("space/set-background"), spaceId, background: arbBackground }),
    ),
    weighted(1, fc.record({ type: tag("space/set-mods"), spaceId, modIds: arbModIds })),
    weighted(1, fc.record({ type: tag("space/move"), spaceId, index: arbIndex })),
    weighted(2, fc.record({ type: tag("space/activate"), spaceId })),
    weighted(
      3,
      fc.oneof(
        // An item of its own space, mostly; any pair of ids now and then.
        {
          weight: 8,
          arbitrary:
            ws.spaces.length === 0
              ? fc.constant<Action>({
                  type: "space/set-active-item",
                  spaceId: "ghost-1",
                  itemId: "ghost-1",
                })
              : fc.constantFrom(...ws.spaces).chain((space) => {
                  const own = Object.keys(space.items);
                  return fc.record({
                    type: tag("space/set-active-item"),
                    spaceId: fc.constant(space.id),
                    itemId: arbIdOf(own),
                  });
                }),
        },
        {
          weight: 1,
          arbitrary: fc.record({ type: tag("space/set-active-item"), spaceId, itemId }),
        },
      ),
    ),
    weighted(
      1,
      fc.record({
        type: tag("space/delete"),
        spaceId,
        items: fc.oneof(
          fc.record({ mode: tag("move"), targetSpaceId: spaceId }),
          fc.record({ mode: tag("close") }),
        ),
      }),
    ),
    // Items
    weighted(
      6,
      fc.record(
        {
          type: tag("item/create"),
          spaceId,
          profileId: arbProfile,
          cwd: arbCwd,
          placement,
        },
        { requiredKeys: ["type"] },
      ),
    ),
    weighted(3, fc.record({ type: tag("item/close"), itemId })),
    weighted(
      3,
      fc.record(
        { type: tag("item/reopen"), itemId: arbIdOf(closedIds) },
        { requiredKeys: ["type"] },
      ),
    ),
    weighted(
      2,
      fc.record(
        {
          type: tag("item/rename"),
          itemId,
          title: arbName,
          source: fc.constantFrom("user", "process"),
        },
        { requiredKeys: ["type", "itemId", "title"] },
      ),
    ),
    weighted(
      4,
      fc.record(
        { type: tag("item/move"), itemId, spaceId, placement },
        { requiredKeys: ["type", "itemId"] },
      ),
    ),
    weighted(
      2,
      fc.record(
        { type: tag("item/pin"), itemId, index: arbIndex },
        { requiredKeys: ["type", "itemId"] },
      ),
    ),
    weighted(
      2,
      fc.record(
        { type: tag("item/unpin"), itemId, index: arbIndex },
        { requiredKeys: ["type", "itemId"] },
      ),
    ),
    weighted(2, fc.record({ type: tag("item/reset"), itemId })),
    weighted(2, fc.record({ type: tag("item/favorite"), itemId })),
    weighted(1, fc.record({ type: tag("item/unfavorite"), itemId })),
    // Groups
    weighted(
      2,
      fc.record(
        {
          type: tag("group/create"),
          spaceId,
          name: arbName,
          color: arbColor,
          parentGroupId: groupId,
          index: arbIndex,
        },
        { requiredKeys: ["type", "name"] },
      ),
    ),
    weighted(
      3,
      fc.record(
        {
          type: tag("group/create-from-selection"),
          itemIds: itemIdList,
          name: arbName,
          color: arbColor,
        },
        { requiredKeys: ["type", "itemIds", "name"] },
      ),
    ),
    weighted(2, fc.record({ type: tag("group/ungroup"), groupId })),
    weighted(
      3,
      fc.record(
        { type: tag("group/move"), groupId, parentGroupId: groupId, index: arbIndex },
        { requiredKeys: ["type", "groupId"] },
      ),
    ),
    weighted(1, fc.record({ type: tag("group/set-collapsed"), groupId, collapsed: fc.boolean() })),
    weighted(1, fc.record({ type: tag("group/rename"), groupId, name: arbName })),
    weighted(1, fc.record({ type: tag("group/set-color"), groupId, color: arbColor })),
    // Splits
    weighted(
      7,
      target.chain(({ itemId, paneId }) =>
        fc.record(
          {
            type: tag("pane/split"),
            itemId: fc.constant(itemId),
            paneId: fc.constant(paneId),
            dir,
            side,
            profileId: arbProfile,
            cwd: arbCwd,
          },
          { requiredKeys: ["type", "itemId", "paneId", "dir", "side"] },
        ),
      ),
    ),
    weighted(
      4,
      target.map(({ itemId, paneId }): Action => ({ type: "pane/close", itemId, paneId })),
    ),
    weighted(
      3,
      target.map(({ itemId, paneId }): Action => ({ type: "pane/detach", itemId, paneId })),
    ),
    weighted(
      4,
      target.chain(({ itemId: targetItemId, paneId: targetPaneId }) =>
        fc.record({
          type: tag("item/join"),
          itemId,
          targetItemId: fc.constant(targetItemId),
          targetPaneId: fc.constant(targetPaneId),
          dir,
          side,
        }),
      ),
    ),
    weighted(4, resize),
    weighted(
      3,
      target.chain(({ itemId, paneId }) =>
        fc.record(
          { type: tag("pane/zoom"), itemId: fc.constant(itemId), paneId: fc.constant(paneId) },
          { requiredKeys: ["type", "itemId"] },
        ),
      ),
    ),
    weighted(
      3,
      items.length === 0
        ? fc.constant({
            type: "pane/swap",
            itemId: "ghost-1",
            paneId: "ghost-1",
            otherPaneId: "ghost-2",
          })
        : fc.constantFrom(...items).chain((item) =>
            fc.record({
              type: tag("pane/swap"),
              itemId: fc.constant(item.id),
              paneId: paneOf(item),
              otherPaneId: paneOf(item),
            }),
          ),
    ),
    weighted(
      3,
      target.map(({ itemId, paneId }): Action => ({ type: "pane/focus", itemId, paneId })),
    ),
    weighted(3, fc.record({ type: tag("pane/focus-direction"), itemId, direction })),
    weighted(
      3,
      target.chain(({ itemId, paneId }) =>
        fc.record(
          {
            type: tag("pane/set-status"),
            itemId: fc.constant(itemId),
            paneId: fc.constant(paneId),
            status: fc.constantFrom("running", "idle", "exited"),
            exitCode: fc.integer({ min: 0, max: 255 }),
          },
          { requiredKeys: ["type", "itemId", "paneId", "status"] },
        ),
      ),
    ),
    weighted(
      3,
      target.chain(({ itemId, paneId }) =>
        fc.record(
          {
            type: tag("pane/set-location"),
            itemId: fc.constant(itemId),
            paneId: fc.constant(paneId),
            cwd: fc.constantFrom("/proj", "/proj/src", "/home/me", "C:/Users/me", " "),
            gitBranch: fc.constantFrom("main", "feature/x", "a1b2c3d", " "),
          },
          { requiredKeys: ["type", "itemId", "paneId", "cwd"] },
        ),
      ),
    ),
    weighted(
      3,
      target.chain(({ itemId, paneId }) =>
        fc.record(
          {
            type: tag("pane/command-start"),
            itemId: fc.constant(itemId),
            paneId: fc.constant(paneId),
            text: fc.constantFrom("npm test", "ls -la", " ", "a".repeat(600)),
          },
          { requiredKeys: ["type", "itemId", "paneId"] },
        ),
      ),
    ),
    weighted(
      3,
      target.chain(({ itemId, paneId }) =>
        fc.record(
          {
            type: tag("pane/command-end"),
            itemId: fc.constant(itemId),
            paneId: fc.constant(paneId),
            text: fc.constantFrom("npm test", "ls -la", " "),
            exitCode: fc.integer({ min: -2, max: 255 }),
            durationMs: fc.integer({ min: -5, max: 90_000 }),
          },
          { requiredKeys: ["type", "itemId", "paneId"] },
        ),
      ),
    ),
    weighted(
      6,
      target.chain(({ itemId, paneId }) =>
        fc.record(
          {
            type: tag("pane/notify"),
            itemId: fc.constant(itemId),
            paneId: fc.constant(paneId),
            bell: fc.boolean(),
          },
          { requiredKeys: ["type", "itemId", "paneId"] },
        ),
      ),
    ),
    weighted(
      2,
      target.chain(({ itemId, paneId }) =>
        fc.record(
          {
            type: tag("pane/clear-unread"),
            itemId: fc.constant(itemId),
            paneId: fc.constant(paneId),
          },
          { requiredKeys: ["type", "itemId"] },
        ),
      ),
    ),
  );
}
