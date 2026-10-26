import {
  FakeBackend,
  createSequentialIds,
  layoutPanes,
  restoreWorkspace,
  serializeWorkspace,
} from "@noren/model";
import type { Id, Item, Space } from "@noren/model";
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneList, SidebarTree } from "./SidebarTree";
import type { PaneNaming } from "./SidebarTree";
import { setLanguage } from "./i18n";
import { paneEntries } from "./item-panes";
import { visibleRows } from "./sidebar-tree";
import { createWorkspaceStore } from "./workspace-store";

// The pane rows of a split tab in the sidebar, rendered to markup on the server side of React: the
// name of a pane in bold before its folder, the text field that replaces the row of the pane being
// renamed, and what F2, a double click and a right click on a row ask for. The real keyboard, the menu
// and the reload are in e2e/pane-names.spec.ts.

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

afterEach(() => setLanguage("en"));

const clock = { now: () => 1000 };
const noop = () => undefined;

interface Rig {
  space(): Space;
  item(): Item;
  paneIds(): Id[];
  rename(paneId: Id, name: string): void;
  /** The program of the pane sets (or clears, with an empty text) the title of its terminal. */
  title(paneId: Id, title: string): void;
  /** The text `state.json` would hold now. */
  saved(): string;
}

/** A store with the one tab of a new workspace split in two panes. */
async function openRig(): Promise<Rig> {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  const space = (): Space => {
    const found = store.getState().workspace.spaces[0];
    if (found === undefined) throw new Error("no space");
    return found;
  };
  const item = (): Item => {
    const found = Object.values(space().items)[0];
    if (found === undefined) throw new Error("no tab");
    return found;
  };
  store.getState().dispatch({
    type: "pane/split",
    itemId: item().id,
    paneId: item().focusedPaneId,
    dir: "row",
    side: "after",
  });
  return {
    space,
    item,
    paneIds: () => layoutPanes(item().layout).map((pane) => pane.id),
    rename: (paneId, name) =>
      store.getState().dispatch({ type: "pane/rename", itemId: item().id, paneId, name }),
    title: (paneId, title) => store.getState().setPaneTitle(paneId, title),
    saved: () => serializeWorkspace(store.getState().workspace),
  };
}

function renderTree(rig: Rig, paneNaming?: PaneNaming): string {
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
      {...(paneNaming !== undefined ? { paneNaming } : {})}
    />,
  );
}

function naming(overrides: Partial<PaneNaming> = {}): PaneNaming {
  return {
    editing: null,
    onStart: noop,
    onCommit: noop,
    onCancel: noop,
    onMenu: noop,
    ...overrides,
  };
}

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
  "aria-setsize": 2,
  "aria-posinset": 1,
});

/** The pane rows of the rig drawn by `PaneList` itself, so their handlers can be called. */
function rows(rig: Rig, paneNaming?: PaneNaming) {
  const item = rig.item();
  const space = rig.space();
  const tree = PaneList({
    itemId: item.id,
    label: "tab",
    entries: paneEntries(item, space.defaults.cwd),
    rowProps,
    onPaneClick: noop,
    naming: paneNaming,
  });
  return elementsOf(tree).filter((el) => el.props["data-nr-part"] === "item-pane");
}

const must = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error("missing value");
  return value;
};

describe("the pane rows of a split tab", () => {
  it("write the name of a pane in bold before its folder", async () => {
    const rig = await openRig();
    const [first, second] = rig.paneIds();
    rig.rename(must(first), "Loop Noren");
    rig.rename(must(second), "Dev server");
    const html = renderTree(rig, naming());
    expect(html).toContain(
      '<b class="item-pane-name" data-nr-part="item-pane-name">Loop Noren</b>',
    );
    expect(html).toContain(
      '<b class="item-pane-name" data-nr-part="item-pane-name">Dev server</b>',
    );
    // The name comes first, then the folder the pane goes by.
    expect(html).toMatch(/item-pane-name[^>]*>Loop Noren<\/b><span class="item-pane-folder">/);
  });

  it("show only the folder of a pane that has no name", async () => {
    const rig = await openRig();
    rig.rename(must(rig.paneIds()[0]), "Loop");
    const html = renderTree(rig, naming());
    expect(html.match(/item-pane-name/g)).toHaveLength(2); // class and part of the one name
    expect(html.match(/class="item-pane-folder"/g)).toHaveLength(2);
  });

  it("take the name away again when it is blank", async () => {
    const rig = await openRig();
    const first = must(rig.paneIds()[0]);
    rig.rename(first, "Loop");
    rig.rename(first, "  ");
    expect(renderTree(rig, naming())).not.toContain("item-pane-name");
  });

  it("put a text field named for the pane in place of the row being renamed", async () => {
    const rig = await openRig();
    const [first, second] = rig.paneIds();
    rig.rename(must(first), "Loop");
    const html = renderTree(
      rig,
      naming({ editing: { itemId: rig.item().id, paneId: must(first) } }),
    );
    expect(html).toContain('aria-label="Pane name"');
    expect(html).toContain('value="Loop"');
    // Only that row: the other pane keeps its button.
    expect(html.match(/data-nr-part="item-pane"/g)).toHaveLength(1);
    expect(html).toContain(`data-nr-pane="${must(second)}"`);
    setLanguage("pt-BR");
    expect(
      renderTree(rig, naming({ editing: { itemId: rig.item().id, paneId: must(first) } })),
    ).toContain('aria-label="Nome do painel"');
  });

  it("start with an empty field for a pane that has no name", async () => {
    const rig = await openRig();
    const html = renderTree(
      rig,
      naming({ editing: { itemId: rig.item().id, paneId: must(rig.paneIds()[1]) } }),
    );
    expect(html).toContain('aria-label="Pane name"');
    expect(html).toContain('value=""');
  });
});

describe("a pane row asks to be renamed", () => {
  it("with F2, and with a double click", async () => {
    const rig = await openRig();
    const onStart = vi.fn();
    const [row] = rows(rig, naming({ onStart }));
    const preventDefault = vi.fn();
    const onKeyDown = must(row).props["onKeyDown"] as (event: unknown) => void;
    onKeyDown({ key: "Enter", preventDefault });
    expect(onStart).not.toHaveBeenCalled();
    onKeyDown({ key: "F2", preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(rig.item().id, must(rig.paneIds()[0]));
    (must(row).props["onDoubleClick"] as () => void)();
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("with the menu of the row, at the point of the click", async () => {
    const rig = await openRig();
    const onMenu = vi.fn();
    const [, row] = rows(rig, naming({ onMenu }));
    const preventDefault = vi.fn();
    (must(row).props["onContextMenu"] as (event: unknown) => void)({
      preventDefault,
      clientX: 12,
      clientY: 34,
      currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) },
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(onMenu).toHaveBeenCalledWith(
      rig.item().id,
      must(rig.paneIds()[1]),
      expect.objectContaining({ x: 12, y: 34 }),
    );
  });

  it("not at all in a tree that cannot rename a pane", async () => {
    const rig = await openRig();
    const [row] = rows(rig);
    const preventDefault = vi.fn();
    (must(row).props["onKeyDown"] as (event: unknown) => void)({ key: "F2", preventDefault });
    (must(row).props["onContextMenu"] as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("the pane rows of a split tab with a title from the program", () => {
  it("write the title before the folder of a pane that has no name", async () => {
    const rig = await openRig();
    rig.title(must(rig.paneIds()[0]), "loop Noren");
    const html = renderTree(rig, naming());
    expect(html).toContain(
      '<b class="item-pane-program" data-nr-part="item-pane-program">loop Noren</b>',
    );
    expect(html).toMatch(/item-pane-program[^>]*>loop Noren<\/b><span class="item-pane-folder">/);
    // The other pane has no title: its row is the folder alone.
    expect(html.match(/data-nr-part="item-pane-program"/g)).toHaveLength(1);
    expect(html.match(/class="item-pane-folder"/g)).toHaveLength(2);
  });

  it("give way to the name of the pane", async () => {
    const rig = await openRig();
    const first = must(rig.paneIds()[0]);
    rig.title(first, "loop Noren");
    rig.rename(first, "Loop");
    const html = renderTree(rig, naming());
    expect(html).toContain(">Loop</b>");
    expect(html).not.toContain("loop Noren");
    // Taking the name away brings the title back.
    rig.rename(first, "");
    expect(renderTree(rig, naming())).toContain(">loop Noren</b>");
  });

  it("go back to the folder when the program clears the title", async () => {
    const rig = await openRig();
    const first = must(rig.paneIds()[0]);
    rig.title(first, "vim");
    rig.title(first, "");
    expect(renderTree(rig, naming())).not.toContain("item-pane-program");
  });

  it("are not saved in state.json", async () => {
    const rig = await openRig();
    rig.title(must(rig.paneIds()[0]), "loop Noren");
    rig.rename(must(rig.paneIds()[1]), "Dev server");
    const saved = rig.saved();
    expect(saved).not.toContain("loop Noren");
    expect(saved).toContain("Dev server");
  });

  it("start the text field of a rename empty, not with the title", async () => {
    const rig = await openRig();
    const first = must(rig.paneIds()[0]);
    rig.title(first, "loop Noren");
    const html = renderTree(rig, naming({ editing: { itemId: rig.item().id, paneId: first } }));
    expect(html).toContain('value=""');
  });
});
