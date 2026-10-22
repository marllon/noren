import { afterEach, describe, expect, it } from "vitest";
import {
  TRANSPARENCY_ATTRIBUTE,
  TRANSPARENCY_REDUCED,
  applySystemTransparency,
  refreshSystemTransparency,
  resetSystemTransparency,
  systemTransparencyReduced,
} from "./system-transparency";
import type { AttributeTarget } from "./system-transparency";

// The switch of the transparency effects of the system, as the glass style reads it: asked of the
// backend, kept, and put on the root element as an attribute the stylesheet reads. (That the panels then
// go opaque is e2e/glass-surfaces.spec.ts.)

afterEach(resetSystemTransparency);

/** A root element that remembers its attributes. */
function root(): AttributeTarget & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
  };
}

describe("applySystemTransparency", () => {
  it("puts data-nr-transparency=reduced on the root while the system asks for opaque surfaces", () => {
    const target = root();
    applySystemTransparency(target, true);
    expect(TRANSPARENCY_ATTRIBUTE).toBe("data-nr-transparency");
    expect(TRANSPARENCY_REDUCED).toBe("reduced");
    expect(target.attributes.get("data-nr-transparency")).toBe("reduced");
  });

  it("takes it off again, and leaves nothing when it was never on", () => {
    const target = root();
    applySystemTransparency(target, false);
    expect(target.attributes.size).toBe(0);
    applySystemTransparency(target, true);
    applySystemTransparency(target, false);
    expect(target.attributes.size).toBe(0);
  });
});

describe("refreshSystemTransparency", () => {
  it("asks the backend and keeps its answer, a yes and then a no", async () => {
    let answer = true;
    let asked = 0;
    const backend = {
      systemTransparencyReduced: async () => {
        asked++;
        return answer;
      },
    };
    expect(systemTransparencyReduced()).toBe(false);
    await refreshSystemTransparency(backend);
    expect(systemTransparencyReduced()).toBe(true);
    answer = false;
    await refreshSystemTransparency(backend);
    expect(systemTransparencyReduced()).toBe(false);
    expect(asked).toBe(2);
  });

  it("counts a backend that rejects, or answers something that is not a boolean, as effects on", async () => {
    await refreshSystemTransparency({ systemTransparencyReduced: async () => true });
    expect(systemTransparencyReduced()).toBe(true);
    await refreshSystemTransparency({
      systemTransparencyReduced: () => Promise.reject(new Error("no bridge")),
    });
    expect(systemTransparencyReduced()).toBe(false);
    await refreshSystemTransparency({ systemTransparencyReduced: async () => true });
    await refreshSystemTransparency({
      systemTransparencyReduced: () => Promise.resolve("yes" as unknown as boolean),
    });
    expect(systemTransparencyReduced()).toBe(false);
  });

  it("is forgotten by the reset, so a test starts from effects on", async () => {
    await refreshSystemTransparency({ systemTransparencyReduced: async () => true });
    resetSystemTransparency();
    expect(systemTransparencyReduced()).toBe(false);
  });
});
