export const MODEL_PACKAGE_NAME = "@noren/model";

export type {
  Backend,
  CreateSessionOptions,
  GitInfo,
  ModFile,
  SessionExit,
  SessionId,
  ShellProfile,
  Unsubscribe,
} from "./backend";
export {
  MAX_MOD_BYTES,
  MAX_MODS,
  MOD_FILE_NAME_PATTERN,
  MOD_LAYER,
  MOD_LAYER_ORDER,
  isReservedModName,
  isValidModFileName,
  modWarnings,
  movedMod,
  planMods,
  sameModList,
  withMod,
  wrapModCss,
} from "./mods";
export type { AppliedMod, ModPlan, WrapModResult } from "./mods";
export {
  BACKGROUND_EXTENSIONS,
  DEFAULT_BACKGROUND_BLUR,
  DEFAULT_BACKGROUND_OPACITY,
  MAX_BACKGROUND_BLUR,
  MAX_BACKGROUND_BYTES,
  MAX_BACKGROUND_PATH,
  backgroundImageProblem,
  resolveBackground,
  sniffImageMime,
} from "./background";
export type { BackgroundImageFile, BackgroundLayer, ResolvedBackground } from "./background";
export {
  DEFAULT_WINDOW_EFFECT,
  MIN_WINDOW_OPACITY,
  WINDOW_EFFECTS,
  WINDOW_EFFECT_LABELS,
  clampNumber,
  interfaceOpacity,
  isWindowEffect,
  isWindowScheme,
} from "./window-effect";
export type {
  OpacitySources,
  WindowEffect,
  WindowEffectReport,
  WindowScheme,
} from "./window-effect";
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
export {
  MIN_TEXT_CONTRAST,
  THEME_ID_PATTERN,
  ThemeSchema,
  contrastRatio,
  parseTheme,
  relativeLuminance,
} from "./theme";
export type { AnsiPalette, ParseThemeResult, Theme } from "./theme";
export { NOREN_DUSK, NOREN_PAPER, THEMES, findTheme } from "./builtin-themes";
export { deriveTheme, normalizeColor, slugify } from "./theme-derive";
export type { SchemeColors } from "./theme-derive";
export {
  MAX_IMPORT_CHARS,
  UNKNOWN_FORMAT_MESSAGE,
  detectFormat,
  importColorSchemes,
  importProfiles,
} from "./importers";
export type { ImportFormat, ImportOptions, ImportResult } from "./importers";
export type { ImportedProfile, ProfilesResult } from "./import-json";
export {
  MAX_PROFILE_ID,
  MAX_USER_PROFILES,
  PROFILE_ID_PATTERN,
  RESERVED_PROFILE_IDS,
  UserProfileSchema,
  profilesProblem,
} from "./user-profile-schema";
export type { UserProfile } from "./user-profile-schema";
export { commandLineOf, splitCommandLine, userProfilesFromImported } from "./user-profiles";
export type { CommandLine, ProfilesFromImport, SkippedProfile } from "./user-profiles";
export { parseUserThemes, serializeTheme } from "./user-themes";
export type { UserThemesResult } from "./user-themes";
export {
  ConfigSchema,
  SIDEBAR_MAX_WIDTH,
  SYSTEM_THEME,
  SIDEBAR_MIN_WIDTH,
  configJsonSchema,
  describeConfigError,
  parseConfigText,
} from "./config";
export type { Config, ConfigError, ParseConfigResult } from "./config";
export {
  BELL_STYLES,
  CURSOR_STYLES,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_FAMILY_CSS,
  DEFAULT_TERMINAL_OPTIONS,
  FONT_ZOOM_STEP,
  MAX_FONT_SIZE,
  MAX_SCROLLBACK,
  MIN_FONT_SIZE,
  clampFontSize,
  cssFontFamily,
  fontFamilyProblem,
  fontNameList,
  isFontName,
  nextZoom,
  parseFontFamilies,
  safeFontFamily,
  terminalOptionsOf,
  zoomedFontSize,
} from "./terminal-options";
export type {
  BellStyle,
  CursorStyle,
  FontFamiliesResult,
  FontFamily,
  TerminalOptions,
  TerminalSettings,
} from "./terminal-options";
export { ConfigManager } from "./config-manager";
export type { ConfigSource, ConfigState, ConfigUpdateResult } from "./config-manager";
export { editConfigText } from "./config-edit";
export type {
  ConfigAppend,
  ConfigChange,
  ConfigEdit,
  ConfigJson,
  ConfigValue,
} from "./config-edit";
export {
  ARCHIVE_CHECK_INTERVAL_MS,
  DEFAULT_ARCHIVE_AFTER_HOURS,
  DEFAULT_ARCHIVE_ENABLED,
  archiveSettingsOf,
  idleItems,
  itemInUse,
} from "./archive";
export type { ArchiveSettings, IdleCheck, IdleItem } from "./archive";
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
export {
  DEFAULT_SAVE_SCROLLBACK,
  MAX_SCROLLBACK_BYTES,
  MAX_SNAPSHOT_LINE,
  PEEK_LINE_CHARS,
  PEEK_LINES,
  SCROLLBACK_SAVE_INTERVAL_MS,
  SCROLLBACK_SAVE_LINES,
  cleanSnapshot,
  formatRestoreTime,
  isScrollbackPaneId,
  orphanScrollbackIds,
  peekLines,
  restoredMarker,
  restoredTerminalText,
  savesScrollback,
  scrollbackAllowed,
  scrollbackFileName,
  snapshotSearchText,
} from "./scrollback";
export type { CleanSnapshotOptions } from "./scrollback";
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
  ClosedPlace,
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
  SpaceBackground,
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
