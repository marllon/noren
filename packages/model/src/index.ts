export const MODEL_PACKAGE_NAME = "@noren/model";

export type {
  Backend,
  CreateSessionOptions,
  SessionExit,
  SessionId,
  ShellProfile,
  Unsubscribe,
} from "./backend";
export type { Action, ActionType, Placement, ReducerContext, SpaceItemsFate } from "./actions";
export { ManualClock } from "./clock";
export type { Clock } from "./clock";
export { createDefaultWorkspace } from "./default-workspace";
export type { DefaultWorkspaceOptions } from "./default-workspace";
export { DEFAULT_PROFILE_ID } from "./factories";
export { createSequentialIds } from "./ids";
export type { IdGenerator } from "./ids";
export { SIZE_SUM_TOLERANCE, checkInvariants } from "./invariants";
export type { InvariantOptions, Violation, ViolationCode } from "./invariants";
export { layoutRects, neighborPane } from "./geometry";
export type { Direction, Rect } from "./geometry";
export { reduce } from "./reducer";
export { restoreWorkspace } from "./restore";
export type { RestoreOptions, RestoreResult } from "./restore";
export { layoutPanes, liveSessionIds } from "./sessions";
export { treeItemIds } from "./tree";
export {
  MIGRATIONS,
  STATE_VERSION,
  parseState,
  serializeWorkspace,
  workspaceWithoutSessions,
} from "./state";
export type { Migration, ParseStateResult } from "./state";
export { STATE_SAVE_DELAY_MS, StateWriter } from "./state-writer";
export type { StateWriterOptions } from "./state-writer";
export { DEFAULT_MAX_PANES, MAX_CLOSED, MAX_GROUP_DEPTH } from "./types";
export type {
  ArchivedItem,
  ClosedItem,
  GroupNode,
  Id,
  Item,
  ItemNode,
  ItemOrigin,
  LastCommand,
  LayoutNode,
  Node,
  Pane,
  PaneLeaf,
  Space,
  SpaceDefaults,
  SplitNode,
  Workspace,
} from "./types";
export { FakeBackend } from "./fake-backend";
export type { FakeBackendOptions, FakeCall, FakeSessionInfo } from "./fake-backend";
export { OutputStream } from "./output-stream";
export { decodeUtf8, encodeUtf8 } from "./utf8";
