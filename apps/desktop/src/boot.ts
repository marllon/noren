import {
  FakeBackend,
  SystemNotifier,
  TerminalTail,
  agentSettingsOf,
  scrollbackAllowed,
} from "@noren/model";
import type { Backend } from "@noren/model";
import { startAgentScanner } from "./agent-service";
import { createAgentStateReporter } from "./agent-state-report";
import { startLocalApi } from "./api-bridge";
import { startSessionLinks } from "./session-link-store";
import { armAgentResumes } from "./resume-restore";
import { resumeService } from "./resume-service";
import { restoreKeepingSessions, withoutReattachedSnapshots } from "./boot-sessions";
import { setAgentStateClock, setAgentStateReporter } from "./agent-state-store";
import { archiveClock, startAutoArchive } from "./auto-archive-service";
import { createBackend, insideTauri } from "./backend";
import { startBackgroundImages } from "./background-image-store";
import { followWindowClose } from "./close-handler";
import { aiProvidersSync, configManager } from "./config-store";
import { loadHome } from "./home";
import { realClock } from "./real-clock";
import { migrateLegacySettings } from "./legacy-settings";
import type { LegacyStorageArea } from "./legacy-settings";
import { startMods } from "./mods-store";
import { osNameOf } from "./os-name";
import { windowPreviewEnabled } from "./quick";
import { notificationSettings } from "./notification-settings";
import { perfMark } from "./perf-probe";
import { getProfiles, startProfiles } from "./profiles-store";
import { loadScrollbackForRestore, setRestoredScrollback } from "./scrollback-restore";
import {
  clearStaleSnapshots,
  scrollbackClock,
  startScrollback,
  sweepOrphanScrollback,
} from "./scrollback-service";
import { tauriBridge } from "./tauri-backend";
import { windowEventsOfApp } from "./window-host";
import { releaseWindows, startWindows } from "./window-service";
import { followActiveSpaceMods } from "./use-mods";
import { followActiveSpaceTheme } from "./use-theme";
import { followActiveSpaceBackground } from "./use-window";
import { loadUserThemes } from "./user-themes-store";
import { createWorkspaceStore } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

/**
 * The end of the output of every session this window holds, for `terminal.read` of the local API.
 * The backend feeds it and forgets a session when it ends (the real backend only).
 */
export const apiTail = new TerminalTail();

export const backend: Backend = createBackend({ tail: apiTail });

export type BootResult =
  | { ok: true; store: WorkspaceStore; source: "saved" | "fresh" | "recovered" }
  | { ok: false; error: string };

const newId = () => crypto.randomUUID();
const clock = { now: () => Date.now() };

/** Where earlier builds kept the active tab of each space; now it lives in `state.json`. */
export const LEGACY_ACTIVE_ITEMS_KEY = "noren.ui.activeItems";

/**
 * Restores the saved workspace (new shells in the saved folders), builds the store around it and
 * makes sure the pending state is written when the window goes away. The old browser-storage copy
 * of the active tabs is dropped, not migrated: the first run after the upgrade shows the first tab.
 */
export async function bootWorkspace(
  target: Backend,
  events: Pick<Window, "addEventListener">,
  storage: LegacyStorageArea | undefined,
): Promise<BootResult> {
  perfMark("boot-start");
  try {
    try {
      storage?.removeItem(LEGACY_ACTIVE_ITEMS_KEY);
    } catch {
      // Storage may be blocked; the leftover key is harmless.
    }
    // The settings first, so the first frame already has the side of the sidebar. A file that is
    // missing, unreadable or invalid never stops the app: the defaults and an error notice stand in.
    await configManager.start(target);
    perfMark("boot-config");
    // The providers of the file go to the AI side now and at every change of the list. A refusal is
    // told in the settings screen and never stops the app.
    aiProvidersSync.follow(configManager, target.ai);
    // The pictures of a background are read through the backend.
    startBackgroundImages(target);
    // What earlier builds kept in the browser storage (layout, notifications, shortcut preset)
    // moves into the file once, before the first frame. It never stops the app: a file it cannot
    // edit leaves the old keys for the next start.
    await migrateLegacySettings(storage, configManager).catch(() => undefined);
    // The themes of the user, before the first frame: a space or the settings may name one of them.
    // A folder that cannot be read leaves the built-in themes, and never stops the app.
    await loadUserThemes(target).catch(() => undefined);
    perfMark("boot-themes");
    // The mods of the user, before the first frame too, so the first frame already has the ones
    // that are on; the folder is watched from here on, and an edited file reloads. A folder that
    // cannot be read leaves the app without mods, and never stops it.
    await startMods(target);
    perfMark("boot-mods");
    // The profiles of the user (from the file) are handed to the backend before anything restores a
    // shell, since a saved pane may name one of them; the list is then the machine's and the user's.
    await startProfiles(target, configManager);
    perfMark("boot-profiles");
    // The connection of each shell on another machine (SSH profiles) reaches the tabs from here on.
    startSessionLinks(target);
    if (getProfiles().length === 0) {
      return { ok: false, error: "No shell was found on this machine." };
    }
    // Whether the shells of the panes outlive the app (`sessions.keepOnClose`) goes to the backend
    // before anything restores a shell: it gives a pane its old shell back only when the settings
    // keep sessions. It follows the file from here on. A backend that refuses never stops the app.
    const { restored } = await restoreKeepingSessions(target, configManager, {
      defaults: { newId, clock },
    });
    perfMark("boot-restore");
    // A pane that had an agent running when the state was saved and got a new shell (the machine
    // restarted) is handed the resume command of that agent, only when the user turned it on.
    armAgentResumes({
      restored,
      settings: agentSettingsOf(configManager.state.config.agents),
      backend: target,
      service: resumeService,
    });
    // The scrollback saved before: read now, so the terminal of each pane can write it, dimmed and
    // above the new shell, when it mounts. A snapshot that cannot be read leaves the pane without it.
    // A pane that got its old shell back has what it printed from the shell itself, so its snapshot
    // is left out: it would only repeat that.
    const snapshots = await loadScrollbackForRestore(target, restored.workspace, {
      enabled: scrollbackAllowed(configManager.state.config.terminal),
      now: clock.now(),
    }).catch(() => undefined);
    withoutReattachedSnapshots(snapshots?.texts, restored.reattachedPaneIds);
    setRestoredScrollback(snapshots?.texts ?? new Map());
    const home = await loadHome();
    const notifier = new SystemNotifier({ backend: target, settings: notificationSettings });
    // Where a new tab goes (NOR-F17-03b, 03c): the first rule of `routing.rules` of the settings that
    // matches, read at every new tab of the window and every call of the local API.
    const platform = osNameOf(navigator.userAgent) === "Windows" ? "windows" : "unix";
    const routing = () => ({
      rules: configManager.state.config.routing?.rules,
      context: { platform, home } as const,
    });
    const store = createWorkspaceStore({
      backend: target,
      routing,
      ...(home !== undefined ? { home } : {}),
      workspace: restored.workspace,
      failedPaneIds: restored.failedPaneIds,
      newId,
      clock,
      // A failed notification (the system refused) is not worth an error on screen.
      notifier,
    });
    // The snapshots of the scrollback: every minute for the panes with activity, and when the window
    // closes. This listens to the closing before the state is flushed below, so the notes it makes on
    // the panes are in the state that is written then.
    const saver = startScrollback({
      store,
      backend: target,
      clock: scrollbackClock(target),
      events,
    });
    if (snapshots !== undefined) void clearStaleSnapshots(store, target, snapshots.stale);
    // The files no pane of the workspace claims (open, closed or archived) are removed, now that the
    // state is loaded. Nothing waits for it, and a failure leaves the files for the next start.
    void sweepOrphanScrollback(store, target).catch(() => undefined);
    // The auto-archive: every minute, a tab nobody uses goes to the archive. Started after the
    // scrollback service, so the output of a tab it puts away is written as it leaves.
    startAutoArchive({ store, clock: archiveClock(target) });
    // The agents under the shells of the tabs, from the process tree, on an interval.
    startAgentScanner({ store, backend: target });
    // The windows besides the main one: their pages get the space they show, a window the person
    // closes gives its tabs back, and the windows the saved state remembers are brought up again
    // (the shells were restored with the rest). Where the page cannot show other windows (a plain
    // browser), there is nothing to start.
    const windowEvents = windowEventsOfApp();
    if (windowEvents !== undefined) {
      if (windowPreviewEnabled && target instanceof FakeBackend) {
        const { windowPreviewHost } = await import("./window-preview-host");
        target.setWindowHost(windowPreviewHost);
      }
      startWindows(store, target, windowEvents);
    } else {
      // A state saved where windows could be shown, opened where they cannot: the tabs of those
      // windows come back to the main window (their shells were restored in this page), so none is
      // left in a space nobody shows.
      releaseWindows(store);
    }
    // The silence that turns a working agent idle is measured on the clock of the fake shell in
    // web mode (a test moves it), and on real time in the app.
    setAgentStateClock(target instanceof FakeBackend ? target.clock : realClock);
    // In the app, closing the window waits for the page to save (the unload events below are not
    // enough: a call made while the window is torn down may never leave). The snapshots are started
    // first, which notes the files on the panes, so the state flushed with them has the notes.
    if (insideTauri) {
      followWindowClose(
        tauriBridge(),
        async () => {
          const snapshotsSaved = saver.flush();
          await Promise.all([snapshotsSaved, store.getState().flush()]);
        },
        realClock,
      ).catch(() => undefined);
      // The local API (NOR-F17-01c): the calls the server of the app validated run here, in the
      // window that owns the workspace, and are answered through `api_respond`.
      // A tab it makes with no space goes where `routing.rules` of the settings say (NOR-F17-03b).
      startLocalApi({
        store,
        backend: target,
        tail: apiTail,
        notifier,
        routing,
        bridge: tauriBridge(),
      });
      // And what the agents are doing goes out as events to the clients that subscribed (NOR-F17-01f).
      setAgentStateReporter(createAgentStateReporter(tauriBridge()));
    }
    // The window shows the theme of the active space, if it has one, from the first frame.
    followActiveSpaceTheme(store);
    // And the mods of the active space.
    followActiveSpaceMods(store);
    // And its picture.
    followActiveSpaceBackground(store);
    const flush = () => {
      store
        .getState()
        .flush()
        .catch(() => undefined);
    };
    events.addEventListener("beforeunload", flush);
    events.addEventListener("pagehide", flush);
    perfMark("boot-done");
    return { ok: true, store, source: restored.source };
  } catch (reason: unknown) {
    return { ok: false, error: reason instanceof Error ? reason.message : String(reason) };
  }
}

/** Starts at import, so the restore runs once even when React mounts the app twice. */
export const booted: Promise<BootResult> = bootWorkspace(backend, window, window.localStorage);
