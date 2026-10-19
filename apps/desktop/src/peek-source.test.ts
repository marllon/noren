import { FakeBackend, ManualClock } from "@noren/model";
import type { Item } from "@noren/model";
import { describe, expect, it } from "vitest";
import { fixturePane, fixtureTab } from "./closed-fixtures";
import { peekLinesOfItem } from "./peek-source";
import { registerTerminalSnapshot } from "./scrollback-service";

const backend = () => new FakeBackend({ clock: new ManualClock() });

const ESC = "\x1b";

describe("where the peek gets its lines", () => {
  it("reads the terminal of the focused pane when it is mounted", async () => {
    const item = fixtureTab("t1", fixturePane("peek-live-1"));
    const calls = backend();
    registerTerminalSnapshot("peek-live-1", () => `${ESC}[32mone${ESC}[0m\r\ntwo\n\n`);
    expect(await peekLinesOfItem(calls, item)).toEqual(["one", "two"]);
    expect(calls.callsTo("loadScrollback")).toEqual([]);
  });

  it("asks the terminal for a bounded number of lines, not the whole snapshot", async () => {
    const item = fixtureTab("t1", fixturePane("peek-live-2"));
    const asked: (number | undefined)[] = [];
    registerTerminalSnapshot("peek-live-2", (lines) => {
      asked.push(lines);
      return "x";
    });
    await peekLinesOfItem(backend(), item);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThanOrEqual(15);
    expect(asked[0]).toBeLessThan(2000);
  });

  it("shows only the last 15 lines that hold something", async () => {
    const item = fixtureTab("t1", fixturePane("peek-live-3"));
    const text = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n");
    registerTerminalSnapshot("peek-live-3", () => text);
    const lines = await peekLinesOfItem(backend(), item);
    expect(lines).toHaveLength(15);
    expect(lines[0]).toBe("row 16");
    expect(lines[14]).toBe("row 30");
  });

  it("takes the focused pane of a split tab", async () => {
    const first = fixturePane("peek-split-1");
    const second = fixturePane("peek-split-2");
    const item: Item = {
      id: "t1",
      titleLocked: false,
      layout: {
        kind: "split",
        dir: "row",
        sizes: [50, 50],
        children: [
          { kind: "pane", pane: first },
          { kind: "pane", pane: second },
        ],
      },
      focusedPaneId: second.id,
      lastActivityAt: 1,
    };
    registerTerminalSnapshot(first.id, () => "from the first");
    registerTerminalSnapshot(second.id, () => "from the second");
    expect(await peekLinesOfItem(backend(), item)).toEqual(["from the second"]);
  });

  it("falls back to the first pane when the focused one is not in the layout", async () => {
    const pane = fixturePane("peek-live-4");
    const item = { ...fixtureTab("t1", pane), focusedPaneId: "gone" };
    registerTerminalSnapshot(pane.id, () => "still here");
    expect(await peekLinesOfItem(backend(), item)).toEqual(["still here"]);
  });

  it("reads the saved snapshot when the terminal is not mounted", async () => {
    const fake = backend();
    fake.setScrollback("peek-saved-1", `${ESC}[31msaved one${ESC}[0m\nsaved two\n`);
    const item = fixtureTab("t1", fixturePane("peek-saved-1", { ref: true }));
    expect(await peekLinesOfItem(fake, item)).toEqual(["saved one", "saved two"]);
    expect(fake.callsTo("loadScrollback")).toHaveLength(1);
  });

  it("has nothing for a pane with no terminal and no saved snapshot", async () => {
    const fake = backend();
    expect(await peekLinesOfItem(fake, fixtureTab("t1", fixturePane("peek-none-1")))).toEqual([]);
    expect(fake.callsTo("loadScrollback")).toEqual([]);
    const withNote = fixtureTab("t2", fixturePane("peek-none-2", { ref: true }));
    expect(await peekLinesOfItem(fake, withNote)).toEqual([]);
  });

  it("has nothing, and does not throw, when the snapshot cannot be read or the terminal fails", async () => {
    const fake = backend();
    const broken = {
      loadScrollback: () => Promise.reject(new Error("disk")),
    };
    expect(
      await peekLinesOfItem(broken, fixtureTab("t1", fixturePane("peek-fail-1", { ref: true }))),
    ).toEqual([]);
    registerTerminalSnapshot("peek-fail-2", () => {
      throw new Error("disposed");
    });
    expect(await peekLinesOfItem(fake, fixtureTab("t2", fixturePane("peek-fail-2")))).toEqual([]);
  });

  it("never reads a file for an id that cannot name one", async () => {
    const fake = backend();
    const item = fixtureTab("t1", fixturePane("../escape", { ref: true }));
    expect(await peekLinesOfItem(fake, item)).toEqual([]);
    expect(fake.callsTo("loadScrollback")).toEqual([]);
  });

  it("shows hostile output as plain text only, from the terminal and from the file", async () => {
    const hostile = `<b onmouseover=x>bold</b>\n${ESC}]52;c;AAAA\x07clip\n${ESC}[6nreport\n${ESC}[?1049halt`;
    registerTerminalSnapshot("peek-hostile-1", () => hostile);
    const fake = backend();
    fake.setScrollback("peek-hostile-2", hostile);
    const expected = ["<b onmouseover=x>bold</b>", "clip", "report", "alt"];
    expect(await peekLinesOfItem(fake, fixtureTab("t1", fixturePane("peek-hostile-1")))).toEqual(
      expected,
    );
    expect(
      await peekLinesOfItem(fake, fixtureTab("t2", fixturePane("peek-hostile-2", { ref: true }))),
    ).toEqual(expected);
  });
});
