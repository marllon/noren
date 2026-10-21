import type { Backend } from "./backend";
import type { Clock } from "./clock";
import type { PaneAttentionEvent, PaneCommandEvent } from "./pane-location";
import type { Id } from "./types";

// When Noren asks the system to show a notification, and with which words. The rule is pure; the
// clock, the focus of the window and the call itself are injected.

/** The provisional settings of the notifications, until the config file (NOR-F8-01) has them. */
export interface NotificationSettings {
  /** Off: nothing is ever sent to the system. */
  enabled: boolean;
  /** A command that runs longer than this (strictly) notifies when it ends out of sight. */
  longCommandMs: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  longCommandMs: 30_000,
};

/** What happened in a pane: it asked for attention, or its command ended. */
export type SystemNotificationEvent =
  | { kind: "attention"; attention: PaneAttentionEvent }
  | { kind: "command-end"; command: Extract<PaneCommandEvent, { kind: "end" }> };

/** What the rule needs to know about the moment. */
export interface NotificationContext {
  /** The window of the app has the keyboard focus of the system. */
  windowFocused: boolean;
  /** The pane is on screen: in the tab the active space shows, not hidden by zoom. */
  paneVisible: boolean;
  /** The title of the tab of the pane, for the words of the notification. */
  tabTitle?: string;
  settings: NotificationSettings;
}

/** What the system is asked to show. Plain text. */
export interface SystemNotification {
  title: string;
  body: string;
}

const APP_NAME = "Noren";
/** The system cuts long text its own way; this keeps what we show short and predictable. */
const MAX_TITLE = 80;
const MAX_BODY = 200;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** `31s`, `2m 05s`, `1h 02m`: the duration of a command in words a person reads. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Whether the event is worth a notification of the system, and which one.
 *
 * - The bell and the notifications of a program (OSC 9, OSC 777) notify when the window has no
 *   focus. With the focus, the marks on the tab already tell the user, so the system is left out.
 * - A command that ran longer than `settings.longCommandMs` notifies when it ends out of sight:
 *   in a tab that is not on screen, or with the window out of focus (what is on screen of a window
 *   nobody looks at is not seen either). A command with no known duration never does.
 */
export function decideNotification(
  event: SystemNotificationEvent,
  context: NotificationContext,
): SystemNotification | undefined {
  const { settings, tabTitle } = context;
  if (!settings.enabled) return undefined;
  const where = tabTitle !== undefined && tabTitle !== "" ? tabTitle : undefined;

  if (event.kind === "attention") {
    if (context.windowFocused) return undefined;
    const { attention } = event;
    if (attention.kind === "bell") {
      return { title: clip(where ?? APP_NAME, MAX_TITLE), body: "Bell" };
    }
    const title = attention.title !== undefined && attention.title !== "" ? attention.title : where;
    return {
      title: clip(title ?? APP_NAME, MAX_TITLE),
      body: clip(attention.body, MAX_BODY),
    };
  }

  const { command } = event;
  const duration = command.durationMs;
  if (duration === undefined || duration <= settings.longCommandMs) return undefined;
  if (context.windowFocused && context.paneVisible) return undefined;
  const failed = command.exitCode !== undefined && command.exitCode !== 0;
  const line = command.text !== undefined && command.text !== "" ? command.text : "A command";
  const result = failed ? `failed (exit ${command.exitCode})` : "finished";
  return {
    title: clip(
      `${failed ? "Command failed" : "Command finished"}${where !== undefined ? ` in ${where}` : ""}`,
      MAX_TITLE,
    ),
    body: clip(`${line} ${result} after ${formatElapsed(duration)}`, MAX_BODY),
  };
}

/** The calls the notifier makes on the backend. */
export type NotifierBackend = Pick<Backend, "notify" | "isWindowFocused">;

export interface SystemNotifierOptions {
  backend: NotifierBackend;
  /** Time source of the repeat guard. Default: the wall clock. */
  clock?: Pick<Clock, "now">;
  /** The settings, read at every event so a change takes effect at once. Default: the defaults. */
  settings?(): NotificationSettings;
  /** The same notification of the same pane is not sent again within this time. Default: 3 s. */
  repeatMs?: number;
  /** Called with a failure of the backend; the failure never reaches the one who reported. */
  onError?(error: unknown): void;
}

/** What one report tells the notifier about the pane it came from. */
export interface NotificationSource {
  paneId: Id;
  /** Read after the focus of the window is known, so it is the state at the time of the decision. */
  paneVisible(): boolean;
  tabTitle(): string | undefined;
}

/**
 * Puts the rule to work: asks the backend whether the window has the focus, decides, and sends the
 * notification. A program that rings the bell in a loop, or an event reported twice, gives one
 * notification: the same words for the same pane are held back for `repeatMs`.
 */
export class SystemNotifier {
  readonly #backend: NotifierBackend;
  readonly #clock: Pick<Clock, "now">;
  readonly #settings: () => NotificationSettings;
  readonly #repeatMs: number;
  readonly #onError: (error: unknown) => void;
  /** When each notification was last sent, by pane and words. */
  readonly #sent = new Map<string, number>();

  constructor(options: SystemNotifierOptions) {
    this.#backend = options.backend;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#settings = options.settings ?? (() => DEFAULT_NOTIFICATION_SETTINGS);
    this.#repeatMs = options.repeatMs ?? 3000;
    this.#onError = options.onError ?? (() => undefined);
  }

  /** Resolves with whether a notification was sent. Never rejects. */
  async report(event: SystemNotificationEvent, source: NotificationSource): Promise<boolean> {
    try {
      const settings = this.#settings();
      if (!settings.enabled) return false;
      const windowFocused = await this.#backend.isWindowFocused();
      const notification = decideNotification(event, {
        windowFocused,
        paneVisible: source.paneVisible(),
        ...(source.tabTitle() !== undefined ? { tabTitle: source.tabTitle() as string } : {}),
        settings,
      });
      if (notification === undefined) return false;
      return await this.#deliver(source.paneId, notification);
    } catch (error) {
      this.#onError(error);
      return false;
    }
  }

  /**
   * Shows what a program asked for on purpose (the local API): the words are cut like the others
   * and the focus of the window does not matter, since nobody is to be spared a notification that
   * was asked for, but the user's settings do (off means nothing is sent) and so does the repeat
   * guard. Resolves with whether a notification was sent. Never rejects.
   */
  async send(notification: SystemNotification, paneId: Id): Promise<boolean> {
    try {
      if (!this.#settings().enabled) return false;
      const title = clip(notification.title, MAX_TITLE);
      return await this.#deliver(paneId, {
        title: title === "" ? APP_NAME : title,
        body: clip(notification.body, MAX_BODY),
      });
    } catch (error) {
      this.#onError(error);
      return false;
    }
  }

  /** Sends it unless the same words went out for the pane a moment ago. */
  async #deliver(paneId: Id, notification: SystemNotification): Promise<boolean> {
    const key = this.#hold(paneId, notification);
    if (key === undefined) return false;
    try {
      await this.#backend.notify(notification.title, notification.body);
    } catch (error) {
      // The system did not take it, so nothing went out: the next try is not held back.
      this.#sent.delete(key);
      throw error;
    }
    return true;
  }

  /**
   * Remembers that these words go out for the pane now and returns their key; `undefined` when the
   * same words went out for the pane a moment ago.
   */
  #hold(paneId: Id, { title, body }: SystemNotification): string | undefined {
    const now = this.#clock.now();
    for (const [key, at] of this.#sent) {
      if (now - at >= this.#repeatMs || at > now) this.#sent.delete(key);
    }
    const key = JSON.stringify([paneId, title, body]);
    if (this.#sent.has(key)) return undefined;
    this.#sent.set(key, now);
    return key;
  }
}
