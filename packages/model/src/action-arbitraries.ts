import * as fc from "fast-check";
import type { Action, Placement } from "./actions";
import { treeGroups, treeItemIds } from "./tree";
import type { Id, Workspace } from "./types";

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
const arbProfile = fc.constantFrom("pwsh", "bash", "wsl:Ubuntu");
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
          activate: fc.boolean(),
        },
        { requiredKeys: ["type", "name"] },
      ),
    ),
    weighted(1, fc.record({ type: tag("space/rename"), spaceId, name: arbName })),
    weighted(1, fc.record({ type: tag("space/set-color"), spaceId, color: arbColor })),
    weighted(1, fc.record({ type: tag("space/set-icon"), spaceId, icon: arbIcon })),
    weighted(1, fc.record({ type: tag("space/move"), spaceId, index: arbIndex })),
    weighted(2, fc.record({ type: tag("space/activate"), spaceId })),
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
    weighted(1, fc.record({ type: tag("group/set-collapsed"), groupId, collapsed: fc.boolean() })),
    weighted(1, fc.record({ type: tag("group/rename"), groupId, name: arbName })),
    weighted(1, fc.record({ type: tag("group/set-color"), groupId, color: arbColor })),
  );
}
