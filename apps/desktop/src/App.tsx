import { emit } from "@tauri-apps/api/event";
import { FakeBackend } from "@noren/model";
import type { Id, Item, Pane, Space } from "@noren/model";
import type { ITheme } from "@xterm/xterm";
import { Suspense, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { insideTauri } from "./backend";
import { backend, booted } from "./boot";
import { ConfirmDialog } from "./ConfirmDialog";
import { SpaceDialog } from "./SpaceDialog";
import type { SpaceFormValues } from "./SpaceDialog";
import { SpaceMenu } from "./SpaceMenu";
import type { MenuPoint } from "./SpaceMenu";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { createWheelGesture, spaceShortcutIndex, wheelTravel } from "./spaces";
import { TerminalView } from "./TerminalView";
import { applySpaceColor, applyTheme, terminalTheme } from "./theme";
import { TitleBar } from "./TitleBar";
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

/** What covers the shell: a space menu, or a dialog about one space (or a new one). */
type Overlay =
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

function Shell({ store }: { store: WorkspaceStore }) {
  const workspace = useStore(store, (state) => state.workspace);
  const newTab = useStore(store, (state) => state.newTab);
  const activateItem = useStore(store, (state) => state.activateItem);
  const activateSpace = useStore(store, (state) => state.activateSpace);
  const createSpace = useStore(store, (state) => state.createSpace);
  const editSpace = useStore(store, (state) => state.editSpace);
  const deleteSpace = useStore(store, (state) => state.deleteSpace);
  const moveSpace = useStore(store, (state) => state.moveSpace);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const handles = useRef(new Map<Id, TerminalHandle>());
  const theme = useTheme();
  const colors = useMemo(() => terminalTheme(theme), [theme]);

  const space = activeSpaceOf(workspace);
  const activeId = activeItemIdOf({ workspace });
  const itemIds = spaceItemIds(space);
  const spaceColor = space.color;

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
    overlay !== null && overlay.kind !== "new"
      ? workspace.spaces.find((s) => s.id === overlay.spaceId)
      : undefined;
  let overlayNode: React.ReactNode = null;
  if (overlay?.kind === "new") {
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
        <ul key={space.id} className="tab-list" aria-label="Tabs">
          {itemIds.map((id, index) => {
            const item = space.items[id];
            if (!item) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  className="tab-button"
                  data-nr-part="item"
                  data-nr-state={id === activeId ? "active" : undefined}
                  aria-current={id === activeId ? "true" : undefined}
                  onClick={() => activateItem(id)}
                >
                  {item.title ?? `Tab ${index + 1}`}
                </button>
              </li>
            );
          })}
        </ul>
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
