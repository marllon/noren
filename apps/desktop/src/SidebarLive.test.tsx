import { FakeBackend, ManualClock, createSequentialIds, restoreWorkspace } from "@noren/model";
import type { Backend, Id, LiveEntry, Space, Worktree } from "@noren/model";
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveEntryRows } from "./LiveEntries";
import { SidebarTree } from "./SidebarTree";
import { setLanguage } from "./i18n";
import {
  liveGroupsVersion,
  refreshLiveGroups,
  startLiveGroups,
  stopLiveGroups,
  subscribeLiveGroups,
} from "./live-groups-service";
import { visibleRows } from "./sidebar-tree";
import { createWorkspaceStore } from "./workspace-store";

// The entries of a live group in the sidebar (NOR-F17-04b), rendered to markup on the server side of
// React: which rows a live group gets, that a common group gets none, what a click on an entry does
// and that the list follows the notice of the updater. The click on a real page, the keyboard and
// the look are in e2e/live-groups.spec.ts.

// The stores that mark the rows (agents, links) have no snapshot for the server side of React; the
// tabs these tests draw have none of those marks, so their hooks are stood in for by empty ones.
vi.mock("./agent-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-store")>()),
  useAgentOfPane: () => () => undefined,
}));
vi.mock("./agent-state-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-state-store")>()),
  useAgentStateOfPane: () => () => undefined,
}));
vi.mock("./session-link-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-link-store")>()),
  useLinkOfPane: () => () => undefined,
}));

const clock = { now: () => 1000 };
const FOLDER = "/work/repo";

const worktree = (path: string, branch: string): Worktree => ({
  path,
  branch,
  head: "abc1234",
  detached: false,
  main: path === FOLDER,
  locked: false,
});

afterEach(() => {
  stopLiveGroups();
  setLanguage("en");
});

/** Every element of a tree of React elements, depth first. */
function elementsOf(node: ReactNode, found: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child as ReactNode, found);
  } else if (isValidElement<Record<string, unknown>>(node)) {
    found.push(node);
    elementsOf(node.props["children"] as ReactNode, found);
  }
  return found;
}

const rowProps = (key: string) => ({
  role: "treeitem" as const,
  tabIndex: -1,
  onFocus: () => undefined,
  "data-tree-key": key,
  "aria-level": 2,
  "aria-setsize": 1,
  "aria-posinset": 1,
});

const entries: LiveEntry[] = [
  { key: FOLDER, label: "main", cwd: FOLDER },
  { key: "/work/repo-dev", label: "dev", cwd: "/work/repo-dev" },
];

describe("LiveEntryRows", () => {
  it("lists one button per entry, named by its label", () => {
    const tree = LiveEntryRows({
      groupId: "g1",
      depth: 0,
      entries,
      error: undefined,
      rowProps,
      onOpen: () => undefined,
    });
    const buttons = elementsOf(tree).filter((el) => el.props["data-nr-part"] === "live-entry");
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.props["data-tree-key"])).toEqual([
      "l:g1:/work/repo",
      "l:g1:/work/repo-dev",
    ]);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain(">main<");
    expect(html).toContain(">dev<");
    expect(html).not.toContain("live-error");
  });

  it("opens the entry that was clicked, in its group", () => {
    const onOpen = vi.fn();
    const tree = LiveEntryRows({
      groupId: "g1",
      depth: 0,
      entries,
      error: undefined,
      rowProps,
      onOpen,
    });
    const buttons = elementsOf(tree).filter((el) => el.props["data-nr-part"] === "live-entry");
    const second = buttons[1]?.props["onClick"] as (() => void) | undefined;
    second?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("g1", "/work/repo-dev");
  });

  it("says quietly that the source failed, keeping the entries it had", () => {
    const draw = () =>
      renderToStaticMarkup(
        LiveEntryRows({
          groupId: "g1",
          depth: 0,
          entries,
          error: "not a git repository",
          rowProps,
          onOpen: () => undefined,
        }),
      );
    const html = draw();
    expect(html).toContain("Could not update: not a git repository");
    expect(html).toContain(">main<");
    setLanguage("pt-BR");
    expect(draw()).toContain("Não foi possível atualizar: not a git repository");
  });
});

interface Rig {
  space(): Space;
  liveId: Id;
  store: ReturnType<typeof createWorkspaceStore>;
}

async function openRig(): Promise<Rig> {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  store.getState().dispatch({
    type: "group/create",
    name: "Worktrees",
    live: { source: "worktrees", folder: FOLDER },
  });
  store.getState().dispatch({ type: "group/create", name: "Plain" });
  const space = (): Space => {
    const found = store.getState().workspace.spaces[0];
    if (found === undefined) throw new Error("no space");
    return found;
  };
  const live = space().tree.find((node) => node.kind === "group" && node.name === "Worktrees");
  if (live === undefined) throw new Error("no live group");
  return { space, liveId: live.id, store };
}

const noop = () => undefined;

function renderTree(rig: Rig, onLiveEntryClick?: (groupId: Id, key: string) => void): string {
  const space = rig.space();
  return renderToStaticMarkup(
    <SidebarTree
      space={space}
      rows={visibleRows(space)}
      activeId={space.activeItemId}
      selected={[]}
      editing={null}
      onItemClick={noop}
      onPaneClick={noop}
      onItemMenu={noop}
      onGroupMenu={noop}
      onToggleGroup={noop}
      onCloseItems={noop}
      onUngroup={noop}
      onStartEdit={noop}
      onCommitEdit={noop}
      onCancelEdit={noop}
      {...(onLiveEntryClick !== undefined ? { onLiveEntryClick } : {})}
    />,
  );
}

function startWith(rig: Rig, worktrees: { current: Worktree[] }, manual = new ManualClock()) {
  const backend: Pick<Backend, "listWorktrees"> = {
    listWorktrees: () => Promise.resolve(worktrees.current),
  };
  return { manual, updater: startLiveGroups({ store: rig.store, backend, clock: manual }) };
}

describe("the sidebar with live groups", () => {
  it("lists the entries under the live group and none under a common group", async () => {
    const rig = await openRig();
    const worktrees = { current: [worktree(FOLDER, "main"), worktree("/work/repo-dev", "dev")] };
    const { updater } = startWith(rig, worktrees);
    await updater.idle();

    const html = renderTree(rig, noop);
    const labels = [...html.matchAll(/data-nr-part="live-entry-label">([^<]*)</g)].map((m) => m[1]);
    expect(labels).toEqual(["main", "dev"]);
    // They come right after the header of the live group, before the common group.
    expect(html.indexOf("Worktrees")).toBeLessThan(html.indexOf(">main<"));
    expect(html.indexOf(">dev<")).toBeLessThan(html.indexOf("Plain"));
    // An entry is not a tab: it is no row of the tabs and no drag source.
    expect(html.match(/data-nr-part="live-entry"/g)).toHaveLength(2);
    // Only the tab the workspace starts with is a tab row; the group counts no tab for its entries.
    expect(html.match(/data-nr-part="item"/g)).toHaveLength(1);
    expect(html.match(/data-nr-part="group-count"[^>]*>0</g)).toHaveLength(2);
    const entryButtons = html.match(/<button[^>]*data-nr-part="live-entry"[^>]*>/g) ?? [];
    for (const button of entryButtons) {
      expect(button).not.toContain("aria-roledescription");
      expect(button).not.toContain("data-row-id");
    }
  });

  it("lists nothing without the way to open an entry, and nothing for a folded group", async () => {
    const rig = await openRig();
    const { updater } = startWith(rig, { current: [worktree(FOLDER, "main")] });
    await updater.idle();
    expect(renderTree(rig)).not.toContain("live-entry");
    rig.store
      .getState()
      .dispatch({ type: "group/set-collapsed", groupId: rig.liveId, collapsed: true });
    expect(renderTree(rig, noop)).not.toContain("live-entry");
  });

  it("shows the error of the source discreetly and keeps the entries it had", async () => {
    const rig = await openRig();
    let failing = false;
    const backend: Pick<Backend, "listWorktrees"> = {
      listWorktrees: () =>
        failing
          ? Promise.reject(new Error("git is gone"))
          : Promise.resolve([worktree(FOLDER, "main")]),
    };
    const manual = new ManualClock();
    const updater = startLiveGroups({ store: rig.store, backend, clock: manual });
    await updater.idle();
    expect(renderTree(rig, noop)).not.toContain("live-error");
    failing = true;
    manual.advance(10_000);
    await updater.idle();
    const html = renderTree(rig, noop);
    expect(html).toContain("Could not update: git is gone");
    expect(html).toContain(">main<");
  });

  it("follows the notice of the updater: a new worktree shows, a gone one leaves", async () => {
    const rig = await openRig();
    const worktrees = { current: [worktree(FOLDER, "main")] };
    const { manual, updater } = startWith(rig, worktrees);
    await updater.idle();

    const heard = vi.fn();
    const stop = subscribeLiveGroups(heard);
    const before = liveGroupsVersion();
    expect(renderTree(rig, noop)).not.toContain(">feature<");

    worktrees.current = [worktree(FOLDER, "main"), worktree("/work/repo-feature", "feature")];
    manual.advance(10_000);
    await updater.idle();
    expect(heard).toHaveBeenCalled();
    expect(liveGroupsVersion()).toBeGreaterThan(before);
    expect(renderTree(rig, noop)).toContain(">feature<");

    worktrees.current = [worktree(FOLDER, "main")];
    manual.advance(10_000);
    await updater.idle();
    expect(renderTree(rig, noop)).not.toContain(">feature<");
    stop();
  });

  it("asks at once when told to, without waiting for the next round", async () => {
    const rig = await openRig();
    const worktrees = { current: [worktree(FOLDER, "main")] };
    const { updater } = startWith(rig, worktrees);
    await updater.idle();
    worktrees.current = [worktree(FOLDER, "main"), worktree("/work/repo-now", "now")];
    expect(renderTree(rig, noop)).not.toContain(">now<");
    await refreshLiveGroups();
    expect(renderTree(rig, noop)).toContain(">now<");
  });

  it("does nothing to refresh when no updater runs", async () => {
    await expect(refreshLiveGroups()).resolves.toBeUndefined();
  });

  it("leaves a sidebar without live groups as it was", async () => {
    const rig = await openRig();
    rig.store.getState().dispatch({ type: "group/set-live", groupId: rig.liveId });
    const { updater } = startWith(rig, { current: [worktree(FOLDER, "main")] });
    await updater.idle();
    expect(renderTree(rig, noop)).toBe(renderTree(rig));
  });
});
