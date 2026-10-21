import { layoutPanes } from "@noren/model";
import type { Id, Workspace } from "@noren/model";
import { itemTitle } from "./favorites";
import { t } from "./i18n";

// What a screen reader is told when the state of the app changes and nothing else says it: a tab or
// a space that was switched to, a command that ended, the bell, a shell that ended, the result of a
// Pull or a Push. Pure: the words and the rules live here, and `AnnouncerRegion.tsx` only draws the
// two live regions the announcer fills. The text is built in the language in force when the event
// happens, so a change of language counts at once.

/** Polite waits for the screen reader to finish what it is saying; assertive cuts in, and is for errors only. */
export type AnnouncementUrgency = "polite" | "assertive";

export interface Announcement {
  text: string;
  urgency: AnnouncementUrgency;
}

/** The same announcement is not repeated inside this window (a bell that rings fifty times says it once). */
export const ANNOUNCE_BURST_MS = 2000;

/** How long an announcement stays in its region before the region is emptied, so nothing stale is left to read. */
export const ANNOUNCE_CLEAR_MS = 10_000;

/** A command longer than this is cut when it is spoken. */
const MAX_COMMAND_CHARS = 80;

/** What the two live regions hold now. */
export interface AnnouncerState {
  polite: string;
  assertive: string;
}

export interface AnnouncerOptions {
  /** The clock in milliseconds; the wall clock when left out. */
  now?(): number;
  /** Overrides `ANNOUNCE_BURST_MS`. */
  burstMs?: number;
}

const NBSP = " ";

/**
 * The text of the two live regions and the rule that keeps them quiet in a burst. A region only
 * speaks when its text changes, so an announcement equal to what the region holds gets a trailing
 * no-break space (which is not spoken) to be a change.
 */
export class Announcer {
  private current: AnnouncerState = { polite: "", assertive: "" };
  private readonly last = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly burstMs: number;

  constructor(options: AnnouncerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.burstMs = options.burstMs ?? ANNOUNCE_BURST_MS;
  }

  /** What the regions hold. The same object until something is announced or cleared. */
  get state(): AnnouncerState {
    return this.current;
  }

  /**
   * Says `announcement` in its region. False, and nothing changes, for an empty text or for the same
   * text and urgency that was announced less than the burst window ago.
   */
  announce(announcement: Announcement): boolean {
    const text = announcement.text.trim();
    if (text === "") return false;
    const at = this.now();
    const key = `${announcement.urgency}\u0000${text}`;
    const before = this.last.get(key);
    if (before !== undefined && at - before < this.burstMs) return false;
    this.last.set(key, at);
    this.forgetOld(at);
    const held = this.current[announcement.urgency];
    const next = held === text ? `${text}${NBSP}` : text;
    this.current = { ...this.current, [announcement.urgency]: next };
    this.emit();
    return true;
  }

  /** Empties the regions (the announcements were spoken long ago). */
  clear(): void {
    if (this.current.polite === "" && this.current.assertive === "") return;
    this.current = { polite: "", assertive: "" };
    this.emit();
  }

  /** Forgets what was announced, so a test (or a new session) starts from nothing. */
  reset(): void {
    this.last.clear();
    this.clear();
  }

  /** `listener` runs after every change of `state`. Returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private forgetOld(at: number): void {
    for (const [key, when] of this.last) {
      if (at - when >= this.burstMs) this.last.delete(key);
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The announcer of the window. */
export const announcer = new Announcer();

// ---------------------------------------------------------------------------------------------
// The sentences

/** The command as it is spoken: on one line, and cut when it is long. */
function spoken(command: string): string {
  const line = command.replace(/\s+/g, " ").trim();
  return line.length <= MAX_COMMAND_CHARS ? line : `${line.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

/** Where the person is, as far as the announcer follows it: the space and the tab on screen. */
export interface NavigationPoint {
  spaceId: string;
  spaceName: string;
  itemId: string | undefined;
  tabName: string;
}

/**
 * What switching from `before` to `after` says: the space (with its tab) when the space changed, the
 * tab when only the tab did, nothing when neither did (a tab that was renamed, say) or when there is
 * no `before` (the window just opened).
 */
export function navigationAnnouncement(
  before: NavigationPoint | undefined,
  after: NavigationPoint,
): Announcement | undefined {
  if (before === undefined) return undefined;
  if (before.spaceId !== after.spaceId) {
    return {
      urgency: "polite",
      text: t("announce.space", { space: after.spaceName, name: after.tabName }),
    };
  }
  if (before.itemId !== after.itemId && after.itemId !== undefined) {
    return { urgency: "polite", text: t("announce.tab", { name: after.tabName }) };
  }
  return undefined;
}

/**
 * A command that ended. A code other than 0 is an error and is announced assertively; no code (the
 * shell did not say) and 0 are polite.
 */
export function commandAnnouncement(
  command: string | undefined,
  exitCode: number | undefined,
): Announcement {
  const text = command === undefined ? "" : spoken(command);
  if (exitCode === undefined) {
    return {
      urgency: "polite",
      text: text === "" ? t("announce.command.done") : t("announce.command.doneNamed", { text }),
    };
  }
  const urgency = exitCode === 0 ? "polite" : "assertive";
  return {
    urgency,
    text:
      text === ""
        ? t("announce.command.exit", { code: exitCode })
        : t("announce.command.exitNamed", { code: exitCode, text }),
  };
}

/** The bell rang in the tab called `name`. */
export function bellAnnouncement(name: string): Announcement {
  return { urgency: "polite", text: t("announce.bell", { name }) };
}

/** The shell of the tab called `name` ended with `code`; a code other than 0 is an error. */
export function sessionEndedAnnouncement(name: string, code: number): Announcement {
  return {
    urgency: code === 0 ? "polite" : "assertive",
    text: t("announce.sessionEnded", { name, code }),
  };
}

/** The result of a Pull or a Push, in the sentence the sync already worded; an alert is an error. */
export function syncAnnouncement(message: { text: string; alert: boolean }): Announcement {
  return { urgency: message.alert ? "assertive" : "polite", text: message.text };
}

/** The name of the tab that holds a pane, in any space; undefined when no open tab does. */
export function tabNameOfPane(workspace: Workspace, paneId: Id): string | undefined {
  for (const space of workspace.spaces) {
    for (const item of Object.values(space.items)) {
      if (layoutPanes(item.layout).some((pane) => pane.id === paneId)) {
        return itemTitle(space, item.id);
      }
    }
  }
  return undefined;
}
