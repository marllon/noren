import { afterEach, describe, expect, it } from "vitest";
import { createDefaultWorkspace, createSequentialIds, planMods, reduce } from "@noren/model";
import type { Action, Workspace } from "@noren/model";
import { followActiveSpaceMods, getSpaceMods, resetSpaceMods } from "./use-mods";

// The mods of the active space follow the workspace store: switching space, or changing the mods of
// the space, reaches the window without it having to ask.

afterEach(() => {
  resetSpaceMods();
});

/** A store with the two calls the follower uses. */
function fakeStore(initial: Workspace) {
  let workspace = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => ({ workspace }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    do(action: Action) {
      workspace = reduce(workspace, action, ctx);
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
    workspace: () => workspace,
  };
}

const ctx = { newId: createSequentialIds("t"), clock: { now: () => 0 } };

describe("followActiveSpaceMods", () => {
  it("follows one store at a time, and stops when reset", () => {
    const first = fakeStore(createDefaultWorkspace());
    const second = fakeStore(createDefaultWorkspace());
    followActiveSpaceMods(first as never);
    expect(first.listeners()).toBe(1);
    followActiveSpaceMods(second as never);
    expect(first.listeners()).toBe(0);
    expect(second.listeners()).toBe(1);
    resetSpaceMods();
    expect(second.listeners()).toBe(0);
    expect(getSpaceMods()).toEqual([]);
  });

  it("starts with the mods the active space already has", () => {
    const base = createDefaultWorkspace();
    const first = base.spaces[0];
    const ws = reduce(
      base,
      { type: "space/set-mods", spaceId: first?.id ?? "", modIds: ["a.css", "b.css"] },
      ctx,
    );
    followActiveSpaceMods(fakeStore(ws) as never);
    expect(getSpaceMods()).toEqual(["a.css", "b.css"]);
  });

  it("sees the mods of the active space change, and the mods of another space not matter", () => {
    const store = fakeStore(createDefaultWorkspace());
    followActiveSpaceMods(store as never);
    expect(getSpaceMods()).toEqual([]);
    const main = store.workspace().spaces[0]?.id ?? "";

    store.do({ type: "space/set-mods", spaceId: main, modIds: ["a.css"] });
    expect(getSpaceMods()).toEqual(["a.css"]);
    const held = getSpaceMods();

    // Another space, not active: nothing for the window.
    store.do({ type: "space/create", name: "Other", activate: false });
    const other = store.workspace().spaces[1]?.id ?? "";
    store.do({ type: "space/set-mods", spaceId: other, modIds: ["z.css"] });
    expect(getSpaceMods()).toBe(held);

    // Switching to it switches the mods; switching back brings the first ones back.
    store.do({ type: "space/activate", spaceId: other });
    expect(getSpaceMods()).toEqual(["z.css"]);
    store.do({ type: "space/activate", spaceId: main });
    expect(getSpaceMods()).toEqual(["a.css"]);

    store.do({ type: "space/set-mods", spaceId: main, modIds: [] });
    expect(getSpaceMods()).toEqual([]);
  });
});

describe("the mods in force for a space", () => {
  const files = ["a.css", "b.css", "c.css"].map((name) => ({ name, text: ".x { top: 0 }" }));

  it("are the global ones, then the ones of the space", () => {
    expect(planMods(["a.css"], ["c.css", "b.css"], files).applied.map((m) => m.name)).toEqual([
      "a.css",
      "c.css",
      "b.css",
    ]);
  });

  it("are only the global ones for a space that lists none", () => {
    expect(planMods(["b.css"], [], files).applied.map((m) => m.name)).toEqual(["b.css"]);
  });
});
