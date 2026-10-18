import { emit } from "@tauri-apps/api/event";
import { FakeBackend } from "@noren/model";
import type { Id, Item, Pane, Space } from "@noren/model";
import { Suspense, use, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { insideTauri } from "./backend";
import { backend, booted } from "./boot";
import { TerminalView } from "./TerminalView";
import type { TerminalHandle } from "./TerminalView";
import { activeItemIdOf, activeSpaceOf, spaceItemIds } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

/** Read-only view of the active terminal, published only when the backend is the in-memory one. */
export interface NorenTestHook {
  lines(): string[];
  renderer(): "webgl" | "dom";
  /** Number of `write` calls the backend received. */
  writeCalls(): number;
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
  onReady(paneId: Id, handle: TerminalHandle): void;
}

/** One terminal bound to one pane; it stays mounted (hidden) while another tab shows. */
function PaneTerminal({ store, space, pane, active, onReady }: PaneTerminalProps) {
  const cwd = pane.cwd ?? space.defaults.cwd;
  const env = space.defaults.env;
  return (
    <div className="pane-slot" hidden={!active}>
      <TerminalView
        backend={backend}
        active={active}
        {...(pane.sessionId !== undefined ? { attach: Number(pane.sessionId) } : {})}
        {...(pane.profileId !== "default" ? { profileId: pane.profileId } : {})}
        {...(cwd !== undefined ? { cwd } : {})}
        {...(Object.keys(env).length > 0 ? { env } : {})}
        onSessionStart={(id) => store.getState().attachSession(pane.id, String(id))}
        onReady={(handle) => onReady(pane.id, handle)}
      />
    </div>
  );
}

function Shell({ store }: { store: WorkspaceStore }) {
  const workspace = useStore(store, (state) => state.workspace);
  const activeItems = useStore(store, (state) => state.activeItems);
  const newTab = useStore(store, (state) => state.newTab);
  const activateItem = useStore(store, (state) => state.activateItem);
  const handles = useRef(new Map<Id, TerminalHandle>());

  const space = activeSpaceOf(workspace);
  const activeId = activeItemIdOf({ workspace, activeItems });
  const itemIds = spaceItemIds(space);

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

  return (
    <div className="app-body">
      <aside className="sidebar" aria-label="Sidebar">
        <ul className="tab-list" aria-label="Tabs">
          {itemIds.map((id, index) => {
            const item = space.items[id];
            if (!item) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  className="tab-button"
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
      </aside>
      <section className="content" aria-label="Content">
        {workspace.spaces.flatMap((s) =>
          Object.values(s.items).flatMap((item) => {
            const pane = shownPane(item);
            if (!pane) return [];
            return [
              <PaneTerminal
                key={pane.id}
                store={store}
                space={s}
                pane={pane}
                active={s.id === space.id && item.id === activeId}
                onReady={recordHandle}
              />,
            ];
          }),
        )}
      </section>
    </div>
  );
}

function Booted() {
  const result = use(booted);
  if (!result.ok) return <p role="alert">{result.error}</p>;
  return <Shell store={result.store} />;
}

export function App() {
  return (
    <main className="app">
      <header className="app-title">Noren</header>
      <Suspense fallback={null}>
        <Booted />
      </Suspense>
    </main>
  );
}
