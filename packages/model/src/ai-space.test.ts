import { describe, expect, it } from "vitest";
import { aiIsOn } from "./ai";
import { parseConfigText } from "./config";
import { createDefaultWorkspace } from "./default-workspace";
import { reduce } from "./reducer";
import { parseState, serializeWorkspace } from "./state";
import { STATE_V0_FIXTURE, STATE_V1_FIXTURE, richWorkspace } from "./state-fixtures";
import { applyChecked, testContext } from "./test-helpers";
import type { Workspace } from "./types";

// The AI can be turned off for one space: `Space.aiEnabled` in `state.json`, set by `space/set-ai`.
// Whether the AI is on for a space is that and `ai.enabled` of the settings together (`aiIsOn`).

describe("space/set-ai", () => {
  const { ctx } = testContext();
  const start = (): Workspace => createDefaultWorkspace({ newId: ctx.newId, clock: ctx.clock });
  const spaceId = (ws: Workspace): string => ws.spaces[0]?.id ?? "";
  const aiOf = (ws: Workspace): boolean | undefined => ws.spaces[0]?.aiEnabled;

  it("starts on for a new space", () => {
    expect(aiOf(start())).toBe(true);
    const ws = applyChecked(start(), { type: "space/create", name: "Second" });
    expect(ws.spaces.map((space) => space.aiEnabled)).toEqual([true, true]);
  });

  it("turns the AI off for the space, and on again", () => {
    const ws = start();
    const off = applyChecked(ws, { type: "space/set-ai", spaceId: spaceId(ws), enabled: false });
    expect(aiOf(off)).toBe(false);
    expect(aiOf(ws)).toBe(true);
    const on = applyChecked(off, { type: "space/set-ai", spaceId: spaceId(off), enabled: true });
    expect(aiOf(on)).toBe(true);
  });

  it("changes only the space it names, and nothing else of it", () => {
    const first = start();
    const ws = applyChecked(first, { type: "space/create", name: "Second" });
    const [a, b] = ws.spaces;
    const next = applyChecked(ws, {
      type: "space/set-ai",
      spaceId: b?.id ?? "",
      enabled: false,
    });
    expect(next.spaces.map((space) => space.aiEnabled)).toEqual([true, false]);
    expect(next.spaces[0]).toBe(a);
    expect({ ...next.spaces[1], aiEnabled: true }).toEqual(b);
    expect(next.activeSpaceId).toBe(ws.activeSpaceId);
  });

  it("changes nothing for the value the space has, an unknown space, or a value that is not a boolean", () => {
    const ws = start();
    expect(applyChecked(ws, { type: "space/set-ai", spaceId: spaceId(ws), enabled: true })).toBe(
      ws,
    );
    expect(applyChecked(ws, { type: "space/set-ai", spaceId: "nope", enabled: false })).toBe(ws);
    const off = applyChecked(ws, { type: "space/set-ai", spaceId: spaceId(ws), enabled: false });
    expect(applyChecked(off, { type: "space/set-ai", spaceId: spaceId(off), enabled: false })).toBe(
      off,
    );
    for (const enabled of ["false", 0, null, undefined]) {
      const broken = { type: "space/set-ai", spaceId: spaceId(ws), enabled } as never;
      expect(reduce(ws, broken, ctx), String(enabled)).toBe(ws);
    }
  });
});

describe("Space.aiEnabled in state.json", () => {
  const plain = () => JSON.parse(serializeWorkspace(richWorkspace())) as Record<string, unknown>;
  const spacesOf = (data: Record<string, unknown>): Record<string, unknown>[] =>
    data["spaces"] as Record<string, unknown>[];

  it("is kept as saved, on or off", () => {
    const data = plain();
    const [first, second] = spacesOf(data);
    if (first === undefined || second === undefined) throw new Error("the fixture has two spaces");
    first["aiEnabled"] = false;
    second["aiEnabled"] = true;
    const result = parseState(JSON.stringify(data));
    if (!result.ok) throw new Error(result.reason);
    expect(result.workspace.spaces.map((space) => space.aiEnabled)).toEqual([false, true]);
    // A second trip changes nothing.
    expect(serializeWorkspace(result.workspace)).toBe(JSON.stringify(data));
  });

  it("is refused when it is not a boolean", () => {
    for (const value of ["yes", 1, null]) {
      const data = plain();
      const first = spacesOf(data)[0];
      if (first === undefined) throw new Error("the fixture has a space");
      first["aiEnabled"] = value;
      const result = parseState(JSON.stringify(data));
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) expect(result.reason).toContain("aiEnabled");
    }
  });

  it("is on for a file saved before the field existed: an old state stays valid", () => {
    // Version 0 had no AI setting at all.
    expect(STATE_V0_FIXTURE).not.toContain("aiEnabled");
    const v0 = parseState(STATE_V0_FIXTURE);
    if (!v0.ok) throw new Error(v0.reason);
    expect(v0.workspace.spaces.length).toBeGreaterThan(0);
    expect(v0.workspace.spaces.map((space) => space.aiEnabled)).toEqual(
      v0.workspace.spaces.map(() => true),
    );
    // Version 1 had it; it is carried over as it was.
    const v1 = parseState(STATE_V1_FIXTURE);
    if (!v1.ok) throw new Error(v1.reason);
    expect(v1.workspace.spaces.every((space) => typeof space.aiEnabled === "boolean")).toBe(true);
  });
});

describe("aiIsOn", () => {
  const settings = (text: string) => {
    const parsed = parseConfigText(text);
    if (!parsed.ok) throw new Error("the settings are valid in this test");
    return parsed.config;
  };

  it("is off unless the settings turn it on: a file without the key is off", () => {
    expect(aiIsOn(settings("{}"), { aiEnabled: true })).toBe(false);
    expect(aiIsOn(settings('{ "ai": {} }'), { aiEnabled: true })).toBe(false);
    expect(aiIsOn(settings('{ "ai": { "enabled": false } }'), { aiEnabled: true })).toBe(false);
  });

  it("is on only when the settings and the space both have it on", () => {
    const on = settings('{ "ai": { "enabled": true } }');
    expect(aiIsOn(on, { aiEnabled: true })).toBe(true);
    expect(aiIsOn(on, { aiEnabled: false })).toBe(false);
    expect(aiIsOn(settings('{ "ai": { "enabled": false } }'), { aiEnabled: false })).toBe(false);
  });
});
