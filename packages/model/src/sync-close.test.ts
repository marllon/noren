import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUSH_ON_CLOSE,
  closePushDecision,
  configJsonSchema,
  parseConfigText,
  pushOnCloseAllowed,
} from "./index";
import type { SyncStatus } from "./index";

// The switch for pushing when the app closes: `sync.pushOnClose` in config.jsonc, off by default,
// and the decision of what closing does about the sync.

function syncOf(text: string) {
  const result = parseConfigText(text);
  if (!result.ok) throw new Error(`expected a valid file: ${JSON.stringify(result.errors)}`);
  return result.config.sync;
}

function status(over: Partial<SyncStatus> = {}): SyncStatus {
  return {
    connected: true,
    remote: "https://example.com/you/noren.git",
    branch: "main",
    pending: [],
    ahead: 0,
    behind: 0,
    ...over,
  };
}

describe("sync.pushOnClose", () => {
  it("is off by default, and says so", () => {
    expect(DEFAULT_PUSH_ON_CLOSE).toBe(false);
    expect(pushOnCloseAllowed(undefined)).toBe(false);
  });

  it("is off when the file says nothing about it", () => {
    expect(pushOnCloseAllowed(syncOf("{}"))).toBe(false);
    expect(pushOnCloseAllowed(syncOf('{ "sync": {} }'))).toBe(false);
    expect(pushOnCloseAllowed(syncOf('{ "sessions": { "keepOnClose": true } }'))).toBe(false);
  });

  it("is on when the file says true, and off when it says false", () => {
    expect(pushOnCloseAllowed(syncOf('{ "sync": { "pushOnClose": true } }'))).toBe(true);
    expect(pushOnCloseAllowed(syncOf('{ "sync": { "pushOnClose": false } }'))).toBe(false);
  });

  it("refuses a value that is not true or false, with the line and the place", () => {
    for (const value of ['"yes"', "0", "1", "null", '"true"', "[]"]) {
      const result = parseConfigText(`{
  "sync": {
    "pushOnClose": ${value}
  }
}`);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.path, value).toBe("sync.pushOnClose");
      expect(result.errors[0]?.line, value).toBe(3);
    }
  });

  it("refuses a setting the section does not have", () => {
    expect(parseConfigText('{ "sync": { "pushOnClosed": true } }').ok).toBe(false);
  });

  it("is in the JSON schema with its default and a description a person can read", () => {
    const schema = configJsonSchema() as {
      properties: {
        sync: {
          additionalProperties: boolean;
          required?: string[];
          properties: { pushOnClose: Record<string, unknown> };
        };
      };
    };
    expect(schema.properties.sync.additionalProperties).toBe(false);
    expect(schema.properties.sync.required ?? []).toEqual([]);
    const entry = schema.properties.sync.properties.pushOnClose;
    expect(entry).toMatchObject({ type: "boolean", default: false });
    const description = String(entry["description"]);
    for (const word of ["closing", "remote", "never stops"]) {
      expect(description, word).toContain(word);
    }
  });
});

describe("closePushDecision", () => {
  const pendingFile = [{ path: "config.jsonc", change: "modified" as const }];

  it("pushes when it is on, a remote is connected and a file waits", () => {
    expect(
      closePushDecision({
        enabled: true,
        status: status({ pending: pendingFile }),
        spaceFilesWritten: 0,
      }),
    ).toEqual({ action: "push" });
  });

  it("does nothing when the option is off, whatever else is true", () => {
    expect(
      closePushDecision({
        enabled: false,
        status: status({ pending: pendingFile, ahead: 2 }),
        spaceFilesWritten: 3,
      }),
    ).toEqual({ action: "skip", reason: "off" });
  });

  it("does nothing with no remote connected, or when the status could not be read", () => {
    const none = { action: "skip", reason: "no-remote" };
    expect(
      closePushDecision({
        enabled: true,
        status: status({ connected: false, remote: null, branch: null, pending: pendingFile }),
        spaceFilesWritten: 1,
      }),
    ).toEqual(none);
    expect(closePushDecision({ enabled: true, status: undefined, spaceFilesWritten: 1 })).toEqual(
      none,
    );
  });

  it("does nothing when nothing waits: no pending file, no commit to send, no space file written", () => {
    expect(closePushDecision({ enabled: true, status: status(), spaceFilesWritten: 0 })).toEqual({
      action: "skip",
      reason: "nothing-pending",
    });
    // Behind the remote is not something a push carries.
    expect(
      closePushDecision({ enabled: true, status: status({ behind: 2 }), spaceFilesWritten: 0 }),
    ).toEqual({ action: "skip", reason: "nothing-pending" });
  });

  it("pushes for a space file written just now, which the status does not show yet", () => {
    expect(closePushDecision({ enabled: true, status: status(), spaceFilesWritten: 1 })).toEqual({
      action: "push",
    });
  });

  it("pushes the commits that wait to be sent", () => {
    expect(
      closePushDecision({ enabled: true, status: status({ ahead: 1 }), spaceFilesWritten: 0 }),
    ).toEqual({ action: "push" });
  });
});
