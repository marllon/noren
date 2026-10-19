import type { Id, LayoutNode, Pane, SplitNode } from "@noren/model";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
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
  renderPane(pane: Pane): ReactNode;
  onFocusPane(paneId: Id): void;
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

interface LayoutNodeViewProps {
  node: LayoutNode;
  path: number[];
  context: SplitLayoutContext;
}

function LayoutNodeView({ node, path, context }: LayoutNodeViewProps) {
  if (node.kind === "split") return <SplitGroup node={node} path={path} context={context} />;
  const { pane } = node;
  const focused = pane.id === context.focusedPaneId;
  return (
    <div
      className="pane-frame"
      data-nr-part="pane"
      data-pane-id={pane.id}
      data-nr-focused={context.framed ? String(focused) : undefined}
      // Capture: the terminal handles its own mouse events, and the click must still count.
      onMouseDownCapture={() => {
        if (!focused) context.onFocusPane(pane.id);
      }}
    >
      {context.renderPane(pane)}
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
