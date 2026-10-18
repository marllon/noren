import { emit } from "@tauri-apps/api/event";
import { FakeBackend, treeGroups } from "@noren/model";
import type { Id, Item, Pane, Space } from "@noren/model";
import type { ITheme } from "@xterm/xterm";
import { Suspense, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { insideTauri } from "./backend";
import { backend, booted } from "./boot";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  clickSelection,
  menuTargets,
  visibleItemIds,
  visibleRows,
  visibleSelection,
} from "./sidebar-tree";
import type { ClickModifiers, Selection } from "./sidebar-tree";
import { SidebarTree } from "./SidebarTree";
import type { Editing } from "./SidebarTree";
import { SpaceDialog } from "./SpaceDialog";
import type { SpaceFormValues } from "./SpaceDialog";
import { SpaceMenu } from "./SpaceMenu";
import type { MenuPoint } from "./SpaceMenu";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { createWheelGesture, spaceShortcutIndex, wheelTravel } from "./spaces";
import { TerminalView } from "./TerminalView";
import { applySpaceColor, applyTheme, terminalTheme } from "./theme";
import { TitleBar } from "./TitleBar";
import { GroupContextMenu, ItemContextMenu } from "./TreeMenus";
import { useTheme } from "./use-theme";
import type { TerminalHandle } from "./TerminalView";
import {
  activeItemIdOf,
  activeSpaceOf,
  sessionStartOptions,
  spaceItemIds,
} from "./workspace-store";
import type { NewSpaceInput, SessionStartOptions, WorkspaceStore } from "./workspace-store";

/** Read-only view of the active terminal, published only when the backend is the in-memory one. */
export interface NorenTestHook {
  lines(): string[];
  renderer(): "webgl" | "dom";
  /** Number of `write` calls the backend received. */
  writeCalls(): number;
  /** Ids of the sessions the backend was asked to kill, in order. */
  killedSessions(): number[];
  /** Options of every `createSession` call the backend received, in order. */
  sessionStarts(): { profileId?: string; cwd?: string; env?: Record<string, string> }[];
}

declare global {
  interface Window {
    __norenTest?: NorenTestHook;
  }
}

/** The pane a tab shows: the focused one (splits arrive in phase 5). */
function shownPane(item: Item): Pane | undefined {
  const find = (layout: Item["layout"]): Pane | undefined => {
    if (layout.kind === "pane")
      return layout.pane.id === item.focusedPaneId ? layout.pane : undefined;
    for (const child of layout.children) {
      const found = find(child);
      if (found) return found;
    }
    return undefined;
  };
  return find(item.layout);
}

interface PaneTerminalProps {
  store: WorkspaceStore;
  space: Space;
  pane: Pane;
  active: boolean;
  colors: ITheme;
  onReady(paneId: Id, handle: TerminalHandle): void;
}

/** One terminal bound to one pane; it stays mounted (hidden) while another tab shows. */
function PaneTerminal({ store, space, pane, active, colors, onReady }: PaneTerminalProps) {
  const { profileId, cwd, env } = sessionStartOptions(space, pane);
  return (
    <div className="pane-slot" data-nr-part="pane" hidden={!active}>
      <TerminalView
        backend={backend}
        theme={colors}
        active={active}
        {...(pane.sessionId !== undefined ? { attach: Number(pane.sessionId) } : {})}
        {...(profileId !== undefined ? { profileId } : {})}
        {...(cwd !== undefined ? { cwd } : {})}
        {...(env !== undefined ? { env } : {})}
        onSessionStart={(id) => store.getState().attachSession(pane.id, String(id))}
        onReady={(handle) => onReady(pane.id, handle)}
      />
    </div>
  );
}

/** What covers the shell: a tab, group or space menu, or a dialog about one space (or a new one). */
type Overlay =
  | { kind: "item-menu"; targets: Id[]; point: MenuPoint }
  | { kind: "group-menu"; groupId: Id; point: MenuPoint }
  | { kind: "menu"; spaceId: Id; point: MenuPoint }
  | { kind: "new" }
  | { kind: "edit"; spaceId: Id }
  | { kind: "delete"; spaceId: Id };

/** What the new-space dialog hands the store: no folder and no environment when left blank. */
function newSpaceInput(values: SpaceFormValues): NewSpaceInput {
  return {
    name: values.name,
    icon: values.icon,
    color: values.color,
    ...(values.cwd !== "" ? { cwd: values.cwd } : {}),
    ...(Object.keys(values.env).length > 0 ? { env: values.env } : {}),
    ...(values.gitIdentity.name !== "" || values.gitIdentity.email !== ""
      ? { gitIdentity: values.gitIdentity }
      : {}),
  };
}

/** The multi-selection of the sidebar, tied to the space it was made in. */
type SpaceSelection = Selection & { spaceId: Id };

function Shell({ store }: { store: WorkspaceStore }) {
  const workspace = useStore(store, (state) => state.workspace);
  const newTab = useStore(store, (state) => state.newTab);
  const activateItem = useStore(store, (state) => state.activateItem);
  const activateSpace = useStore(store, (state) => state.activateSpace);
  const createSpace = useStore(store, (state) => state.createSpace);
  const editSpace = useStore(store, (state) => state.editSpace);
  const deleteSpace = useStore(store, (state) => state.deleteSpace);
  const moveSpace = useStore(store, (state) => state.moveSpace);
  const dispatch = useStore(store, (state) => state.dispatch);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [selection, setSelection] = useState<SpaceSelection>({ spaceId: "", ids: [] });
  const [editing, setEditing] = useState<Editing | null>(null);
  const handles = useRef(new Map<Id, TerminalHandle>());
  const theme = useTheme();
  const colors = useMemo(() => terminalTheme(theme), [theme]);

  const space = activeSpaceOf(workspace);
  const activeId = activeItemIdOf({ workspace });
  const spaceColor = space.color;
  const itemIds = spaceItemIds(space);
  const rows = visibleRows(space);
  const order = visibleItemIds(rows);
  // A selection belongs to the space it was made in and only counts tabs that are on screen.
  const selected = selection.spaceId === space.id ? visibleSelection(selection, order) : [];
  const editingHere =
    editing !== null &&
    (editing.kind === "item"
      ? space.items[editing.id] !== undefined
      : treeGroups(space.tree).some((group) => group.id === editing.id))
      ? editing
      : null;

  const clearSelection = () => setSelection({ spaceId: space.id, ids: [] });

  const onItemClick = (itemId: Id, modifiers: ClickModifiers) => {
    const current = selection.spaceId === space.id ? selection : { ids: [] };
    const next = clickSelection(current, order, itemId, modifiers, activeId);
    setSelection({ spaceId: space.id, ...next });
    if (!modifiers.toggle && !modifiers.shift) activateItem(itemId);
  };

  /** Puts the keyboard focus back on a row once the field that replaced it is gone. */
  const focusRow = (id: Id) => {
    requestAnimationFrame(() => {
      sidebarRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus();
    });
  };

  const startEdit = (target: Editing) => {
    setOverlay(null);
    setEditing(target);
  };

  const onCommitEdit = (target: Editing, value: string, restoreFocus: boolean) => {
    setEditing(null);
    if (target.kind === "group") {
      dispatch({ type: "group/rename", groupId: target.id, name: value });
    } else {
      const item = space.items[target.id];
      // The placeholder ("Tab 3") is not a name the user chose; keep the title unlocked.
      const placeholder = `Tab ${itemIds.indexOf(target.id) + 1}`;
      if (item && !(item.title === undefined && value.trim() === placeholder)) {
        dispatch({ type: "item/rename", itemId: target.id, title: value });
      }
    }
    if (restoreFocus) focusRow(target.id);
  };

  const onCancelEdit = () => {
    if (editingHere) focusRow(editingHere.id);
    setEditing(null);
  };

  // The active space tinges the accent. After the theme's own effect, which sets the accent.
  useEffect(() => {
    applySpaceColor(document.documentElement, theme, spaceColor);
  }, [theme, spaceColor]);

  // Ctrl+Alt+1..9 switches space. Captured on the window so the terminal never sees the keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const index = spaceShortcutIndex(event);
      if (index === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      store.getState().activateSpaceAt(index);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [store]);

  // A horizontal wheel (or Shift+wheel) over the sidebar steps to the neighbor space and stops at
  // the ends. The listener is not passive so it can cancel the event, and it does that only when it
  // switches; it sits on the sidebar, so the terminal never sees these events.
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return undefined;
    const gesture = createWheelGesture();
    const onWheel = (event: WheelEvent) => {
      const travel = wheelTravel(event);
      if (travel === 0) return;
      const step = gesture(travel, event.timeStamp);
      if (step === 0) return;
      const state = store.getState();
      const from = state.workspace.spaces.findIndex((s) => s.id === state.workspace.activeSpaceId);
      if (from < 0 || state.workspace.spaces[from + step] === undefined) return;
      event.preventDefault();
      state.activateSpaceAt(from + step);
    };
    sidebar.addEventListener("wheel", onWheel, { passive: false });
    return () => sidebar.removeEventListener("wheel", onWheel);
  }, [store]);

  useEffect(() => {
    if (backend instanceof FakeBackend) {
      const fake = backend;
      const current = () => {
        const state = store.getState();
        const itemId = activeItemIdOf(state);
        const item =
          itemId === undefined ? undefined : activeSpaceOf(state.workspace).items[itemId];
        const pane = item && shownPane(item);
        return pane && handles.current.get(pane.id);
      };
      window.__norenTest = {
        lines: () => current()?.readLines() ?? [],
        renderer: () => current()?.renderer() ?? "dom",
        writeCalls: () => fake.callsTo("write").length,
        killedSessions: () => fake.callsTo("kill").map((call) => Number(call.args[0])),
        sessionStarts: () =>
          fake.callsTo("createSession").map((call) => {
            const { profileId, cwd, env } = call.args[0] as SessionStartOptions;
            return {
              ...(profileId !== undefined ? { profileId } : {}),
              ...(cwd !== undefined ? { cwd } : {}),
              ...(env !== undefined ? { env } : {}),
            };
          }),
      };
    }
    if (insideTauri) {
      // Tells the Rust side the interface is mounted (used by `noren --smoke`).
      emit("app-ready").catch(() => undefined);
    }
  }, [store]);

  const recordHandle = (paneId: Id, handle: TerminalHandle) => {
    handles.current.set(paneId, handle);
  };

  const close = () => setOverlay(null);
  const overlaySpace =
    overlay?.kind === "menu" || overlay?.kind === "edit" || overlay?.kind === "delete"
      ? workspace.spaces.find((s) => s.id === overlay.spaceId)
      : undefined;
  const overlayGroup =
    overlay?.kind === "group-menu"
      ? treeGroups(space.tree).find((group) => group.id === overlay.groupId)
      : undefined;
  let overlayNode: React.ReactNode = null;
  if (overlay?.kind === "item-menu") {
    overlayNode = (
      <ItemContextMenu
        store={store}
        workspace={workspace}
        targets={overlay.targets.filter((id) => space.items[id] !== undefined)}
        point={overlay.point}
        onClose={close}
        onDone={() => {
          clearSelection();
          close();
        }}
        onRename={(itemId) => startEdit({ kind: "item", id: itemId })}
        onGrouped={(groupId) => setEditing({ kind: "group", id: groupId })}
      />
    );
  } else if (overlayGroup !== undefined && overlay?.kind === "group-menu") {
    overlayNode = (
      <GroupContextMenu
        store={store}
        group={overlayGroup}
        point={overlay.point}
        onClose={close}
        onRename={(groupId) => startEdit({ kind: "group", id: groupId })}
      />
    );
  } else if (overlay?.kind === "new") {
    overlayNode = (
      <SpaceDialog
        onCancel={close}
        onSubmit={(values) => {
          createSpace(newSpaceInput(values));
          close();
        }}
      />
    );
  } else if (overlaySpace !== undefined && overlay?.kind === "menu") {
    overlayNode = (
      <SpaceMenu
        space={overlaySpace}
        index={workspace.spaces.indexOf(overlaySpace)}
        count={workspace.spaces.length}
        point={overlay.point}
        onEdit={() => setOverlay({ kind: "edit", spaceId: overlaySpace.id })}
        onMove={(delta) => {
          moveSpace(overlaySpace.id, workspace.spaces.indexOf(overlaySpace) + delta);
          close();
        }}
        onDelete={() => setOverlay({ kind: "delete", spaceId: overlaySpace.id })}
        onClose={close}
      />
    );
  } else if (overlaySpace !== undefined && overlay?.kind === "edit") {
    overlayNode = (
      <SpaceDialog
        space={overlaySpace}
        onCancel={close}
        onSubmit={(values) => {
          editSpace(overlaySpace.id, values);
          close();
        }}
      />
    );
  } else if (overlaySpace !== undefined && overlay?.kind === "delete") {
    const tabCount = spaceItemIds(overlaySpace).length;
    overlayNode = (
      <ConfirmDialog
        title="Delete space"
        message={`Delete "${overlaySpace.name}"? Its ${tabCount === 1 ? "1 tab" : `${tabCount} tabs`} will be closed and the shells running in them will end.`}
        confirmLabel="Delete space"
        onCancel={close}
        onConfirm={() => {
          deleteSpace(overlaySpace.id);
          close();
        }}
      />
    );
  }

  return (
    <div className="app-body">
      <aside ref={sidebarRef} className="sidebar" data-nr-part="sidebar" aria-label="Sidebar">
        <SidebarTree
          space={space}
          rows={rows}
          activeId={activeId}
          selected={selected}
          editing={editingHere}
          onItemClick={onItemClick}
          onItemMenu={(itemId, point) => {
            const targets = menuTargets(selected, itemId);
            if (targets.length === 1 && !selected.includes(itemId)) clearSelection();
            setOverlay({ kind: "item-menu", targets, point });
          }}
          onGroupMenu={(groupId, point) => setOverlay({ kind: "group-menu", groupId, point })}
          onToggleGroup={(group) =>
            dispatch({
              type: "group/set-collapsed",
              groupId: group.id,
              collapsed: !group.collapsed,
            })
          }
          onStartEdit={setEditing}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
        />
        <button type="button" className="new-tab" onClick={() => newTab()}>
          New tab
        </button>
        <SpaceSwitcher
          spaces={workspace.spaces}
          activeSpaceId={space.id}
          onActivate={activateSpace}
          onNewSpace={() => setOverlay({ kind: "new" })}
          onMenu={(spaceId, point) => setOverlay({ kind: "menu", spaceId, point })}
        />
      </aside>
      <section className="content" aria-label="Content">
        {workspace.spaces.map((s) => (
          <div key={s.id} className="space-layer" hidden={s.id !== space.id}>
            {Object.values(s.items).flatMap((item) => {
              const pane = shownPane(item);
              if (!pane) return [];
              return [
                <PaneTerminal
                  key={pane.id}
                  store={store}
                  space={s}
                  pane={pane}
                  active={s.id === space.id && item.id === activeId}
                  colors={colors}
                  onReady={recordHandle}
                />,
              ];
            })}
          </div>
        ))}
      </section>
      {overlayNode}
    </div>
  );
}

function Booted() {
  const result = use(booted);
  if (!result.ok) return <p role="alert">{result.error}</p>;
  return <Shell store={result.store} />;
}

export function App() {
  const theme = useTheme();
  // Before paint, so the first frame already has the colors.
  useLayoutEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  return (
    <main className="app">
      <TitleBar />
      <Suspense fallback={null}>
        <Booted />
      </Suspense>
    </main>
  );
}
