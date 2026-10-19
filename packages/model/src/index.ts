export const MODEL_PACKAGE_NAME = "@noren/model";

export type {
  Backend,
  CreateSessionOptions,
  GitInfo,
  SessionExit,
  SessionId,
  ShellProfile,
  Unsubscribe,
} from "./backend";
export type { Action, ActionType, Placement, ReducerContext, SpaceItemsFate } from "./actions";
export { ACTIONS_FILE_PATH, parseActionsFile } from "./actions-file";
export type { ParseActionsResult, ProjectAction } from "./actions-file";
export { ACTIONS_POLL_MS, watchActionsFile } from "./actions-watcher";
export type {
  ActionsFileState,
  ActionsFileWatcher,
  WatchActionsFileOptions,
} from "./actions-watcher";
export { findSpaceByFolder, parseDeepLink, sameFolder, spaceNameForFolder } from "./deep-link";
export type { DeepLink, ParseDeepLinkResult } from "./deep-link";
export { createProjectActions, createRunStop } from "./project-actions";
export type {
  ActionStatus,
  ProjectActions,
  ProjectActionsOptions,
  RunResult,
} from "./project-actions";
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
export { reduce, validEnv } from "./reducer";
export { restoreWorkspace } from "./restore";
export type { RestoreOptions, RestoreResult } from "./restore";
export { layoutPanes, liveSessionIds } from "./sessions";
export { isPaneVisible, lastUnread, shownItem, visiblePanes } from "./unread";
export type { PaneTarget } from "./unread";
export { findGroup, findGroupSlot, findItemSlot, treeGroups, treeItemIds } from "./tree";
export type { ItemSlot } from "./tree";
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
  RunningCommand,
  Space,
  SpaceDefaults,
  SplitNode,
  Workspace,
} from "./types";
export { FakeBackend } from "./fake-backend";
export type {
  FakeBackendOptions,
  FakeCall,
  FakeCommandRun,
  FakeNotification,
  FakeSessionInfo,
} from "./fake-backend";
export {
  DEFAULT_NOTIFICATION_SETTINGS,
  SystemNotifier,
  decideNotification,
  formatElapsed,
} from "./notifications";
export type {
  NotificationContext,
  SystemNotificationEvent,
  NotificationSettings,
  NotificationSource,
  NotifierBackend,
  SystemNotification,
  SystemNotifierOptions,
} from "./notifications";
export { OutputStream } from "./output-stream";
export { PaneLocationTracker } from "./pane-location";
export type {
  PaneAttentionEvent,
  PaneCommandEvent,
  PaneLocation,
  PaneLocationTrackerOptions,
} from "./pane-location";
export { CommandMarks, joinRows, markFailed } from "./command-marks";
export type {
  BufferRow,
  CommandMark,
  CommandMarksOptions,
  LineAnchor,
  MarkChange,
  MarkCursor,
  MarkState,
  MarkStep,
  MarkView,
  OutputRows,
} from "./command-marks";
export { decodeUtf8, encodeUtf8 } from "./utf8";
export {
  DEFAULT_MAX_OSC_BYTES,
  MAX_NOTIFICATION_CHARS,
  ShellIntegrationParser,
  parseOsc,
  pathFromFileUri,
  pathFromPlainPath,
  unescapeCommandLine,
} from "./shell-integration";
export type {
  BellEvent,
  CommandEndEvent,
  CommandLineEvent,
  CommandStartEvent,
  CwdEvent,
  NotificationEvent,
  PromptEndEvent,
  PromptStartEvent,
  ShellEvent,
  ShellIntegrationParserOptions,
} from "./shell-integration";
