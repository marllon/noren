import { describe, expect, it } from "vitest";
import type { GitInfo } from "./backend";
import { FakeBackend } from "./fake-backend";
import { ManualClock } from "./clock";
import { PaneLocationTracker } from "./pane-location";
import type { PaneCommandEvent, PaneLocation } from "./pane-location";
import { encodeUtf8 } from "./utf8";

// This package has no DOM or Node typings; the test runtime provides the timer.
declare function setTimeout(callback: () => void, ms: number): unknown;

const ESC = "\x1b";
const BEL = "\x07";
const osc = (body: string): string => `${ESC}]${body}${BEL}`;
/** What a prompt of an integrated shell sends: the folder, then the start of the prompt. */
const prompt = (cwd: string): string => osc(`7;file://host${cwd}`) + osc("133;A");

const MAIN: GitInfo = { branch: "main", detached: false };

/** Lets the lookups (promises) that are already settled run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A pane that already has the folder `cwd` (a restored one, or one started in a chosen folder);
 * `null` is a pane that has none.
 */
function setup(repos: Record<string, GitInfo> = { "/proj": MAIN }, cwd: string | null = "/h") {
  const backend = new FakeBackend({ gitRepos: repos });
  const locations: PaneLocation[] = [];
  const tracker = new PaneLocationTracker({
    gitInfo: (folder) => backend.gitInfo(folder),
    onLocation: (location) => locations.push(location),
    ...(cwd !== null ? { cwd } : {}),
  });
  return { backend, tracker, locations };
}

describe("PaneLocationTracker", () => {
  it("reports the folder and its branch at a prompt, with one lookup", async () => {
    const { backend, tracker, locations } = setup();
    tracker.feed(prompt("/proj"));
    await settle();
    expect(locations).toEqual([{ cwd: "/proj", gitBranch: "main" }]);
    expect(backend.callsTo("gitInfo")).toHaveLength(1);
    expect(tracker.cwd).toBe("/proj");
  });

  it("a folder outside any repository has no branch", async () => {
    const { tracker, locations } = setup();
    tracker.feed(prompt("/tmp"));
    await settle();
    expect(locations).toEqual([{ cwd: "/tmp" }]);
  });

  it("follows a cd into a repository and out of it", async () => {
    const { tracker, locations } = setup();
    tracker.feed(prompt("/home/me"));
    await settle();
    tracker.feed(prompt("/proj"));
    await settle();
    tracker.feed(prompt("/proj/src"));
    await settle();
    tracker.feed(prompt("/home/me"));
    await settle();
    expect(locations).toEqual([
      { cwd: "/home/me" },
      { cwd: "/proj", gitBranch: "main" },
      { cwd: "/proj/src", gitBranch: "main" },
      { cwd: "/home/me" },
    ]);
  });

  it("reads the branch again at a prompt when only a command changed it", async () => {
    const { backend, tracker, locations } = setup();
    tracker.feed(prompt("/proj"));
    await settle();
    backend.setGitRepo("/proj", { branch: "feature/x", detached: false });
    tracker.feed(osc("133;C") + osc("133;D;0") + prompt("/proj"));
    await settle();
    expect(locations).toEqual([
      { cwd: "/proj", gitBranch: "main" },
      { cwd: "/proj", gitBranch: "feature/x" },
    ]);
  });

  it("reads the branch when a command ends even if the shell sends no prompt mark after it", async () => {
    const { backend, tracker, locations } = setup();
    tracker.feed(prompt("/proj"));
    await settle();
    backend.setGitRepo("/proj", { branch: "topic", detached: false });
    tracker.feed(osc("133;D;0"));
    await settle();
    expect(locations.at(-1)).toEqual({ cwd: "/proj", gitBranch: "topic" });
  });

  it("a detached head shows the short commit", async () => {
    const { tracker, locations } = setup({ "/proj": { branch: "0123456", detached: true } });
    tracker.feed(prompt("/proj"));
    await settle();
    expect(locations).toEqual([{ cwd: "/proj", gitBranch: "0123456" }]);
  });

  it("understands the folder of cmd (OSC 9;9)", async () => {
    const { tracker, locations } = setup({ "C:/work/app": MAIN });
    tracker.feed(osc("9;9;C:\\work\\app") + osc("133;A"));
    await settle();
    expect(locations).toEqual([{ cwd: "C:/work/app", gitBranch: "main" }]);
  });

  it("reads a sequence that arrives cut in any place, as bytes", async () => {
    const whole = encodeUtf8(prompt("/proj"));
    for (let cut = 1; cut < whole.length; cut++) {
      const { tracker, locations } = setup();
      tracker.feed(whole.slice(0, cut));
      tracker.feed(whole.slice(cut));
      await settle();
      // A cut between the folder and the start of the prompt gives the same answer twice.
      expect(locations.length, `cut at ${cut}`).toBeGreaterThanOrEqual(1);
      expect(locations.length, `cut at ${cut}`).toBeLessThanOrEqual(2);
      for (const location of locations) {
        expect(location, `cut at ${cut}`).toEqual({ cwd: "/proj", gitBranch: "main" });
      }
    }
  });

  it("does nothing for plain output, for other sequences and for a prompt with no folder known yet", async () => {
    const { backend, tracker, locations } = setup({ "/proj": MAIN }, null);
    tracker.feed("hello\r\n");
    tracker.feed(osc("0;a window title"));
    tracker.feed(osc("133;A"));
    tracker.feed(osc("133;D;1"));
    await settle();
    expect(locations).toEqual([]);
    expect(backend.callsTo("gitInfo")).toHaveLength(0);
  });

  it("a command that starts, or a prompt that ends, does not read the branch", async () => {
    const { backend, tracker } = setup({ "/proj": MAIN }, "/proj");
    tracker.feed(osc("133;B") + osc("133;C") + osc("633;E;ls"));
    await settle();
    expect(backend.callsTo("gitInfo")).toHaveLength(0);
  });

  it("a pane that starts in a known folder gets its branch at the first prompt", async () => {
    const { tracker, locations } = setup({ "/proj": MAIN }, "/proj");
    tracker.feed(osc("133;A"));
    await settle();
    expect(locations).toEqual([{ cwd: "/proj", gitBranch: "main" }]);
  });

  it("a lookup that fails counts as no branch, and the folder is still reported", async () => {
    const locations: PaneLocation[] = [];
    const tracker = new PaneLocationTracker({
      gitInfo: () => Promise.reject(new Error("the bridge is gone")),
      onLocation: (location) => locations.push(location),
      cwd: "/h",
    });
    tracker.feed(prompt("/proj"));
    await settle();
    expect(locations).toEqual([{ cwd: "/proj" }]);
  });

  it("an empty branch name is not shown", async () => {
    const locations: PaneLocation[] = [];
    const tracker = new PaneLocationTracker({
      gitInfo: () => Promise.resolve({ branch: "", detached: false }),
      onLocation: (location) => locations.push(location),
      cwd: "/h",
    });
    tracker.feed(prompt("/proj"));
    await settle();
    expect(locations).toEqual([{ cwd: "/proj" }]);
  });

  it("keeps one lookup in flight: the requests that come meanwhile become the newest one", async () => {
    const pending: { cwd: string; resolve(info: GitInfo | null): void }[] = [];
    const locations: PaneLocation[] = [];
    const tracker = new PaneLocationTracker({
      gitInfo: (cwd) => new Promise((resolve) => pending.push({ cwd, resolve })),
      onLocation: (location) => locations.push(location),
      cwd: "/h",
    });
    tracker.feed(prompt("/a"));
    tracker.feed(prompt("/b"));
    tracker.feed(prompt("/c"));
    await settle();
    expect(pending.map((p) => p.cwd)).toEqual(["/a"]);

    pending[0]?.resolve(MAIN);
    await settle();
    // The first answer is delivered, and only the newest request is looked up after it.
    expect(locations).toEqual([{ cwd: "/a", gitBranch: "main" }]);
    expect(pending.map((p) => p.cwd)).toEqual(["/a", "/c"]);

    pending[1]?.resolve(null);
    await settle();
    expect(locations).toEqual([{ cwd: "/a", gitBranch: "main" }, { cwd: "/c" }]);
    expect(pending).toHaveLength(2);
  });
});

describe("PaneLocationTracker on a pane that has no folder", () => {
  it("does not record the folder the shell starts in, but reports its branch", async () => {
    const { tracker, locations } = setup({ "/proj": MAIN }, null);
    tracker.feed(prompt("/proj"));
    await settle();
    expect(locations).toEqual([{ gitBranch: "main" }]);

    // The same folder at the next prompt: still the start.
    tracker.feed(osc("133;D;0") + prompt("/proj"));
    await settle();
    expect(locations.at(-1)).toEqual({ gitBranch: "main" });
    expect(locations.every((location) => !("cwd" in location))).toBe(true);
  });

  it("a start folder outside a repository gives an empty location", async () => {
    const { tracker, locations } = setup({ "/proj": MAIN }, null);
    tracker.feed(prompt("/home/me"));
    await settle();
    expect(locations).toEqual([{}]);
  });

  it("records the folder from the moment the shell leaves the start, and keeps recording", async () => {
    const { tracker, locations } = setup({ "/proj": MAIN }, null);
    tracker.feed(prompt("/home/me"));
    await settle();
    tracker.feed(prompt("/proj"));
    await settle();
    // Coming back to where it started is a move like any other, since the pane has a folder now.
    tracker.feed(prompt("/home/me"));
    await settle();
    expect(locations).toEqual([{}, { cwd: "/proj", gitBranch: "main" }, { cwd: "/home/me" }]);
  });

  it("tells the start folder apart without regard to slash direction, trailing slash or Windows case", async () => {
    const { tracker, locations } = setup({}, null);
    tracker.feed(osc("7;file://host/C:/Work/App"));
    await settle();
    tracker.feed(osc("9;9;c:\\work\\app\\") + osc("133;A"));
    await settle();
    expect(locations.every((location) => !("cwd" in location))).toBe(true);
    tracker.feed(osc("9;9;C:\\Work\\Other") + osc("133;A"));
    await settle();
    expect(locations.at(-1)).toEqual({ cwd: "C:/Work/Other" });
  });

  it("a lookup for the start folder that is still in flight when the shell leaves it does not put the start folder on the pane", async () => {
    const pending: { cwd: string; resolve(info: GitInfo | null): void }[] = [];
    const locations: PaneLocation[] = [];
    const tracker = new PaneLocationTracker({
      gitInfo: (cwd) => new Promise((resolve) => pending.push({ cwd, resolve })),
      onLocation: (location) => locations.push(location),
    });
    tracker.feed(prompt("/start"));
    tracker.feed(prompt("/elsewhere"));
    pending[0]?.resolve(null);
    await settle();
    pending[1]?.resolve(MAIN);
    await settle();
    expect(locations).toEqual([{}, { cwd: "/elsewhere", gitBranch: "main" }]);
  });
});

describe("PaneLocationTracker with a session of the FakeBackend", () => {
  async function session(repos: Record<string, GitInfo>, cwd?: string) {
    const backend = new FakeBackend({ gitRepos: repos, home: "/home/fake" });
    const locations: PaneLocation[] = [];
    const tracker = new PaneLocationTracker({
      gitInfo: (folder) => backend.gitInfo(folder),
      onLocation: (location) => locations.push(location),
      ...(cwd !== undefined ? { cwd } : {}),
    });
    const id = await backend.createSession({ cols: 80, rows: 24, ...(cwd ? { cwd } : {}) });
    backend.onOutput(id, (bytes) => tracker.feed(bytes));
    const type = async (line: string) => {
      await backend.write(id, `${line}\r`);
      await settle();
    };
    return { backend, locations, type };
  }

  it("a fresh pane shows nothing until it moves; a cd into a repository gives the branch and a cd out takes it away", async () => {
    const { locations, type } = await session({ "/proj": MAIN });
    await settle();
    expect(locations.at(-1)).toEqual({});
    await type("cd /proj");
    expect(locations.at(-1)).toEqual({ cwd: "/proj", gitBranch: "main" });
    await type("cd /tmp");
    expect(locations.at(-1)).toEqual({ cwd: "/tmp" });
    await type("cd ~");
    expect(locations.at(-1)).toEqual({ cwd: "/home/fake" });
  });

  it("a pane started in a repository folder shows its branch at once", async () => {
    const { locations } = await session({ "/proj": MAIN }, "/proj");
    await settle();
    expect(locations.at(-1)).toEqual({ cwd: "/proj", gitBranch: "main" });
  });

  it("repeating a command in the same place reports the same location each time", async () => {
    const { locations, type } = await session({ "/proj": MAIN });
    await type("cd /proj");
    const before = locations.length;
    await type("true");
    expect(locations.length).toBeGreaterThan(before);
    expect(new Set(locations.slice(before).map((l) => JSON.stringify(l)))).toEqual(
      new Set([JSON.stringify({ cwd: "/proj", gitBranch: "main" })]),
    );
  });
});

describe("PaneLocationTracker commands", () => {
  /** A tracker that records the commands, on a clock the test moves. */
  function commands() {
    let now = 1000;
    const events: PaneCommandEvent[] = [];
    const tracker = new PaneLocationTracker({
      gitInfo: () => Promise.resolve(null),
      onLocation: () => undefined,
      onCommand: (event) => events.push(event),
      clock: { now: () => now },
    });
    return {
      tracker,
      events,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const line = (text: string): string => osc(`633;E;${text}`);

  it("reports a command at its start with the line, and at its end with the code and duration", () => {
    const { tracker, events, advance } = commands();
    tracker.feed(line("npm test") + osc("133;C"));
    expect(events).toEqual([{ kind: "start", text: "npm test" }]);
    advance(2500);
    tracker.feed(osc("133;D;1") + prompt("/proj"));
    expect(events.at(-1)).toEqual({ kind: "end", text: "npm test", exitCode: 1, durationMs: 2500 });
    expect(events).toHaveLength(2);
  });

  it("a command with no line reported starts and ends without a text", () => {
    const { tracker, events, advance } = commands();
    tracker.feed(osc("133;C"));
    advance(40);
    tracker.feed(osc("133;D;0"));
    expect(events).toEqual([{ kind: "start" }, { kind: "end", exitCode: 0, durationMs: 40 }]);
  });

  it("a command that ends without an exit code has none in the report", () => {
    const { tracker, events } = commands();
    tracker.feed(line("ls") + osc("133;C") + osc("133;D"));
    expect(events.at(-1)).toEqual({ kind: "end", text: "ls", durationMs: 0 });
  });

  it("a 133;D with nothing before it, such as the first prompt of a shell, is not a command", () => {
    const { tracker, events } = commands();
    tracker.feed(osc("133;D;0") + prompt("/proj"));
    expect(events).toEqual([]);
  });

  it("a prompt that comes while a command runs ends it without a code", () => {
    const { tracker, events, advance } = commands();
    tracker.feed(line("sleep 9") + osc("133;C"));
    advance(300);
    tracker.feed(prompt("/proj"));
    expect(events.at(-1)).toEqual({ kind: "end", text: "sleep 9", durationMs: 300 });
    // The D that follows is not a second end.
    tracker.feed(osc("133;D;130"));
    expect(events).toHaveLength(2);
  });

  it("a line with its end but without a start is reported when it ends, without a duration", () => {
    const { tracker, events } = commands();
    tracker.feed(line("make") + osc("133;D;2"));
    expect(events).toEqual([{ kind: "end", text: "make", exitCode: 2 }]);
  });

  it("does not take the line of one command for the next", () => {
    const { tracker, events } = commands();
    tracker.feed(line("one") + osc("133;C") + osc("133;D;0"));
    tracker.feed(osc("133;C") + osc("133;D;0"));
    expect(events.map((e) => (e.kind === "start" ? "start" : `end ${e.text ?? "-"}`))).toEqual([
      "start",
      "end one",
      "start",
      "end -",
    ]);
  });

  it("reads the same commands however the output is cut", () => {
    const whole = line("echo a;b") + osc("133;C") + osc("133;D;3");
    const reference = commands();
    reference.tracker.feed(whole);
    const bytes = encodeUtf8(whole);
    for (let cut = 1; cut < bytes.length; cut++) {
      const split = commands();
      split.tracker.feed(bytes.slice(0, cut));
      split.tracker.feed(bytes.slice(cut));
      expect(split.events).toEqual(reference.events);
    }
  });

  it("follows a command of the fake shell: the line, the failure code and how long sleep took", async () => {
    const backend = new FakeBackend();
    const events: PaneCommandEvent[] = [];
    const tracker = new PaneLocationTracker({
      gitInfo: (folder) => backend.gitInfo(folder),
      onLocation: () => undefined,
      onCommand: (event) => events.push(event),
      clock: backend.clock,
    });
    const id = await backend.createSession({ cols: 80, rows: 24 });
    backend.onOutput(id, (bytes) => tracker.feed(bytes));
    await backend.write(id, "sleep 3\r");
    expect(events).toEqual([{ kind: "start", text: "sleep 3" }]);
    (backend.clock as ManualClock).advance(3000);
    expect(events.at(-1)).toEqual({ kind: "end", text: "sleep 3", exitCode: 0, durationMs: 3000 });
    await backend.write(id, "false\r");
    expect(events.at(-1)).toMatchObject({ kind: "end", text: "false", exitCode: 1 });
  });

  it("without onCommand the commands are ignored", () => {
    const tracker = new PaneLocationTracker({
      gitInfo: () => Promise.resolve(null),
      onLocation: () => undefined,
    });
    expect(() => tracker.feed(line("ls") + osc("133;C") + osc("133;D;0"))).not.toThrow();
  });
});
