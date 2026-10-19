import type { Id, Item, Space, Workspace } from "@noren/model";
import { layoutPanes } from "@noren/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { itemTitle } from "./favorites";
import { previewLines, stepIndex, switcherOrder, trackMru } from "./mru";
import type { MruList } from "./mru";
import type { TerminalHandle } from "./TerminalView";
import type { WorkspaceStore } from "./workspace-store";

// The Ctrl+Tab switcher. A session starts with the first press of the chord and walks the tabs by
// recent use with each press; the overlay appears from the second press (a quick Ctrl+Tab shows
// nothing); releasing the modifier commits the tab it stands on, Escape cancels. The recent list
// lives here, in memory, and follows the workspace: a tab that shows goes to the front, a tab that
// closes drops out.

/** One row of the overlay. */
export interface MruRow {
  itemId: Id;
  spaceId: Id;
  title: string;
  /** The space the tab is in. */
  detail: string;
  spaceColor: string;
  /** The last lines of the output of the focused pane, oldest first (maybe none). */
  preview: string[];
  selected: boolean;
}

interface Session {
  order: Id[];
  index: number;
  steps: number;
  /** The modifiers held when the chord was pressed: releasing any of them commits. */
  ctrl: boolean;
  alt: boolean;
  previews: Map<Id, string[]> | undefined;
}

interface View {
  order: Id[];
  index: number;
  previews: Map<Id, string[]>;
}

export interface MruSwitcherOptions {
  store: WorkspaceStore;
  /** The mounted terminal of every pane, for the preview. */
  handles: { readonly current: ReadonlyMap<Id, TerminalHandle> };
  /** Shows a tab (switching space if it is in another). */
  onCommit(spaceId: Id, itemId: Id): void;
  /** The session ended, committed or not: the keyboard goes back to the terminal. */
  onEnd(): void;
}

export interface MruSwitcher {
  /** The rows of the overlay, or `undefined` while it is not shown. */
  rows: MruRow[] | undefined;
  /** True between the first press of the chord and the release that ends it. */
  active(): boolean;
  /** One press of Ctrl+Tab (`delta` 1) or Ctrl+Shift+Tab (-1); `event` says which modifiers hold it. */
  step(delta: 1 | -1, event: { ctrlKey: boolean; altKey: boolean }): void;
  /** Ends the session without switching. */
  cancel(): void;
  /** Switches at once to the previous (`1`) or the oldest (`-1`) tab, with no session. */
  jump(delta: 1 | -1): void;
}

function findTab(workspace: Workspace, itemId: Id): { space: Space; item: Item } | undefined {
  for (const space of workspace.spaces) {
    const item = space.items[itemId];
    if (item !== undefined) return { space, item };
  }
  return undefined;
}

/** The preview text of every tab, read from the focused pane of each. */
function readPreviews(
  workspace: Workspace,
  order: readonly Id[],
  handles: ReadonlyMap<Id, TerminalHandle>,
): Map<Id, string[]> {
  const previews = new Map<Id, string[]>();
  for (const itemId of order) {
    const found = findTab(workspace, itemId);
    const pane =
      found && layoutPanes(found.item.layout).find((p) => p.id === found.item.focusedPaneId);
    const lines = pane !== undefined ? handles.get(pane.id)?.readLines() : undefined;
    previews.set(itemId, lines !== undefined ? previewLines(lines) : []);
  }
  return previews;
}

export function useMruSwitcher(options: MruSwitcherOptions): MruSwitcher {
  const { store } = options;
  const latest = useRef(options);
  latest.current = options;
  const recent = useRef<MruList>([]);
  const session = useRef<Session | null>(null);
  const [view, setView] = useState<View | null>(null);

  // The list follows the workspace: the tab on screen goes to the front, closed tabs drop out.
  useEffect(() => {
    recent.current = trackMru(recent.current, store.getState().workspace);
    return store.subscribe((state) => {
      recent.current = trackMru(recent.current, state.workspace);
    });
  }, [store]);

  const finish = useCallback((commit: boolean) => {
    const current = session.current;
    if (current === null) return;
    session.current = null;
    setView(null);
    const itemId = current.order[current.index];
    const target =
      commit && itemId !== undefined && itemId !== current.order[0]
        ? findTab(latest.current.store.getState().workspace, itemId)
        : undefined;
    if (target !== undefined) latest.current.onCommit(target.space.id, target.item.id);
    latest.current.onEnd();
  }, []);

  // Releasing the modifier that holds the chord commits; losing the window cancels.
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      const current = session.current;
      if (current === null) return;
      if ((current.ctrl && !event.ctrlKey) || (current.alt && !event.altKey)) finish(true);
    };
    const onBlur = () => finish(false);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [finish]);

  const step = useCallback((delta: 1 | -1, event: { ctrlKey: boolean; altKey: boolean }) => {
    let current = session.current;
    if (current === null) {
      const order = switcherOrder(recent.current, latest.current.store.getState().workspace);
      if (order.length < 2) return;
      current = {
        order,
        index: 0,
        steps: 0,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        previews: undefined,
      };
      session.current = current;
    }
    current.index = stepIndex(current.order.length, current.index, delta);
    current.steps += 1;
    if (current.steps >= 2) {
      current.previews ??= readPreviews(
        latest.current.store.getState().workspace,
        current.order,
        latest.current.handles.current,
      );
      setView({ order: current.order, index: current.index, previews: current.previews });
    }
  }, []);

  const jump = useCallback((delta: 1 | -1) => {
    const workspace = latest.current.store.getState().workspace;
    const order = switcherOrder(recent.current, workspace);
    const target = order[stepIndex(order.length, 0, delta)];
    const found =
      target !== undefined && target !== order[0] ? findTab(workspace, target) : undefined;
    if (found !== undefined) latest.current.onCommit(found.space.id, found.item.id);
    latest.current.onEnd();
  }, []);

  const rows = useMemo((): MruRow[] | undefined => {
    if (view === null) return undefined;
    const workspace = store.getState().workspace;
    return view.order.flatMap((itemId, index): MruRow[] => {
      const found = findTab(workspace, itemId);
      if (found === undefined) return [];
      return [
        {
          itemId,
          spaceId: found.space.id,
          title: itemTitle(found.space, itemId),
          detail: found.space.name,
          spaceColor: found.space.color,
          preview: view.previews.get(itemId) ?? [],
          selected: index === view.index,
        },
      ];
    });
  }, [view, store]);

  return {
    rows,
    active: () => session.current !== null,
    step,
    cancel: () => finish(false),
    jump,
  };
}
