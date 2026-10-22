import "./zod-config";

export const MODEL_PACKAGE_NAME = "@noren/model";

export type {
  AttachSessionOptions,
  Backend,
  BrowserOpenOptions,
  CreateSessionOptions,
  AgentHit,
  BenchResultFile,
  GitInfo,
  ModFile,
  PathKind,
  SessionExit,
  SessionId,
  SessionLink,
  SessionLinkState,
  ShellProfile,
  Unsubscribe,
  Worktree,
} from "./backend";
export type { BranchProblem } from "./worktree";
export { branchProblem, worktreeDestination, worktreeFolderName } from "./worktree";
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
  BACKGROUND_VEIL,
  DEFAULT_BACKGROUND_BLUR,
  DEFAULT_BACKGROUND_OPACITY,
  MAX_BACKGROUND_BLUR,
  MAX_BACKGROUND_BYTES,
  MAX_BACKGROUND_PATH,
  PICTURE_PANEL_OPACITY,
  backgroundImageProblem,
  resolveBackground,
  sniffImageMime,
} from "./background";
export type { BackgroundImageFile, BackgroundLayer, ResolvedBackground } from "./background";
export { pictureUnderPanel, worstPixel } from "./background-panel";
export type { PanelOverPicture } from "./background-panel";
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
export { deriveTheme, normalizeColor, reservedThemeIds, slugify } from "./theme-derive";
export type { SchemeColors } from "./theme-derive";
export { MAX_THEME_NAME, duplicateTheme, renameTheme } from "./theme-actions";
export {
  ANSI_INDEXES,
  NUMBER_RANGES,
  ansiField,
  fieldText,
  isColor,
  isNumber,
  numberText,
  readThemeField,
  setThemeField,
  themeContrastWarnings,
  typeIntoField,
} from "./theme-edit";
export type {
  AnsiField,
  AnsiIndex,
  ColorField,
  ContrastCheck,
  ContrastWarning,
  FieldProblem,
  FieldReading,
  NumberField,
  NumberRange,
  TerminalColorField,
  TextField,
  ThemeField,
  UiColorField,
} from "./theme-edit";
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
  MAX_SSH_NAME,
  RESERVED_PROFILE_IDS,
  SSH_HOST_PATTERN,
  SSH_USER_PATTERN,
  ShellUserProfileSchema,
  SshUserProfileSchema,
  UserProfileSchema,
  isSshProfile,
  profilesProblem,
} from "./user-profile-schema";
export type { ShellUserProfile, SshUserProfile, UserProfile } from "./user-profile-schema";
export { commandLineOf, splitCommandLine, userProfilesFromImported } from "./user-profiles";
export type { CommandLine, ProfilesFromImport, SkippedProfile } from "./user-profiles";
export {
  MAX_THEME_BYTES,
  exportedThemePath,
  parseUserThemes,
  serializeTheme,
  themeExportProblem,
} from "./user-themes";
export type { UserThemesResult } from "./user-themes";
export {
  AI_CHAT_ROLES,
  AI_ERROR_KINDS,
  AI_FUNCTIONS,
  AI_PROVIDER_ID_PATTERN,
  AI_PROVIDER_KINDS,
  AiProviderSchema,
  MAX_AI_BASE_URL,
  MAX_AI_MODEL,
  MAX_AI_PROVIDER_ID,
  MAX_AI_PROVIDERS,
  OLLAMA_BASE_URL,
  OLLAMA_PROVIDER_ID,
  aiIsOn,
  aiProvidersProblem,
  isHttpAddress,
} from "./ai";
export type {
  AiBackend,
  AiChatEvent,
  AiChatMessage,
  AiChatRequest,
  AiChatRole,
  AiConnectionResult,
  AiErrorKind,
  AiFunction,
  AiProviderConfig,
  AiProviderInfo,
  AiProviderKind,
  OllamaMemoryReading,
  OllamaModels,
} from "./ai";
export { REDACTION_KINDS, redactSecrets, redactionMarker } from "./redact";
export type { Redaction, RedactionKind } from "./redact";
export {
  SPACE_FILE_EXTENSION,
  SPACE_FILE_FORMAT,
  SPACE_FILE_LIMITS,
  SPACE_FILE_VERSION,
  SpaceFileSchema,
  exportFileName,
  exportSpace,
  looksSecret,
  parseSpaceFile,
  planProfiles,
  spaceFromFile,
  validateSpaceFile,
  withoutSecretEnv,
} from "./space-file";
export type {
  ExportRemovals,
  ExportSpaceOptions,
  ProfileConflict,
  ProfilePlan,
  SpaceExport,
  SpaceFile,
  SpaceFileItem,
  SpaceFileNode,
  SpaceFileParse,
  SpaceFileSpace,
  SpaceFromFile,
} from "./space-file";
export {
  ASK_SYSTEM_PROMPT,
  MAX_ASK_CHIP_CHARS,
  MAX_ASK_QUESTION_CHARS,
  buildAskMessages,
  previewOfMessages,
} from "./ask-context";
export type { AskChip, AskCut, AskCutFrom, AskInput, AskMessage, AskRefusal } from "./ask-context";
export {
  MAX_COMMAND_CHARS,
  MAX_COMMAND_REQUEST_CHARS,
  buildCommandMessages,
  commandRequestOf,
  commandSystemPrompt,
  extractCommand,
} from "./command-ask";
export type {
  CommandAskInput,
  CommandAskMessage,
  CommandAskRefusal,
  ExtractedCommand,
} from "./command-ask";
export { codeBlocksOf, markdownText, parseMarkdown } from "./markdown";
export type { MdBlock, MdCode, MdInline } from "./markdown";
export {
  ConfigSchema,
  LANGUAGES,
  LANGUAGE_SETTINGS,
  SIDEBAR_MAX_WIDTH,
  SYSTEM_LANGUAGE,
  SYSTEM_THEME,
  SIDEBAR_MIN_WIDTH,
  configJsonSchema,
  describeConfigError,
  parseConfigText,
} from "./config";
export type { Config, ConfigError, LanguageSetting, ParseConfigResult } from "./config";
export {
  BELL_STYLES,
  CURSOR_STYLES,
  DEFAULT_BELL_STYLE,
  DEFAULT_CURSOR_BLINK,
  DEFAULT_CURSOR_STYLE,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_FAMILY_CSS,
  DEFAULT_FONT_SIZE,
  DEFAULT_LIGATURES,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_RIGHT_CLICK,
  DEFAULT_SCREEN_READER_MODE,
  DEFAULT_SCROLLBACK,
  DEFAULT_TERMINAL_OPTIONS,
  FONT_ZOOM_STEP,
  MAX_FONT_SIZE,
  MAX_LINE_HEIGHT,
  MAX_MAX_PANES,
  MAX_SCROLLBACK,
  MIN_FONT_SIZE,
  MIN_LINE_HEIGHT,
  MIN_MAX_PANES,
  MIN_SCROLLBACK,
  RIGHT_CLICK_ACTIONS,
  clampFontSize,
  cssFontFamily,
  fontFamilyProblem,
  fontNameList,
  isFontName,
  nextZoom,
  paneLimitOf,
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
  RightClickAction,
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
  ConfigPath,
  ConfigRemove,
  ConfigValue,
} from "./config-edit";
export { planAgentResume } from "./agent-resume";
export type { AgentResume, SavedPaneCommand } from "./agent-resume";
export {
  AGENT_ID_PATTERN,
  AGENT_PATTERN_FLAGS,
  AgentCatalogSchema,
  AgentEntrySchema,
  AgentPatternsSchema,
  DEFAULT_AGENTS_ENABLED,
  DEFAULT_AGENT_CATALOG,
  DEFAULT_AGENT_SCAN_SECONDS,
  DEFAULT_AGENT_SILENCE_SECONDS,
  DEFAULT_RESUME_ON_RESTORE,
  DEFAULT_WAITING_PATTERNS,
  MAX_AGENT_ENTRIES,
  MAX_AGENT_RESUME_CHARS,
  MAX_AGENT_NAMES,
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_PATTERNS,
  MAX_AGENT_PATTERN_CHARS,
  MAX_AGENT_SILENCE_SECONDS,
  MIN_AGENT_SCAN_SECONDS,
  MIN_AGENT_SILENCE_SECONDS,
  agentSettingsOf,
  compileAgentPattern,
  detectAgentByCommand,
  mentionsPackage,
  programName,
  resolveAgent,
  silenceMsOf,
} from "./agents";
export type { AgentCatalog, AgentEntry, AgentPatterns, AgentSettings } from "./agents";
export {
  AGENT_ECHO_WINDOW_MS,
  AGENT_STATES,
  AgentStateTracker,
  advanceAgentState,
  compileAgentRules,
  settleAgentState,
  startAgentState,
} from "./agent-state";
export type { AgentRules, AgentSignal, AgentState, AgentStateMemory } from "./agent-state";
export {
  MAX_LAST_LINE_CHARS,
  NO_LAST_LINE,
  TerminalTextStripper,
  advanceLastLine,
  lastLineOf,
} from "./terminal-text";
export type { LastLineMemory } from "./terminal-text";
export { TAIL_MAX_LINES, TAIL_MAX_LINE_CHARS, TerminalTail } from "./terminal-tail";
export type { TerminalTailOptions } from "./terminal-tail";
export { keySequence, keySequences } from "./api-keys";
export {
  API_DEFAULT_READ_LINES,
  API_DEFAULT_SIZE,
  API_ERROR_CODES,
  API_LIMITS,
  API_MAX_READ_BYTES,
  API_METHODS,
  dispatchApiCall,
  parseApiCall,
} from "./api-dispatch";
export type {
  ApiCall,
  ApiError,
  ApiErrorCode,
  ApiHost,
  ApiJson,
  ApiNotification,
  ApiMethodName,
  ApiOutcome,
  ApiRouting,
} from "./api-dispatch";
export {
  PLUGIN_API_VERSION,
  PLUGIN_LIMITS,
  PLUGIN_METHODS,
  PLUGIN_PERMISSIONS,
  createPluginBroker,
  parsePluginManifest,
  pluginManifestSchema,
} from "./plugins";
export type {
  PluginBroker,
  PluginError,
  PluginErrorCode,
  PluginManifest,
  PluginManifestResult,
  PluginMethodName,
  PluginPaletteAction,
  PluginPanelRequest,
  PluginPermission,
  PluginRegistry,
  PluginRequest,
  PluginRequestId,
  PluginResponse,
} from "./plugins";
export { checkPluginFolders } from "./plugins-load";
export type { LoadedPlugin, PluginFolder, PluginFolderCheck, RejectedPlugin } from "./plugins-load";
export {
  EXAMPLE_PLUGIN_FOLDER,
  EXAMPLE_PLUGIN_MAIN,
  EXAMPLE_PLUGIN_MANIFEST,
  FAKE_PLUGINS,
} from "./plugins-example";
export {
  GALLERY_INDEX_VERSION,
  GALLERY_KINDS,
  GALLERY_LIMITS,
  compareGalleryVersions,
  compareWithInstalled,
  galleryIndexSchema,
  galleryItemSchema,
  parseGalleryIndex,
} from "./gallery";
export type {
  GalleryEntry,
  GalleryIndex,
  GalleryIndexResult,
  GalleryItem,
  GalleryKind,
  GalleryStatus,
  InstalledGalleryItem,
} from "./gallery";
export {
  FAKE_GALLERY_DOWNLOADS,
  FAKE_GALLERY_EMBER,
  FAKE_GALLERY_HASHES,
  FAKE_GALLERY_INDEX,
  FAKE_GALLERY_LAGOON,
  FAKE_GALLERY_MOD,
  FAKE_GALLERY_TAMPERED,
} from "./gallery-fixture";
export type { GalleryDownload } from "./gallery-fixture";
export {
  SYNC_CHANGES,
  SYNC_LIMITS,
  gistFileName,
  isSyncGistId,
  isSyncSpaceFileName,
  isSyncablePath,
  parseSyncGistStatus,
  parseSyncPull,
  parseSyncPush,
  parseSyncSpaceFolder,
  parseSyncStatus,
  pathOfGistFile,
  syncGistStatusSchema,
  syncGistTokenProblem,
  syncPullSchema,
  syncPushSchema,
  syncRemoteProblem,
  syncSpaceFileSchema,
  syncSpaceFolderSchema,
  syncSpaceWriteProblem,
  syncStatusSchema,
} from "./sync";
export {
  UPDATE_LIMITS,
  compareVersions,
  isNewerVersion,
  isVersion,
  parseUpdateCheck,
  parseUpdateProgress,
  parseUpdateStatus,
  updateInfoSchema,
  updateProgressSchema,
  updateStatusSchema,
} from "./update";
export type { UpdateInfo, UpdateParse, UpdateProgress, UpdateStatus } from "./update";
export { FAKE_CURRENT_VERSION, FakeUpdates, UPDATE_MESSAGES } from "./fake-update";
export type { FakeRelease } from "./fake-update";
export type {
  SyncChange,
  SyncGistStatus,
  SyncParse,
  SyncPullResult,
  SyncPushResult,
  SyncSpaceFile,
  SyncSpaceFolder,
  SyncSpaceLink,
  SyncSpaceWrite,
  SyncStatus,
} from "./sync";
export { sha256Hex, sha256HexOfBytes } from "./sha256";
export { DEFAULT_PUSH_ON_CLOSE, closePushDecision, pushOnCloseAllowed } from "./sync-close";
export type {
  ClosePushDecision,
  ClosePushFacts,
  ClosePushSkip,
  ClosePushStatus,
} from "./sync-close";
export { DEFAULT_SYNC_METHOD, SYNC_METHODS, syncMethodOf } from "./sync-method";
export type { SyncMethod } from "./sync-method";
export { planSpacePull, planSpacePush, spaceFileSignature, spacesToRead } from "./sync-spaces";
export type { PlanPushOptions, SpacePullPlan, SpacePushPlan, SpacePushSkip } from "./sync-spaces";
export { AGENT_LINE_MAX, buildAgentList, firstWaitingAgent, truncateLine } from "./agent-list";
export type { AgentInfo, AgentRow } from "./agent-list";
export {
  ARCHIVE_CHECK_INTERVAL_MS,
  DEFAULT_ARCHIVE_AFTER_HOURS,
  DEFAULT_ARCHIVE_ENABLED,
  archiveSettingsOf,
  idleItems,
  itemInUse,
} from "./archive";
export type { ArchiveSettings, IdleCheck, IdleItem } from "./archive";
export {
  LIVE_REFRESH_INTERVAL_MS,
  LiveGroups,
  findLiveItem,
  isLiveSource,
  liveGroupsOf,
  liveSourceProblem,
  dockerEntry,
  dockerSource,
  liveSourcesOf,
  planOpenLiveEntry,
  sameLiveSource,
  sshEntry,
  sshSource,
  worktreeEntry,
  worktreesSource,
} from "./live-groups";
export type {
  LiveEntry,
  LiveGroupsOptions,
  LiveOpen,
  LiveSourceQuery,
  LiveSources,
} from "./live-groups";
export { ManualClock } from "./clock";
export type { Clock } from "./clock";
export { createDefaultWorkspace } from "./default-workspace";
export type { DefaultWorkspaceOptions } from "./default-workspace";
export {
  DEFAULT_PROFILE_ID,
  createBrowserPane,
  createDiffPane,
  createPreviewPane,
} from "./factories";
export { createSequentialIds } from "./ids";
export type { IdGenerator } from "./ids";
export { SIZE_SUM_TOLERANCE, checkInvariants } from "./invariants";
export type { InvariantOptions, Violation, ViolationCode } from "./invariants";
export { layoutRects, neighborPane } from "./geometry";
export type { Direction, Rect } from "./geometry";
export { reduce, validEnv } from "./reducer";
export { DEFAULT_KEEP_SESSIONS, keepSessionsAllowed } from "./keep-sessions";
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
export { DEFAULT_MAX_PANES, MAX_CLOSED, MAX_EXTRA_WINDOWS, MAX_GROUP_DEPTH } from "./types";
export {
  WINDOW_LABEL_PREFIX,
  canOpenWindow,
  findWindow,
  isWindowId,
  mainWindowSpaces,
  spaceIsShown,
  windowCanShowTab,
  windowShownItems,
  windowIdOfLabel,
  windowLabel,
  windowShowing,
  workspaceWindows,
} from "./windows";
export type {
  AppWindow,
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
  PaneType,
  RunningCommand,
  Space,
  SpaceBackground,
  SpaceDefaults,
  SplitNode,
  Workspace,
} from "./types";
export { MAX_LINK_BYTES, externalLinkProblem, isExternalLink } from "./external-link";
export {
  MAX_BROWSER_EXTENT,
  browserBoundsProblem,
  browserUrlProblem,
  isBrowserPaneId,
  isBrowserUrl,
} from "./browser";
export type { BrowserBounds } from "./browser";
export {
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_PREVIEW_PATH,
  MAX_PREVIEW_TEXT_BYTES,
  PREVIEW_IMAGE_MIMES,
  PREVIEW_REFUSALS,
  PREVIEW_SIGNATURE_BYTES,
  classifyPreviewPath,
  decodeFilePreview,
  formatJson,
  isPreviewPath,
  previewFileName,
  previewOf,
  previewPathProblem,
  previewTextKind,
  sniffPreviewImage,
} from "./file-preview";
export type {
  FilePreview,
  PreviewEntry,
  PreviewImageMime,
  PreviewPathKind,
  PreviewRefusal,
  PreviewRefusalReason,
  PreviewTextKind,
} from "./file-preview";
export {
  GIT_DIFF_REFUSALS,
  MAX_GIT_DIFF_BYTES,
  MAX_GIT_DIFF_DETAIL,
  decodeGitDiff,
  parseGitDiff,
  sideBySideRows,
  unquoteGitPath,
} from "./git-diff";
export type {
  DiffCell,
  DiffRow,
  GitDiff,
  GitDiffFile,
  GitDiffHunk,
  GitDiffLine,
  GitDiffRefusal,
  GitDiffRefusalReason,
  GitDiffStatus,
} from "./git-diff";
export { findOutputPaths, resolveOutputPath } from "./output-paths";
export type { OutputPathMatch, OutputPathProblem, ResolvedOutputPath } from "./output-paths";
export {
  DEFAULT_AI_REPLY,
  FAKE_LINK_MAX_ATTEMPTS,
  FAKE_DOCKER_CONTAINERS,
  FAKE_SSH_HOSTS,
  FakeBackend,
} from "./fake-backend";
export type {
  FakeAiMethod,
  FakeBackendOptions,
  FakeBrowserPane,
  FakeCall,
  FakeCallMethod,
  FakeCommandRun,
  FakeNotification,
  FakeSessionInfo,
  FakeSshTarget,
  FakeWindowHost,
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
export {
  MAX_ROUTING_GLOB,
  MAX_ROUTING_NAME,
  MAX_ROUTING_PATTERN,
  MAX_ROUTING_RULES,
  MAX_ROUTING_SUBJECT,
  RoutingRuleSchema,
  RoutingSchema,
  commandMatches,
  commandPatternProblem,
  destinationOfNewTab,
  globMatchesPath,
  routeNewTab,
} from "./routing";
export type {
  NewTabRouting,
  RoutingContext,
  RoutingDestination,
  RoutingPlatform,
  RoutingRule,
  RoutingTarget,
} from "./routing";
export { OutputStream } from "./output-stream";
export { spaceSessionEnv } from "./session-env";
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
export {
  BENCH_CHARS_PER_TOKEN,
  BENCH_RESULTS_DIR,
  BENCH_RUN_VERSION,
  BenchRefusedError,
  benchMessages,
  benchProviderProblem,
  benchResultPath,
  benchRunSchema,
  estimateTokens,
  benchMedian,
  runBench,
  summarizeBenchTasks,
} from "./bench-runner";
export type {
  BenchAbortSignal,
  BenchProgress,
  BenchRun,
  BenchTaskRun,
  BenchMemory,
  BenchTotals,
  RunBenchOptions,
} from "./bench-runner";
export {
  MAX_BENCH_RESULT_BYTES,
  MAX_BENCH_RESULTS,
  MAX_BENCH_SUFFIX,
  benchFileName,
  benchStampOfStartedAt,
  benchStartedAtOf,
  compareBenchFileNamesNewestFirst,
  freeBenchFileName,
  isBenchResultText,
  isBenchStamp,
  loadBenchRuns,
  parseBenchFileName,
  parseBenchResult,
  saveBenchRun,
  serializeBenchRun,
} from "./bench-results";
export type { SavedBenchRun } from "./bench-results";
export {
  BENCH_MODEL_CATALOG,
  BENCH_MODEL_ID_PATTERN,
  BENCH_MODEL_LICENSES,
  BENCH_MODEL_USES,
  BENCH_RAM_SHARE,
  BENCH_VRAM_SHARE,
  MAX_BENCH_MODEL_ID,
  benchCatalogModelSchema,
  benchCatalogSchema,
  benchHardwareOf,
  isBenchModelId,
  ollamaPullCommand,
  recommendedBenchModels,
} from "./bench-models";
export type {
  BenchCatalogModel,
  BenchHardware,
  BenchMemoryKind,
  BenchModelLicense,
  BenchModelReason,
  BenchModelUse,
  BenchRecommendation,
  BenchRecommendedModel,
  OllamaPullResult,
} from "./bench-models";
export {
  BENCH_CSV_HEADER,
  benchCsvText,
  benchDefaultEdits,
  benchScoreboard,
  benchScoreboardCsv,
  knownAiProviderIds,
  recommendBenchModel,
} from "./bench-scoreboard";
export type {
  BenchApplyResult,
  BenchKindScore,
  BenchScoreRow,
  BenchTarget,
  BenchTokensSource,
} from "./bench-scoreboard";
export {
  BENCH_DISTRIBUTION,
  benchTaskSchema,
  checkBenchAnswer,
  checkBenchSuite,
} from "./bench-suite";
export type {
  BenchKind,
  BenchResult,
  BenchShell,
  BenchSuiteFile,
  BenchSuiteReport,
  BenchTask,
  CommandBenchTask,
} from "./bench-suite";
