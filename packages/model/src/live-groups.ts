import type { Clock } from "./clock";
import type { Backend, Worktree } from "./backend";
import type { GroupNode, Id, LiveSource, Node, Workspace } from "./types";

// Live groups (NOR-F17-04a): a group whose entries come from the machine, not from the person. The
// group says where they come from (`GroupNode.live`); `LiveGroups` asks every live group of the
// workspace at the start and then on an interval, keeps the last list it got for each and tells its
// subscribers when one changes. An entry is not a tab: it only stands for something that can be
// opened (a worktree, a host, a container), so an entry that goes away closes nothing. Opening one
// (`planOpenLiveEntry`) focuses the tab of the group that already stands for it, or asks for a new
// one with the folder and command of the entry. Everything the updater touches (the clock, the
// workspace, the sources) is handed in, so the rules are tested with none of the real ones.

/** Milliseconds between two rounds of questions to the sources. */
export const LIVE_REFRESH_INTERVAL_MS = 10_000;

/** One thing a live group offers to open. */
export interface LiveEntry {
  /** Names the entry within its group, stable across rounds: it is what `Item.liveKey` holds. */
  key: string;
  /** What the sidebar shows. */
  label: string;
  /** The folder of the shell the entry opens; blank means the one of the space. */
  cwd: string;
  /** Typed into the new shell when the entry is opened (`ssh <host>`, `docker exec ...`). */
  command?: string;
}

/** How a source answers: the entries now, or a rejection. */
export type LiveSourceQuery<S extends LiveSource = LiveSource> = (
  live: S,
) => Promise<readonly LiveEntry[]>;

/** The sources the updater can ask, by the `source` of `GroupNode.live`. A missing one is an error to report. */
export type LiveSources = {
  [K in LiveSource["source"]]?: LiveSourceQuery<Extract<LiveSource, { source: K }>>;
};

/** What is wrong with `value` as a `GroupNode.live`, or `undefined` when it is one. */
export function liveSourceProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not an object";
  }
  const record = value as Record<string, unknown>;
  switch (record["source"]) {
    case "worktrees":
      return typeof record["folder"] === "string" && record["folder"].trim() !== ""
        ? undefined
        : "worktrees needs a folder";
    case "ssh":
    case "docker":
      return undefined;
    default:
      return 'source is not "worktrees", "ssh" or "docker"';
  }
}

export function isLiveSource(value: unknown): value is LiveSource {
  return liveSourceProblem(value) === undefined;
}

/** Whether two live sources ask for the same thing. */
export function sameLiveSource(a: LiveSource, b: LiveSource): boolean {
  if (a.source !== b.source) return false;
  return a.source === "worktrees" && b.source === "worktrees" ? a.folder === b.folder : true;
}

/** The live groups of the workspace (every space, every depth), by group id. */
export function liveGroupsOf(ws: Workspace): Map<Id, LiveSource> {
  const found = new Map<Id, LiveSource>();
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.kind !== "group") continue;
      if (node.live !== undefined) found.set(node.id, node.live);
      walk(node.children);
    }
  };
  for (const space of ws.spaces) walk(space.tree);
  return found;
}

/** The tab of a live group that stands for the entry `key`: its space and its item. */
export function findLiveItem(
  ws: Workspace,
  groupId: Id,
  key: string,
): { spaceId: Id; itemId: Id } | undefined {
  for (const space of ws.spaces) {
    const group = findGroupNode(space.tree, groupId);
    if (group === undefined) continue;
    const itemId = firstItemWithKey(group.children, (id) => space.items[id]?.liveKey === key);
    return itemId === undefined ? undefined : { spaceId: space.id, itemId };
  }
  return undefined;
}

function findGroupNode(nodes: readonly Node[], groupId: Id): GroupNode | undefined {
  for (const node of nodes) {
    if (node.kind !== "group") continue;
    if (node.id === groupId) return node;
    const inside = findGroupNode(node.children, groupId);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

function firstItemWithKey(nodes: readonly Node[], matches: (id: Id) => boolean): Id | undefined {
  for (const node of nodes) {
    if (node.kind === "item") {
      if (matches(node.id)) return node.id;
      continue;
    }
    const inside = firstItemWithKey(node.children, matches);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

/** What opening an entry does: show the tab that already stands for it, or make one. */
export type LiveOpen =
  { kind: "focus"; spaceId: Id; itemId: Id } | { kind: "create"; spaceId: Id; entry: LiveEntry };

/**
 * Decides what opening the entry `key` of the live group `groupId` does. A tab of the group with
 * that `liveKey` is shown, whether or not the entry is still listed (the tab outlives the entry);
 * otherwise a listed entry gets a new tab. `undefined` when the group is gone or not live, or when
 * there is neither a tab nor an entry for the key.
 */
export function planOpenLiveEntry(
  ws: Workspace,
  groupId: Id,
  key: string,
  entries: readonly LiveEntry[],
): LiveOpen | undefined {
  if (!liveGroupsOf(ws).has(groupId)) return undefined;
  const tab = findLiveItem(ws, groupId, key);
  if (tab !== undefined) return { kind: "focus", ...tab };
  const entry = entries.find((candidate) => candidate.key === key);
  if (entry === undefined) return undefined;
  const space = ws.spaces.find((candidate) => findGroupNode(candidate.tree, groupId) !== undefined);
  return space === undefined ? undefined : { kind: "create", spaceId: space.id, entry };
}

// ---------------------------------------------------------------------------------------------
// The source of worktrees.

/** The last segment of a path, `/` or `\` as separator. */
function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/** The entry of a worktree: named by its folder, labelled by its branch (else its commit). */
export function worktreeEntry(worktree: Worktree): LiveEntry {
  const label =
    worktree.branch ??
    (worktree.head !== null ? `detached ${worktree.head.slice(0, 7)}` : folderName(worktree.path));
  return { key: worktree.path, label: label === "" ? worktree.path : label, cwd: worktree.path };
}

/** The worktrees of the repository of `live.folder`, as `Backend.listWorktrees` lists them. */
export function worktreesSource(
  backend: Pick<Backend, "listWorktrees">,
): LiveSourceQuery<Extract<LiveSource, { source: "worktrees" }>> {
  return async (live) => (await backend.listWorktrees(live.folder)).map(worktreeEntry);
}

// ---------------------------------------------------------------------------------------------
// The source of SSH hosts (NOR-F17-04c).

/**
 * What a host name may be to be typed into a shell as `ssh <host>`: letters, digits, `.`, `-` and `_`,
 * not starting with `-` (it would be read as an option). The same rule the core applies when it reads
 * the `~/.ssh/config`; checked again here because the command goes to a shell.
 */
const SSH_HOST_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/**
 * The entry of an SSH host: named and labelled by the host, opening a shell in the folder of the
 * space (blank `cwd`) that types `ssh <host>`. `undefined` for a name that is not safe to type.
 */
export function sshEntry(host: string): LiveEntry | undefined {
  if (host.length > 255 || !SSH_HOST_NAME.test(host)) return undefined;
  return { key: host, label: host, cwd: "", command: `ssh ${host}` };
}

/** The hosts of the `~/.ssh/config`, as `Backend.listSshHosts` lists them. */
export function sshSource(
  backend: Pick<Backend, "listSshHosts">,
): LiveSourceQuery<Extract<LiveSource, { source: "ssh" }>> {
  return async () => {
    const entries: LiveEntry[] = [];
    for (const host of await backend.listSshHosts()) {
      const entry = sshEntry(host);
      if (entry !== undefined) entries.push(entry);
    }
    return entries;
  };
}

/** The sources the app has: the worktrees and the SSH hosts. */
export function liveSourcesOf(
  backend: Pick<Backend, "listWorktrees" | "listSshHosts">,
): LiveSources {
  return { worktrees: worktreesSource(backend), ssh: sshSource(backend) };
}

// ---------------------------------------------------------------------------------------------
// The updater.

export interface LiveGroupsOptions {
  /** The timer of the rounds. */
  clock: Pick<Clock, "setTimer">;
  /** The workspace now; read at every round, so a group made or removed counts at the next one. */
  workspace(): Workspace;
  sources: LiveSources;
  /** Milliseconds between rounds. Default `LIVE_REFRESH_INTERVAL_MS`. */
  intervalMs?: number;
  /** A source failed for a group; the group keeps its last list. */
  onError?(groupId: Id, error: unknown): void;
}

interface GroupState {
  live: LiveSource;
  entries: readonly LiveEntry[];
  error: string | undefined;
}

const NO_ENTRIES: readonly LiveEntry[] = [];

export class LiveGroups {
  readonly #options: LiveGroupsOptions;
  readonly #state = new Map<Id, GroupState>();
  readonly #asking = new Map<Id, Promise<void>>();
  readonly #listeners = new Set<() => void>();
  #cancel: (() => void) | undefined;

  constructor(options: LiveGroupsOptions) {
    this.#options = options;
  }

  /** The entries of a live group, from the last answer of its source; none before the first one. */
  entries(groupId: Id): readonly LiveEntry[] {
    return this.#state.get(groupId)?.entries ?? NO_ENTRIES;
  }

  /** Why the last question of the group failed, or `undefined` when it was answered (or not asked). */
  error(groupId: Id): string | undefined {
    return this.#state.get(groupId)?.error;
  }

  /** Calls `listener` after an entry list or an error changes. Returns the way to stop. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Asks every live group now, then every `intervalMs`. Starting a running updater changes nothing. */
  start(): void {
    if (this.#cancel !== undefined) return;
    const interval = this.#options.intervalMs ?? LIVE_REFRESH_INTERVAL_MS;
    const schedule = (): void => {
      this.#cancel = this.#options.clock.setTimer(() => {
        // The next round is set first, so the cadence does not depend on how long the sources take.
        schedule();
        void this.refresh();
      }, interval);
    };
    schedule();
    void this.refresh();
  }

  /** Stops the rounds. Questions already on their way still end, and are kept. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }

  /**
   * One round: forgets the groups that are gone or no longer live (or live on something else), asks
   * the others, and resolves when the answers are in. A group still being asked is not asked twice.
   * Never rejects.
   */
  async refresh(): Promise<void> {
    const live = liveGroupsOf(this.#options.workspace());
    let changed = false;
    for (const [groupId, state] of [...this.#state]) {
      const now = live.get(groupId);
      if (now === undefined || !sameLiveSource(now, state.live)) {
        this.#state.delete(groupId);
        changed = true;
      }
    }
    if (changed) this.#notify();
    for (const [groupId, source] of live) {
      if (this.#asking.has(groupId)) continue;
      const asking = this.#ask(groupId, source).finally(() => {
        this.#asking.delete(groupId);
      });
      this.#asking.set(groupId, asking);
    }
    await this.idle();
  }

  /** Resolves when no question is on its way. */
  async idle(): Promise<void> {
    while (this.#asking.size > 0) await Promise.all([...this.#asking.values()]);
  }

  async #ask(groupId: Id, source: LiveSource): Promise<void> {
    const query = this.#options.sources[source.source] as LiveSourceQuery | undefined;
    let entries: readonly LiveEntry[] | undefined;
    let failure: unknown;
    try {
      if (query === undefined) throw new Error(`no source for "${source.source}"`);
      entries = cleanEntries(await query(source));
    } catch (error) {
      failure = error;
    }
    // The group may have gone, or been pointed elsewhere, while the source was answering.
    const current = liveGroupsOf(this.#options.workspace()).get(groupId);
    if (current === undefined || !sameLiveSource(current, source)) return;

    const before = this.#state.get(groupId);
    if (entries === undefined) {
      const error = failure instanceof Error ? failure.message : String(failure);
      this.#state.set(groupId, {
        live: source,
        entries: before?.entries ?? NO_ENTRIES,
        error,
      });
      try {
        this.#options.onError?.(groupId, failure);
      } catch {
        // A reporter that throws must not stop the rounds.
      }
      if (before === undefined || before.error !== error) this.#notify();
      return;
    }
    const same = before !== undefined && sameEntries(before.entries, entries);
    this.#state.set(groupId, {
      live: source,
      entries: same ? before.entries : entries,
      error: undefined,
    });
    if (before === undefined || !same || before.error !== undefined) this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A subscriber that throws must not keep the others from hearing.
      }
    }
  }
}

/** Drops what a source should not hand over: a blank key or label, a repeated key (the first stays). */
function cleanEntries(entries: readonly LiveEntry[]): LiveEntry[] {
  const seen = new Set<string>();
  const clean: LiveEntry[] = [];
  for (const entry of entries) {
    if (typeof entry.key !== "string" || entry.key === "" || seen.has(entry.key)) continue;
    if (typeof entry.label !== "string" || entry.label === "") continue;
    seen.add(entry.key);
    clean.push({
      key: entry.key,
      label: entry.label,
      cwd: typeof entry.cwd === "string" ? entry.cwd : "",
      ...(typeof entry.command === "string" && entry.command !== ""
        ? { command: entry.command }
        : {}),
    });
  }
  return clean;
}

function sameEntries(a: readonly LiveEntry[], b: readonly LiveEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        entry.key === other.key &&
        entry.label === other.label &&
        entry.cwd === other.cwd &&
        entry.command === other.command
      );
    })
  );
}
