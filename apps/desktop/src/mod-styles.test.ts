import { describe, expect, it } from "vitest";
import type { AppliedMod } from "@noren/model";
import { MOD_STYLE_ATTRIBUTE, syncModStyles } from "./mod-styles";

// `syncModStyles` against a small stand-in for the `<head>`: the real thing is checked in a browser
// by e2e/mods.spec.ts, which also proves the cascade; here the bookkeeping is: which elements are
// made, rewritten, moved and removed, and that an unchanged mod is left alone.

class FakeStyle {
  attributes = new Map<string, string>();
  writes = 0;
  #text: string | null = "";
  parent: FakeHead | undefined;

  get textContent(): string | null {
    return this.#text;
  }
  set textContent(value: string | null) {
    this.#text = value;
    this.writes++;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
}

class FakeHead {
  children: FakeStyle[] = [];
  created = 0;
  appends = 0;
  readonly ownerDocument = {
    createElement: () => {
      this.created++;
      return new FakeStyle();
    },
  };

  querySelectorAll(selector: string): FakeStyle[] {
    expect(selector).toBe(`style[${MOD_STYLE_ATTRIBUTE}]`);
    return this.children.filter((child) => child.getAttribute(MOD_STYLE_ATTRIBUTE) !== null);
  }
  append(...nodes: FakeStyle[]): void {
    this.appends++;
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
}

const sync = (head: FakeHead, applied: readonly AppliedMod[]): void =>
  syncModStyles(head as unknown as Element, applied);
const mod = (name: string, css = `/* ${name} */`): AppliedMod => ({ name, css });
const names = (head: FakeHead): (string | null)[] =>
  head.children.map((child) => child.getAttribute(MOD_STYLE_ATTRIBUTE));

describe("syncModStyles", () => {
  it("makes one style for each mod, named by the attribute, in order", () => {
    const head = new FakeHead();
    sync(head, [mod("b.css", "B"), mod("a.css", "A")]);
    expect(names(head)).toEqual(["b.css", "a.css"]);
    expect(head.children.map((child) => child.textContent)).toEqual(["B", "A"]);
  });

  it("does nothing for the same mods", () => {
    const head = new FakeHead();
    sync(head, [mod("a.css"), mod("b.css")]);
    const [a, b] = head.children;
    const writes = [a?.writes, b?.writes];
    const appends = head.appends;
    sync(head, [mod("a.css"), mod("b.css")]);
    expect(head.children).toEqual([a, b]);
    expect([a?.writes, b?.writes]).toEqual(writes);
    expect(head.appends).toBe(appends);
    expect(head.created).toBe(2);
  });

  it("rewrites only the mod whose text changed", () => {
    const head = new FakeHead();
    sync(head, [mod("a.css", "1"), mod("b.css", "2")]);
    const [a, b] = head.children;
    const bWrites = b?.writes;
    sync(head, [mod("a.css", "1 edited"), mod("b.css", "2")]);
    expect(head.children).toEqual([a, b]);
    expect(a?.textContent).toBe("1 edited");
    expect(b?.writes).toBe(bWrites);
  });

  it("removes the style of a mod that is no longer in force, and keeps the others", () => {
    const head = new FakeHead();
    sync(head, [mod("a.css"), mod("b.css"), mod("c.css")]);
    const [a, , c] = head.children;
    sync(head, [mod("a.css"), mod("c.css")]);
    expect(head.children).toEqual([a, c]);
    sync(head, []);
    expect(head.children).toEqual([]);
  });

  it("puts the styles in a new order by moving them, not by making them again", () => {
    const head = new FakeHead();
    sync(head, [mod("a.css"), mod("b.css"), mod("c.css")]);
    const [a, b, c] = head.children;
    sync(head, [mod("c.css"), mod("a.css"), mod("b.css")]);
    expect(head.children).toEqual([c, a, b]);
    expect(head.created).toBe(3);
  });

  it("puts a new mod where the order says, between the ones that were there", () => {
    const head = new FakeHead();
    sync(head, [mod("a.css"), mod("c.css")]);
    sync(head, [mod("a.css"), mod("b.css"), mod("c.css")]);
    expect(names(head)).toEqual(["a.css", "b.css", "c.css"]);
  });

  it("leaves the other styles of the head alone", () => {
    const head = new FakeHead();
    const own = new FakeStyle();
    head.append(own);
    sync(head, [mod("a.css")]);
    sync(head, []);
    expect(head.children).toEqual([own]);
  });

  it("removes a second style with the same name, which only a leftover can be", () => {
    const head = new FakeHead();
    sync(head, [mod("a.css")]);
    const twin = new FakeStyle();
    twin.setAttribute(MOD_STYLE_ATTRIBUTE, "a.css");
    head.append(twin);
    sync(head, [mod("a.css")]);
    expect(names(head)).toEqual(["a.css"]);
    expect(head.children).toHaveLength(1);
  });
});
