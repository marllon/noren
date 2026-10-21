import { FakeBackend, createSequentialIds, layoutPanes, restoreWorkspace } from "@noren/model";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANNOUNCE_BURST_MS,
  Announcer,
  bellAnnouncement,
  commandAnnouncement,
  navigationAnnouncement,
  sessionEndedAnnouncement,
  syncAnnouncement,
  tabNameOfPane,
} from "./announcer";
import type { Announcement, NavigationPoint } from "./announcer";
import { setLanguage } from "./i18n";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

// What the announcer says, in which region, and when it stays quiet. The words are the interface's
// own (`t`), checked here in English and in Brazilian Portuguese.

afterEach(() => setLanguage("en"));

/** A polite announcement with this text. */
const said = (text: string): Announcement => ({ urgency: "polite", text });

const point = (over: Partial<NavigationPoint> = {}): NavigationPoint => ({
  spaceId: "s1",
  spaceName: "Work",
  itemId: "i1",
  tabName: "api",
  ...over,
});

/** An announcer on a clock the test moves. */
function clocked(burstMs?: number) {
  let at = 1000;
  const announcer = new Announcer({ now: () => at, ...(burstMs !== undefined ? { burstMs } : {}) });
  return {
    announcer,
    advance(ms: number) {
      at += ms;
    },
  };
}

describe("navigationAnnouncement", () => {
  it("says nothing when the window has just opened", () => {
    expect(navigationAnnouncement(undefined, point())).toBeUndefined();
  });

  it("says the tab when only the tab changed", () => {
    expect(navigationAnnouncement(point(), point({ itemId: "i2", tabName: "build" }))).toEqual({
      urgency: "polite",
      text: "Tab build",
    });
  });

  it("says the space with its tab when the space changed", () => {
    expect(
      navigationAnnouncement(
        point(),
        point({ spaceId: "s2", spaceName: "Home", itemId: "j1", tabName: "notes" }),
      ),
    ).toEqual({ urgency: "polite", text: "Space Home, tab notes" });
  });

  it("says nothing for a tab that was only renamed, or when nothing changed", () => {
    expect(navigationAnnouncement(point(), point({ tabName: "renamed" }))).toBeUndefined();
    expect(navigationAnnouncement(point(), point())).toBeUndefined();
  });

  it("says nothing when the space has no tab on screen", () => {
    expect(
      navigationAnnouncement(point(), point({ itemId: undefined, tabName: "" })),
    ).toBeUndefined();
  });

  it("speaks Brazilian Portuguese when that is the language", () => {
    setLanguage("pt-BR");
    expect(navigationAnnouncement(point(), point({ itemId: "i2", tabName: "build" }))?.text).toBe(
      "Aba build",
    );
    expect(
      navigationAnnouncement(point(), point({ spaceId: "s2", spaceName: "Casa", tabName: "x" }))
        ?.text,
    ).toBe("Espaço Casa, aba x");
  });
});

describe("commandAnnouncement", () => {
  it("is polite for exit code 0 and gives the code", () => {
    expect(commandAnnouncement("npm test", 0)).toEqual({
      urgency: "polite",
      text: "Command finished with exit code 0: npm test",
    });
  });

  it("is assertive for any other code, because the command failed", () => {
    expect(commandAnnouncement("false", 1)).toEqual({
      urgency: "assertive",
      text: "Command finished with exit code 1: false",
    });
    expect(commandAnnouncement("x", 127).urgency).toBe("assertive");
  });

  it("works without the command line and without a code", () => {
    expect(commandAnnouncement(undefined, 2).text).toBe("Command finished with exit code 2");
    expect(commandAnnouncement("ls", undefined)).toEqual({
      urgency: "polite",
      text: "Command finished: ls",
    });
    expect(commandAnnouncement(undefined, undefined).text).toBe("Command finished");
    expect(commandAnnouncement("   ", 0).text).toBe("Command finished with exit code 0");
  });

  it("puts a long or many-lined command on one line, cut", () => {
    const text = commandAnnouncement(`echo a\n   echo ${"b".repeat(200)}`, 0).text;
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(140);
    expect(text).toContain("…");
  });

  it("speaks Brazilian Portuguese when that is the language", () => {
    setLanguage("pt-BR");
    expect(commandAnnouncement("false", 1).text).toBe(
      "Comando terminou com código de saída 1: false",
    );
  });
});

describe("the other sentences", () => {
  it("names the tab for the bell and for the end of the session", () => {
    expect(bellAnnouncement("logs")).toEqual({ urgency: "polite", text: "Bell in logs" });
    expect(sessionEndedAnnouncement("logs", 0)).toEqual({
      urgency: "polite",
      text: "Session ended in logs with exit code 0",
    });
    expect(sessionEndedAnnouncement("logs", 3).urgency).toBe("assertive");
  });

  it("passes the sentence of a sync result through, assertive only for an alert", () => {
    expect(syncAnnouncement({ text: "Pushed 2 files.", alert: false })).toEqual({
      urgency: "polite",
      text: "Pushed 2 files.",
    });
    expect(syncAnnouncement({ text: "git said no", alert: true })).toEqual({
      urgency: "assertive",
      text: "git said no",
    });
  });

  it("speaks Brazilian Portuguese when that is the language", () => {
    setLanguage("pt-BR");
    expect(bellAnnouncement("logs").text).toBe("Sino em logs");
    expect(sessionEndedAnnouncement("logs", 2).text).toBe(
      "Sessão encerrada em logs com código de saída 2",
    );
  });
});

describe("tabNameOfPane", () => {
  it("finds the tab of a pane in any space, and nothing for a pane that is gone", async () => {
    const backend = new FakeBackend();
    const newId = createSequentialIds("n");
    const clock = { now: () => 1000 };
    const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
    const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
    store.getState().newTab();
    const first = activeSpaceOf(store.getState().workspace);
    const [firstId, secondId] = spaceItemIds(first);
    store.getState().dispatch({ type: "item/rename", itemId: firstId ?? "", title: "api" });
    store.getState().createSpace({ name: "Other" });
    const workspace = store.getState().workspace;
    const paneOf = (spaceIndex: number, itemId: string | undefined): string => {
      const item = workspace.spaces[spaceIndex]?.items[itemId ?? ""];
      const pane = item === undefined ? undefined : layoutPanes(item.layout)[0];
      if (pane === undefined) throw new Error("no pane");
      return pane.id;
    };
    expect(tabNameOfPane(workspace, paneOf(0, firstId))).toBe("api");
    expect(tabNameOfPane(workspace, paneOf(0, secondId))).toBe("Tab 2");
    const otherSpace = workspace.spaces[1];
    const otherItem = spaceItemIds(otherSpace ?? first)[0];
    expect(tabNameOfPane(workspace, paneOf(1, otherItem))).toBe("Tab 1");
    expect(tabNameOfPane(workspace, "nope")).toBeUndefined();
  });
});

describe("the Announcer", () => {
  it("puts a polite announcement in the polite region and an assertive one in the other", () => {
    const { announcer } = clocked();
    expect(announcer.announce({ urgency: "polite", text: "Tab api" })).toBe(true);
    expect(announcer.state).toEqual({ polite: "Tab api", assertive: "" });
    expect(announcer.announce({ urgency: "assertive", text: "Command failed" })).toBe(true);
    expect(announcer.state).toEqual({ polite: "Tab api", assertive: "Command failed" });
  });

  it("ignores an empty text", () => {
    const { announcer } = clocked();
    expect(announcer.announce({ urgency: "polite", text: "  " })).toBe(false);
    expect(announcer.state).toEqual({ polite: "", assertive: "" });
  });

  it("does not repeat the same announcement in a burst", () => {
    const { announcer, advance } = clocked();
    const bell = bellAnnouncement("logs");
    expect(announcer.announce(bell)).toBe(true);
    let heard = 0;
    announcer.subscribe(() => heard++);
    for (let i = 0; i < 50; i++) {
      advance(10);
      expect(announcer.announce(bell)).toBe(false);
    }
    expect(heard).toBe(0);
    expect(announcer.state.polite).toBe("Bell in logs");
  });

  it("says it again once the window of the burst is over, as a change the region reports", () => {
    const { announcer, advance } = clocked();
    const bell = bellAnnouncement("logs");
    announcer.announce(bell);
    const first = announcer.state.polite;
    advance(ANNOUNCE_BURST_MS);
    expect(announcer.announce(bell)).toBe(true);
    expect(announcer.state.polite).not.toBe(first);
    expect(announcer.state.polite.trim()).toBe(first);
    advance(ANNOUNCE_BURST_MS);
    announcer.announce(bell);
    expect(announcer.state.polite).toBe(first);
  });

  it("does not hold a burst against a different sentence, or the other urgency", () => {
    const { announcer, advance } = clocked();
    announcer.announce(bellAnnouncement("a"));
    advance(5);
    expect(announcer.announce(bellAnnouncement("b"))).toBe(true);
    expect(announcer.state.polite).toBe("Bell in b");
    expect(announcer.announce({ urgency: "assertive", text: "Bell in b" })).toBe(true);
  });

  it("uses the burst window it is given", () => {
    const { announcer, advance } = clocked(100);
    announcer.announce(said("x"));
    advance(99);
    expect(announcer.announce(said("x"))).toBe(false);
    advance(1);
    expect(announcer.announce(said("x"))).toBe(true);
  });

  it("empties the regions, and tells the listeners only when something changed", () => {
    const { announcer } = clocked();
    let heard = 0;
    announcer.subscribe(() => heard++);
    announcer.clear();
    expect(heard).toBe(0);
    announcer.announce(said("x"));
    announcer.clear();
    expect(announcer.state).toEqual({ polite: "", assertive: "" });
    expect(heard).toBe(2);
  });

  it("stops telling a listener that unsubscribed", () => {
    const { announcer } = clocked();
    let heard = 0;
    const stop = announcer.subscribe(() => heard++);
    announcer.announce(said("x"));
    stop();
    announcer.announce(said("y"));
    expect(heard).toBe(1);
  });

  it("forgets what it said on reset, so the same sentence is heard at once", () => {
    const { announcer } = clocked();
    announcer.announce(said("x"));
    announcer.reset();
    expect(announcer.state.polite).toBe("");
    expect(announcer.announce(said("x"))).toBe(true);
  });
});
