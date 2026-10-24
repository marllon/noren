import { describe, expect, it } from "vitest";
import { SETTLE_EVENTS, observeSettle } from "./observe-move";

type Listener = (event: Event) => void;

/** A scope that records the listeners and delivers an event to them, as the document does. */
function fakeScope() {
  const listeners = new Map<string, { listener: Listener; capture: unknown }[]>();
  return {
    addEventListener(name: string, listener: Listener, capture?: unknown) {
      listeners.set(name, [...(listeners.get(name) ?? []), { listener, capture }]);
    },
    removeEventListener(name: string, listener: Listener) {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((entry) => entry.listener !== listener),
      );
    },
    count: () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0),
    captured: () => [...listeners.values()].flat().every((entry) => entry.capture === true),
    deliver(name: string, target: unknown) {
      for (const { listener } of listeners.get(name) ?? [])
        listener({ target } as unknown as Event);
    },
  };
}

const element = {} as Element;
/** A node that holds `inside` (the pane's area) or does not. */
const holding = (inside: Element | undefined) => ({
  contains: (other: unknown) => other === inside,
});

describe("observeSettle", () => {
  it("calls back when an animation or a transition of the element or of what holds it is over", () => {
    const scope = fakeScope();
    let calls = 0;
    observeSettle(element, () => (calls += 1), scope as unknown as Document);
    for (const name of SETTLE_EVENTS) scope.deliver(name, holding(element));
    expect(calls).toBe(SETTLE_EVENTS.length);
  });

  it("listens in the capture phase, so an event that does not bubble is heard", () => {
    const scope = fakeScope();
    observeSettle(element, () => undefined, scope as unknown as Document);
    expect(scope.count()).toBe(SETTLE_EVENTS.length);
    expect(scope.captured()).toBe(true);
  });

  it("ignores what ends on a node that does not hold the element, or on no node", () => {
    const scope = fakeScope();
    let calls = 0;
    observeSettle(element, () => (calls += 1), scope as unknown as Document);
    scope.deliver("animationend", holding(undefined));
    scope.deliver("transitionend", {});
    scope.deliver("animationend", null);
    expect(calls).toBe(0);
  });

  it("stops listening when asked", () => {
    const scope = fakeScope();
    let calls = 0;
    const stop = observeSettle(element, () => (calls += 1), scope as unknown as Document);
    stop();
    expect(scope.count()).toBe(0);
    scope.deliver("animationend", holding(element));
    expect(calls).toBe(0);
  });
});
