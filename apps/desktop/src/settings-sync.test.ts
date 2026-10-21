import { describe, expect, it } from "vitest";
import type { SyncStatus } from "@noren/model";
import {
  checkRemote,
  connectedMessage,
  failureMessage,
  pendingLines,
  pulledKinds,
  pullMessage,
  pushMessage,
  statusText,
} from "./settings-sync";

const REMOTE = "https://example.com/me/settings.git";

const connected = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  connected: true,
  remote: REMOTE,
  branch: "main",
  pending: [],
  ahead: 0,
  behind: 0,
  ...over,
});

describe("statusText", () => {
  it("says there is no remote when not connected", () => {
    const none: SyncStatus = {
      connected: false,
      remote: null,
      branch: null,
      pending: [],
      ahead: 0,
      behind: 0,
    };
    expect(statusText(none)).toBe("Not connected to a remote.");
  });

  it("says up to date when there is nothing to send and nothing to pull", () => {
    expect(statusText(connected())).toBe(`Connected to ${REMOTE} (branch main). Up to date.`);
  });

  it("leaves the branch out when the clone has none yet", () => {
    expect(statusText(connected({ branch: null }))).toBe(`Connected to ${REMOTE}. Up to date.`);
  });

  it("counts the files a push would carry", () => {
    const one = connected({ pending: [{ path: "config.jsonc", change: "modified" }] });
    expect(statusText(one)).toContain("1 file to send.");
    const three = connected({
      pending: [
        { path: "config.jsonc", change: "modified" },
        { path: "themes/lagoon.json", change: "added" },
        { path: "mods/a.css", change: "added" },
      ],
    });
    expect(statusText(three)).toContain("3 files to send.");
    expect(statusText(three)).not.toContain("Up to date");
  });

  it("says a commit is waiting to be sent when no file is pending", () => {
    expect(statusText(connected({ ahead: 1 }))).toContain("Saved here, not sent yet.");
  });

  it("says the remote is ahead, with or without files to send", () => {
    expect(statusText(connected({ behind: 2 }))).toContain("The remote has changes to pull.");
    expect(statusText(connected({ behind: 2 }))).not.toContain("Up to date");
    const both = connected({ behind: 1, pending: [{ path: "config.jsonc", change: "added" }] });
    expect(statusText(both)).toContain("The remote has changes to pull. 1 file to send.");
  });
});

describe("pendingLines", () => {
  it("names each file with how it changed", () => {
    const status = connected({
      pending: [
        { path: "config.jsonc", change: "modified" },
        { path: "mods/a.css", change: "added" },
      ],
    });
    expect(pendingLines(status)).toEqual(["config.jsonc (changed)", "mods/a.css (new)"]);
    expect(pendingLines(connected())).toEqual([]);
  });
});

describe("checkRemote", () => {
  it("gives the address without the blanks around it", () => {
    expect(checkRemote(`  ${REMOTE}\n`)).toEqual({ ok: true, remote: REMOTE });
    expect(checkRemote("/srv/settings.git")).toEqual({ ok: true, remote: "/srv/settings.git" });
  });

  it.each([
    ["", "the address is empty"],
    ["   ", "the address is empty"],
    ["http://example.com/me/s.git", "http is not encrypted"],
    ["https://me:secret@example.com/s.git", "has a password"],
    ["https://token@example.com/s.git", "has a user name"],
    ["--upload-pack=calc", "would read as an option"],
    ["ext::sh -c calc", "has a space"],
    ["ext::calc", "helper transport"],
  ])("refuses %j and says why, with nothing connected", (input, reason) => {
    const checked = checkRemote(input);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.message.alert).toBe(true);
    expect(checked.message.text).toContain(reason);
    expect(checked.message.text).toContain("Nothing was connected.");
  });
});

describe("pullMessage", () => {
  it("says nothing came and nothing changed", () => {
    expect(pullMessage({ kind: "up_to_date" })).toEqual({
      text: "Nothing to pull: this computer is up to date. Nothing changed.",
      alert: false,
    });
  });

  it("names the files it wrote", () => {
    expect(pullMessage({ kind: "updated", files: ["themes/lagoon.json"] })).toEqual({
      text: "Pulled 1 file: themes/lagoon.json.",
      alert: false,
    });
    expect(pullMessage({ kind: "updated", files: ["config.jsonc", "mods/a.css"] })).toEqual({
      text: "Pulled 2 files: config.jsonc, mods/a.css.",
      alert: false,
    });
  });

  it("is a warning for a conflict, names the paths and says nothing changed", () => {
    const message = pullMessage({ kind: "conflict", paths: ["config.jsonc", "mods/a.css"] });
    expect(message.alert).toBe(true);
    expect(message.text).toContain("config.jsonc, mods/a.css");
    expect(message.text).toContain("Nothing changed on this computer.");
    expect(message.text).not.toContain("Pulled");
  });
});

describe("pushMessage", () => {
  it("names the files sent", () => {
    expect(pushMessage({ committed: true, pushed: true, files: ["config.jsonc"] })).toEqual({
      text: "Pushed 1 file: config.jsonc.",
      alert: false,
    });
    expect(
      pushMessage({ committed: true, pushed: true, files: ["config.jsonc", "mods/a.css"] }).text,
    ).toBe("Pushed 2 files: config.jsonc, mods/a.css.");
  });

  it("says the commits that were waiting went", () => {
    expect(pushMessage({ committed: false, pushed: true, files: [] })).toEqual({
      text: "Pushed the changes that were waiting.",
      alert: false,
    });
  });

  it("says there was nothing to push", () => {
    expect(pushMessage({ committed: false, pushed: false, files: [] })).toEqual({
      text: "Nothing to push.",
      alert: false,
    });
  });

  it("warns when files were saved but not sent", () => {
    const message = pushMessage({ committed: true, pushed: false, files: ["config.jsonc"] });
    expect(message.alert).toBe(true);
    expect(message.text).toContain("nothing was sent");
  });
});

describe("failureMessage and connectedMessage", () => {
  it("keeps the text of the backend as it came", () => {
    const error = new Error("git is not installed: install it and try again");
    for (const step of ["status", "connect", "pull", "push"] as const) {
      const message = failureMessage(step, error);
      expect(message.alert).toBe(true);
      expect(message.text).toContain("git is not installed: install it and try again");
    }
    expect(failureMessage("pull", "plain text").text).toBe("Could not pull: plain text");
  });

  it("warns that config.jsonc travels whole and that git must already work in a terminal", () => {
    const message = connectedMessage(connected());
    expect(message.alert).toBe(false);
    expect(message.text).toContain(`Connected to ${REMOTE}`);
    expect(message.text).toContain("All of config.jsonc travels");
    expect(message.text).toContain("password or an ssh passphrase");
    expect(message.text).toContain("in a terminal first");
  });
});

describe("pulledKinds", () => {
  it("sorts the files by what the app reads again", () => {
    expect(pulledKinds(["config.jsonc"])).toEqual({ config: true, themes: false, mods: false });
    expect(pulledKinds(["themes/a.json", "mods/b.css"])).toEqual({
      config: false,
      themes: true,
      mods: true,
    });
    expect(pulledKinds(["spaces/x.noren-space.json"])).toEqual({
      config: false,
      themes: false,
      mods: false,
    });
    expect(pulledKinds([])).toEqual({ config: false, themes: false, mods: false });
  });
});
