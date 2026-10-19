import type { Id, LayoutNode, Pane, SplitNode } from "@noren/model";
import { Ellipsis, Maximize2, Minimize2, SquareArrowOutUpRight, X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import { menuPoint } from "./ContextMenu";
import type { MenuPoint } from "./SpaceMenu";
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
        aria-label="Pane menu"
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
            aria-label="Detach pane"
            onClick={() => context.onDetachPane(pane.id)}
          >
            <SquareArrowOutUpRight size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pane-header-button"
            aria-label={zoomed ? "Restore pane" : "Zoom pane"}
            aria-pressed={zoomed}
            onClick={() => context.onZoomPane(pane.id)}
          >
            <ZoomIcon size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pane-header-button"
            aria-label="Close pane"
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
  return (
    <div
      ref={drop.ref}
      className="pane-frame"
      data-nr-part="pane"
      data-pane-id={pane.id}
      data-nr-focused={context.framed && zoom === undefined ? String(focused) : undefined}
      data-nr-zoom={zoomState}
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
      {context.renderPane(pane)}
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
