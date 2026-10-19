/** A saved workspace of `spaces` spaces with `perSpace` tabs each, the first space active. */
export function manyTabsState(names: string[], perSpace: number): string {
  const spaces = names.map((name, s) => {
    const items: Record<string, unknown> = {};
    const tree: unknown[] = [];
    for (let t = 1; t <= perSpace; t++) {
      const id = `t${s}-${t}`;
      const paneId = `p${s}-${t}`;
      items[id] = {
        id,
        title: `${name} ${t}`,
        titleLocked: true,
        layout: {
          kind: "pane",
          pane: {
            id: paneId,
            type: "terminal",
            profileId: "default",
            status: "idle",
            unread: false,
            bell: false,
          },
        },
        focusedPaneId: paneId,
        lastActivityAt: 1,
      };
      tree.push({ kind: "item", id });
    }
    return {
      id: `s${s}`,
      name,
      icon: "terminal",
      color: s === 0 ? "#6b8afd" : "#e0a458",
      modIds: [],
      defaults: { env: {} },
      aiEnabled: true,
      saveScrollback: true,
      pinned: [],
      tree,
      items,
      activeItemId: `t${s}-1`,
    };
  });
  return JSON.stringify({
    version: 2,
    activeSpaceId: "s0",
    favorites: [],
    closed: [],
    archive: [],
    spaces,
  });
}
