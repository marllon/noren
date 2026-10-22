import { describe, expect, it } from "vitest";
import { tabDotOf } from "./tab-dot";

// The state dot of a tab in the glass sidebar: what the tab needs from the person, in one of three
// colors. Waiting beats running, which beats idle, so the most pressing thing is what shows.

describe("tabDotOf", () => {
  it("is idle for a tab with nothing going on", () => {
    expect(tabDotOf({ running: false })).toBe("idle");
    expect(tabDotOf({ running: false, agentState: "idle" })).toBe("idle");
  });

  it("is running while a command runs in some pane", () => {
    expect(tabDotOf({ running: true })).toBe("running");
  });

  it("is running while an agent works, even if no command is marked", () => {
    expect(tabDotOf({ running: false, agentState: "working" })).toBe("running");
  });

  it("is waiting when an agent waits for the person, whatever else runs", () => {
    expect(tabDotOf({ running: false, agentState: "waiting" })).toBe("waiting");
    expect(tabDotOf({ running: true, agentState: "waiting" })).toBe("waiting");
  });
});
