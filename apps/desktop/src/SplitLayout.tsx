import type { AgentState, Id, LayoutNode, Pane, SplitNode } from "@noren/model";
import { Ellipsis, Maximize2, Minimize2, SquareArrowOutUpRight, X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import { menuPoint } from "./ContextMenu";
import { useT } from "./i18n";
import type { MenuPoint } from "./SpaceMenu";
import type { SplitDir } from "./TreeMenus";
import { PaneBar } from "./PaneBar";
import type { PaneBarInfo } from "./pane-info";
import { usePaneDrag, usePaneDrop } from "./TreeDnd";
import {
  MIN_PANEL_PERCENT,
  childPanelId,
  layoutToSizes,
  sizesDiffer,
  sizesToLayout,
  splitKey,
} from "./split-layout";

/** What the nodes of one item's layout share. */
export interface SplitLayoutContext {
  focusedPaneId: Id;
  /** True when the item has more than one pane: only then does the focused pane get a frame. */
  framed: boolean;
  /** The pane that fills the item while the others stay hidden (mounted), if any. */
  zoomedPaneId: Id | undefined;
  /** The panes take the drop of a tab dragged from the sidebar or of another pane's header (this is the tab on screen). */
  dropEnabled: boolean;
  /** Every pane shows a header with its title, a menu button and the zoom and close buttons. */
  headers: boolean;
  /** The text of a pane's header. */
  paneTitle(pane: Pane): string;
  /**
   * What the agent of a pane is doing, in words for assistive technology, or `undefined` for a
   * pane without an agent. The pane draws a ring in the color of the state.
   */
  paneAgent?(pane: Pane): { state: AgentState; label: string } | undefined;
  /**
   * What the header of a pane says (its folder, branch and command), or `undefined` for a pane with no
   * header of this kind: a pane that is not a terminal. A pane with the header has no hover corner, its
   * split buttons are in the header.
   */
  paneBar?(pane: Pane): PaneBarInfo | undefined;
  /**
   * The header is the one of the dense style: it leads with the place of the pane in its tab, which
   * `paneNumber` says (1 is the first), and has a button that closes the pane when the tab holds several.
   */
  denseBar?: boolean;
  paneNumber?(pane: Pane): number | undefined;
  renderPane(pane: Pane): ReactNode;
  onFocusPane(paneId: Id): void;
  onZoomPane(paneId: Id): void;
  onClosePane(paneId: Id): void;
  /** Move the pane to a tab of its own. */
  onDetachPane(paneId: Id): void;
  /** Open the menu of the pane (select or copy the output of a command) at a point. */
  onPaneMenu(paneId: Id, point: MenuPoint): void;
  /** The user dragged a separator: the split at `path` now has these sizes. */
  onResize(path: number[], sizes: number[]): void;
  /**
   * Split the pane in two, the new one right of it (`row`) or below it (`column`). A context
   * without it (the page of a window of a space) draws no split buttons in the header of a pane.
   */
  onSplitPane?(paneId: Id, dir: SplitDir): void;
  /** False when the tab already holds as many panes as it may: the split buttons of the header are off. */
  canSplit?: boolean;
  /**
   * The pane whose name is a text field in its header now, and what ends that: Enter or leaving the
   * field gives the new text (`restoreFocus` is set for Enter), Escape cancels. A context without them
   * (the page of a window of a space) never renames.
   */
  renamingPaneId?: Id | undefined;
  onRenamePane?(paneId: Id, value: string, restoreFocus: boolean): void;
  onCancelRenamePane?(): void;
}

interface SplitGroupProps {
  node: SplitNode;
  path: number[];
  context: SplitLayoutContext;
}

/** One split: its children side by side (row) or stacked (column), with a separator between each. */
function SplitGroup({ node, path, context }: SplitGroupProps) {
  const groupRef = useGroupRef();

  // The model is the truth: sizes that change from outside the drag (a keyboard resize, a
  // restored layout) are pushed into the panels, unless the panels already show them.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const shown = layoutToSizes(node, group.getLayout());
    if (shown === undefined || sizesDiffer(shown, node.sizes)) group.setLayout(sizesToLayout(node));
  }, [groupRef, node]);

  const onLayoutChanged = (layout: Layout, meta: { isUserInteraction: boolean }) => {
    // Mount, constraint changes and our own `setLayout` are not the user's doing.
    if (!meta.isUserInteraction) return;
    const sizes = layoutToSizes(node, layout);
    if (sizes !== undefined && sizesDiffer(sizes, node.sizes)) context.onResize(path, sizes);
  };

  return (
    <Group
      key={splitKey(node)}
      groupRef={groupRef}
      className="split-group"
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
      defaultLayout={sizesToLayout(node)}
      onLayoutChanged={onLayoutChanged}
    >
      {node.children.flatMap((child, index) => {
        const id = childPanelId(child);
        return [
          ...(index > 0
            ? [
                <Separator
                  key={`separator-${id}`}
                  className="split-separator"
                  data-nr-dir={node.dir}
                />,
              ]
            : []),
          <Panel key={id} id={id} className="split-panel" minSize={`${MIN_PANEL_PERCENT}%`}>
            <LayoutNodeView node={child} path={[...path, index]} context={context} />
          </Panel>,
        ];
      })}
    </Group>
  );
}

interface PaneHeaderProps {
  pane: Pane;
  zoomed: boolean;
  /** False for an item with one pane: there is nothing to zoom, and closing it closes the tab. */
  actions: boolean;
  context: SplitLayoutContext;
}

/**
 * Title of a pane with the buttons that open its menu, zoom it, detach it and close it. The title is
 * the handle that drags the pane onto the middle of another pane to swap them.
 */
function PaneHeader({ pane, zoomed, actions, context }: PaneHeaderProps) {
  const t = useT();
  const title = context.paneTitle(pane);
  const ZoomIcon = zoomed ? Minimize2 : Maximize2;
  // The pane swaps with the others of the tab on screen: with one pane there is nothing to swap.
  const drag = usePaneDrag(pane.id, title, actions && context.dropEnabled);
  return (
    <div className="pane-header" data-nr-part="pane-header">
      <span
        className="pane-header-title"
        title={title}
        data-nr-state={drag.dragging ? "dragging" : undefined}
        data-nr-draggable={actions && context.dropEnabled ? "true" : undefined}
        {...drag.handleProps}
      >
        {title}
      </span>
      <button
        type="button"
        className="pane-header-button"
        aria-label={t("pane.menu")}
        aria-haspopup="menu"
        onClick={(event) => context.onPaneMenu(pane.id, menuPoint(event))}
      >
        <Ellipsis size={12} aria-hidden="true" />
      </button>
      {actions && (
        <>
          <button
            type="button"
            className="pane-header-button"
            aria-label={t("pane.detach")}
            onClick={() => context.onDetachPane(pane.id)}
          >
            <SquareArrowOutUpRight size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pane-header-button"
            aria-label={zoomed ? t("pane.restore") : t("pane.zoom")}
            aria-pressed={zoomed}
            onClick={() => context.onZoomPane(pane.id)}
          >
            <ZoomIcon size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pane-header-button"
            aria-label={t("pane.close")}
            onClick={() => context.onClosePane(pane.id)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}

interface LayoutNodeViewProps {
  node: LayoutNode;
  path: number[];
  context: SplitLayoutContext;
}

function LayoutNodeView({ node, path, context }: LayoutNodeViewProps) {
  if (node.kind === "split") return <SplitGroup node={node} path={path} context={context} />;
  return <PaneFrame pane={node.pane} context={context} />;
}

function PaneFrame({ pane, context }: { pane: Pane; context: SplitLayoutContext }) {
  const focused = pane.id === context.focusedPaneId;
  const zoom = context.zoomedPaneId;
  const drop = usePaneDrop(
    pane.id,
    context.dropEnabled && (zoom === undefined || zoom === pane.id),
  );
  // The zoom is only a style: the other panes stay where they are in the tree, hidden, so no
  // terminal is unmounted or moved (a moved terminal remounts and loses its screen).
  const zoomState = zoom === undefined ? undefined : zoom === pane.id ? "zoomed" : "hidden";
  const agent = context.paneAgent?.(pane);
  const bar = context.paneBar?.(pane);
  const onSplit = context.onSplitPane;
  const number = context.denseBar === true ? context.paneNumber?.(pane) : undefined;
  return (
    <div
      ref={drop.ref}
      className="pane-frame"
      data-nr-part="pane"
      data-pane-id={pane.id}
      data-nr-focused={context.framed && zoom === undefined ? String(focused) : undefined}
      data-nr-zoom={zoomState}
      data-nr-agent-state={agent?.state}
      // Capture: the terminal handles its own mouse events, and the click must still count.
      onMouseDownCapture={() => {
        if (!focused) context.onFocusPane(pane.id);
      }}
    >
      {context.headers ? (
        <PaneHeader
          pane={pane}
          zoomed={zoom === pane.id}
          actions={context.framed}
          context={context}
        />
      ) : null}
      {bar !== undefined && (
        <PaneBar
          info={bar}
          waiting={agent?.state === "waiting"}
          // With the pane headers on, the zoom button is the header's own (two would have one name).
          zoomable={context.framed && !context.headers}
          zoomed={zoom === pane.id}
          canSplit={context.canSplit !== false}
          {...(onSplit !== undefined ? { onSplit: (dir: SplitDir) => onSplit(pane.id, dir) } : {})}
          onZoom={() => context.onZoomPane(pane.id)}
          {...(context.renamingPaneId === pane.id &&
          context.onRenamePane !== undefined &&
          context.onCancelRenamePane !== undefined
            ? {
                renaming: {
                  initial: pane.name ?? "",
                  onCommit: (value: string, restoreFocus: boolean) =>
                    context.onRenamePane?.(pane.id, value, restoreFocus),
                  onCancel: context.onCancelRenamePane,
                },
              }
            : {})}
          {...(context.denseBar === true
            ? {
                dense: true,
                ...(number !== undefined ? { number } : {}),
                // With the pane headers on, the close button is the header's own (two would have one name).
                ...(context.framed && !context.headers
                  ? { onClose: () => context.onClosePane(pane.id) }
                  : {}),
              }
            : {})}
        />
      )}
      {context.renderPane(pane)}
      {agent !== undefined && (
        <>
          <span className="pane-agent-ring" data-nr-part="pane-agent-ring" aria-hidden="true" />
          <span className="sr-only" role="status" data-nr-part="pane-agent-state">
            {agent.label}
          </span>
        </>
      )}
      {drop.swap && (
        <span className="pane-swap-zone" data-nr-part="pane-swap-zone" aria-hidden="true" />
      )}
      {drop.zone && (
        <span
          className="pane-drop-zone"
          data-nr-part="pane-drop-zone"
          data-nr-dir={drop.zone.dir}
          data-nr-side={drop.zone.side}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/** The layout of one item as nested resizable panels, one pane (terminal) per leaf. */
export function SplitLayout({
  layout,
  context,
}: {
  layout: LayoutNode;
  context: SplitLayoutContext;
}) {
  return <LayoutNodeView node={layout} path={[]} context={context} />;
}
