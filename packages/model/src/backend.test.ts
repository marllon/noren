import { describe, expect, it } from "vitest";
import type { SessionExit, SessionId } from "./index";
import { FakeBackend, ManualClock, decodeUtf8, encodeUtf8 } from "./index";

// This package has no DOM or Node typings; the test runtime provides both globals.
declare const performance: { now(): number };
declare const console: { info(...data: unknown[]): void };

const ESC = "\x1b";
const BEL = "\x07";
const osc = (body: string): string => `${ESC}]${body}${BEL}`;
const A = osc("133;A");
const B = osc("133;B");
const C = osc("133;C");
const D = (code: number): string => osc(`133;D;${code}`);
const cwdUrl = (path: string): string => osc(`7;file://fake-host${path}`);
/** What the shell prints to ask for a command, after the directory is `path`. */
const prompt = (path: string): string => `${cwdUrl(path)}${A}fake$ ${B}`;

async function start(options: { cwd?: string; env?: Record<string, string> } = {}) {
  const clock = new ManualClock();
  const backend = new FakeBackend({ clock });
  const id = await backend.createSession({ cols: 80, rows: 24, ...options });
  let pending = "";
  const exits: SessionExit[] = [];
  backend.onOutput(id, (data) => {
    pending += decodeUtf8(data);
  });
  backend.onExit((exit) => exits.push(exit));
  /** Output since the last call. */
  const take = (): string => {
    const text = pending;
    pending = "";
    return text;
  };
  /** Sends a command line and returns what it printed. */
  const run = async (line: string): Promise<string> => {
    take();
    await backend.write(id, `${line}\r`);
    return take();
  };
  return { backend, clock, id, exits, take, run };
}

describe("FakeBackend sessions", () => {
  it("lists a default profile", async () => {
    const backend = new FakeBackend();
    await expect(backend.listProfiles()).resolves.toEqual([
      { id: "fake", name: "Fake shell", default: true },
    ]);
  });

  it("holds the first prompt until someone subscribes", async () => {
    const { take } = await start();
    expect(take()).toBe(prompt("/home/fake"));
  });

  it("rejects an unknown profile and bad sizes", async () => {
    const backend = new FakeBackend();
    await expect(backend.createSession({ profileId: "nope", cols: 80, rows: 24 })).rejects.toThrow(
      "nope",
    );
    await expect(backend.createSession({ cols: 0, rows: 24 })).rejects.toThrow(RangeError);
  });

  it("gives each session its own id, cwd and env", async () => {
    const backend = new FakeBackend();
    const one = await backend.createSession({ cols: 80, rows: 24, cwd: "/work", env: { A: "1" } });
    const two = await backend.createSession({
      profileId: "fake",
      cols: 100,
      rows: 30,
      env: { A: "2" },
    });
    expect(one).not.toBe(two);
    expect(backend.session(one)).toMatchObject({
      cwd: "/work",
      cols: 80,
      rows: 24,
      alive: true,
      env: { A: "1", PWD: "/work" },
    });
    expect(backend.session(two)).toMatchObject({
      cwd: "/home/fake",
      cols: 100,
      rows: 30,
      env: { A: "2", PWD: "/home/fake" },
    });
    expect(backend.session(999)).toBeUndefined();
  });

  it("resizes", async () => {
    const { backend, id } = await start();
    await backend.resize(id, 120, 40);
    expect(backend.session(id)).toMatchObject({ cols: 120, rows: 40 });
  });
});

describe("FakeBackend shell", () => {
  it("echoes what the user types and prints the command output", async () => {
    const { run } = await start();
    expect(await run("echo hello world")).toBe(
      `echo hello world\r\n${C}hello world\r\n${D(0)}${prompt("/home/fake")}`,
    );
  });

  it("honors quotes in echo", async () => {
    const { run } = await start();
    expect(await run(`echo "a  b" 'c'`)).toContain(`${C}a  b c\r\n`);
  });

  it("runs a command once for CR, LF and CRLF", async () => {
    const { backend, id, take } = await start();
    take();
    await backend.write(id, "echo one\r\n");
    expect(take().split(C)).toHaveLength(2);
    await backend.write(id, "echo two\n");
    expect(take().split(C)).toHaveLength(2);
    await backend.write(id, "echo three\r");
    await backend.write(id, "\n");
    expect(take().split(C)).toHaveLength(2);
  });

  it("accepts raw bytes and handles backspace", async () => {
    const { backend, id, take } = await start();
    take();
    await backend.write(id, encodeUtf8("echo abx\x7f\r"));
    expect(take()).toBe(`echo abx\b \b\r\n${C}ab\r\n${D(0)}${prompt("/home/fake")}`);
  });

  it("ignores escape sequences such as arrow keys", async () => {
    const { run } = await start();
    expect(await run(`${ESC}[Aecho ok`)).toContain(`${C}ok\r\n`);
  });

  it("shows a new prompt for an empty line, without running anything", async () => {
    const { run } = await start();
    expect(await run("")).toBe(`\r\n${prompt("/home/fake")}`);
  });

  it("prints the directory with pwd and a fixed listing with ls", async () => {
    const { run } = await start({ cwd: "/work/app" });
    expect(await run("pwd")).toContain(`${C}/work/app\r\n${D(0)}`);
    expect(await run("ls")).toContain(`${C}README.md  notes.txt  src\r\n${D(0)}`);
  });

  it("answers 127 for an unknown command", async () => {
    const { run } = await start();
    expect(await run("nope")).toContain(`fake: command not found: nope\r\n${D(127)}`);
  });
});

describe("exit codes", () => {
  it("false reports 1 and true reports 0", async () => {
    const { run } = await start();
    expect(await run("false")).toBe(`false\r\n${C}${D(1)}${prompt("/home/fake")}`);
    expect(await run("true")).toBe(`true\r\n${C}${D(0)}${prompt("/home/fake")}`);
  });

  it("exit N ends the session with N and fires onExit once", async () => {
    const { backend, id, exits, run } = await start();
    await run("exit 7");
    expect(exits).toEqual([{ id, code: 7 }]);
    expect(backend.session(id)).toMatchObject({ alive: false, exitCode: 7 });
    await expect(backend.write(id, "echo x\r")).rejects.toThrow("unknown session");
    await expect(backend.kill(id)).rejects.toThrow("unknown session");
  });

  it("exit without a number ends with 0", async () => {
    const { exits, run } = await start();
    await run("exit");
    expect(exits.map((e) => e.code)).toEqual([0]);
  });

  it("rejects an invalid exit argument and keeps the session", async () => {
    const { backend, id, exits, run } = await start();
    expect(await run("exit abc")).toContain(D(2));
    expect(await run("exit 256")).toContain(D(2));
    expect(exits).toEqual([]);
    expect(backend.session(id)?.alive).toBe(true);
  });

  it("kill ends a running session with SIGKILL", async () => {
    const { backend, id, exits } = await start();
    await backend.kill(id);
    expect(exits).toEqual([{ id, code: 137, signal: "SIGKILL" }]);
    expect(backend.session(id)).toMatchObject({ alive: false, exitCode: 137 });
  });

  it("stops delivering to unsubscribed listeners", async () => {
    const backend = new FakeBackend();
    const id = await backend.createSession({ cols: 80, rows: 24 });
    const seen: SessionId[] = [];
    const stop = backend.onExit((exit) => seen.push(exit.id));
    stop();
    await backend.kill(id);
    expect(seen).toEqual([]);
  });
});

describe("shell integration sequences", () => {
  it("emits OSC 7 and OSC 133 A, B at the start", async () => {
    const { take } = await start({ cwd: "/work" });
    expect(take()).toBe(`${cwdUrl("/work")}${A}fake$ ${B}`);
  });

  it("puts C before the output and D with the code after it", async () => {
    const { run } = await start();
    const out = await run("echo hi");
    const c = out.indexOf(C);
    const hi = out.indexOf("hi\r\n", c);
    const d = out.indexOf(D(0));
    const next = out.indexOf(A, d);
    expect(c).toBeGreaterThan(out.indexOf("echo hi") + "echo hi".length);
    expect(hi).toBe(c + C.length);
    expect(d).toBe(hi + "hi\r\n".length);
    expect(next).toBeGreaterThan(d);
    expect(out.indexOf(B, next)).toBe(next + A.length + "fake$ ".length);
  });

  it("percent-encodes the directory in OSC 7", async () => {
    const { run } = await start();
    expect(await run('cd "/tmp/my dir"')).toContain(osc("7;file://fake-host/tmp/my%20dir"));
  });
});

describe("cd", () => {
  it("changes directory with relative, absolute, parent and home paths", async () => {
    const { backend, id, run } = await start();
    expect(await run("cd /usr/local")).toBe(`cd /usr/local\r\n${C}${D(0)}${prompt("/usr/local")}`);
    expect(backend.session(id)).toMatchObject({ cwd: "/usr/local", env: { PWD: "/usr/local" } });
    await run("cd bin");
    expect(backend.session(id)?.cwd).toBe("/usr/local/bin");
    await run("cd ../../lib/./x");
    expect(backend.session(id)?.cwd).toBe("/usr/lib/x");
    await run("cd ../../../../..");
    expect(backend.session(id)?.cwd).toBe("/");
    await run("cd");
    expect(backend.session(id)?.cwd).toBe("/home/fake");
    await run("cd ~/src");
    expect(backend.session(id)?.cwd).toBe("/home/fake/src");
  });

  it("is per session and shows in pwd", async () => {
    const backend = new FakeBackend();
    const one = await backend.createSession({ cols: 80, rows: 24 });
    const two = await backend.createSession({ cols: 80, rows: 24 });
    await backend.write(one, "cd /tmp\r");
    expect(backend.session(one)?.cwd).toBe("/tmp");
    expect(backend.session(two)?.cwd).toBe("/home/fake");
  });

  it("refuses more than one argument", async () => {
    const { backend, id, run } = await start();
    expect(await run("cd a b")).toContain(`cd: too many arguments\r\n${D(1)}`);
    expect(backend.session(id)?.cwd).toBe("/home/fake");
  });
});

describe("sleep", () => {
  it("only finishes when the injected clock advances", async () => {
    const { clock, run, take } = await start();
    const out = await run("sleep 2");
    expect(out).toBe(`sleep 2\r\n${C}`);
    expect(clock.pending).toBe(1);

    clock.advance(1999);
    expect(take()).toBe("");
    clock.advance(1);
    expect(take()).toBe(`${D(0)}${prompt("/home/fake")}`);
    expect(clock.pending).toBe(0);
  });

  it("drops input typed while it runs", async () => {
    const { backend, id, clock, take, run } = await start();
    await run("sleep 1");
    await backend.write(id, "echo lost\r");
    expect(take()).toBe("");
    clock.advance(1000);
    take();
    expect(await run("echo back")).toContain(`${C}back\r\n`);
  });

  it("is interrupted by Ctrl+C with code 130", async () => {
    const { backend, id, clock, take, run } = await start();
    await run("sleep 5");
    await backend.write(id, "\x03");
    expect(take()).toBe(`^C\r\n${D(130)}${prompt("/home/fake")}`);
    expect(clock.pending).toBe(0);
    clock.advance(5000);
    expect(take()).toBe("");
  });

  it("is cancelled by kill", async () => {
    const { backend, id, clock, run } = await start();
    await run("sleep 5");
    await backend.kill(id);
    expect(clock.pending).toBe(0);
  });

  it("rejects an invalid time", async () => {
    const { run } = await start();
    expect(await run("sleep")).toContain(`sleep: invalid time interval\r\n${D(1)}`);
    expect(await run("sleep x")).toContain(D(1));
  });
});

describe("seq", () => {
  it("prints the numbers one per line", async () => {
    const { run } = await start();
    expect(await run("seq 3")).toBe(`seq 3\r\n${C}1\r\n2\r\n3\r\n${D(0)}${prompt("/home/fake")}`);
  });

  it("prints nothing for 0 and complains about a bad argument", async () => {
    const { run } = await start();
    expect(await run("seq 0")).toBe(`seq 0\r\n${C}${D(0)}${prompt("/home/fake")}`);
    expect(await run("seq x")).toContain(D(1));
  });

  it("delivers seq 100000 completely in under 1 second", async () => {
    const { backend, id, take } = await start();
    take();
    const chunks: Uint8Array[] = [];
    backend.onOutput(id, (data) => chunks.push(data));

    const started = performance.now();
    await backend.write(id, "seq 100000\r");
    const elapsed = performance.now() - started;
    console.info(`seq 100000: ${elapsed.toFixed(1)} ms in ${chunks.length} chunks`);

    expect(elapsed).toBeLessThan(1000);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    const text = decodeUtf8(all);
    const body = text.slice(text.indexOf(C) + C.length, text.indexOf(D(0)));
    const lines = body.split("\r\n");
    expect(lines).toHaveLength(100001);
    expect(lines[0]).toBe("1");
    expect(lines[99999]).toBe("100000");
    expect(lines[100000]).toBe("");
    expect(text.endsWith(`${D(0)}${prompt("/home/fake")}`)).toBe(true);
  });
});

describe("call log", () => {
  it("records the method and arguments of each call, in order", async () => {
    const backend = new FakeBackend();
    await backend.listProfiles();
    const id = await backend.createSession({ cols: 80, rows: 24, cwd: "/tmp" });
    const stop = backend.onOutput(id, () => undefined);
    backend.onExit(() => undefined);
    await backend.write(id, "ls\r");
    await backend.write(id, new Uint8Array([0x61]));
    await backend.resize(id, 100, 30);
    stop();
    await backend.kill(id);

    expect(backend.calls).toEqual([
      { method: "listProfiles", args: [] },
      { method: "createSession", args: [{ cols: 80, rows: 24, cwd: "/tmp" }] },
      { method: "onOutput", args: [id] },
      { method: "onExit", args: [] },
      { method: "write", args: [id, "ls\r"] },
      { method: "write", args: [id, new Uint8Array([0x61])] },
      { method: "resize", args: [id, 100, 30] },
      { method: "kill", args: [id] },
    ]);
    expect(backend.callsTo("write")).toHaveLength(2);
  });

  it("records calls that fail", async () => {
    const backend = new FakeBackend();
    await expect(backend.kill(42)).rejects.toThrow("unknown session 42");
    expect(backend.calls).toEqual([{ method: "kill", args: [42] }]);
  });
});

describe("gitInfo", () => {
  const main = { branch: "main", detached: false };

  it("answers with the repository of the folder, or of the nearest one above it", async () => {
    const backend = new FakeBackend({ gitRepos: { "/proj": main } });
    expect(await backend.gitInfo("/proj")).toEqual(main);
    expect(await backend.gitInfo("/proj/src/deep")).toEqual(main);
    expect(await backend.gitInfo("/proj/")).toEqual(main);
    expect(await backend.gitInfo("/projects")).toBeNull();
    expect(await backend.gitInfo("/")).toBeNull();
  });

  it("the nearest repository wins, and a worktree can sit inside another folder", async () => {
    const backend = new FakeBackend({
      gitRepos: { "/proj": main, "/proj/wt": { branch: "fix", detached: false } },
    });
    expect(await backend.gitInfo("/proj/wt/src")).toEqual({ branch: "fix", detached: false });
    expect(await backend.gitInfo("/proj/src")).toEqual(main);
  });

  it("reads a Windows folder without regard to case or slash direction", async () => {
    const backend = new FakeBackend({ gitRepos: { "C:/Work/App": main } });
    expect(await backend.gitInfo("c:\\work\\app\\src")).toEqual(main);
    expect(await backend.gitInfo("D:/Work/App")).toBeNull();
  });

  it("gives nothing for a path that is not absolute", async () => {
    const backend = new FakeBackend({ gitRepos: { "/proj": main } });
    expect(await backend.gitInfo("proj")).toBeNull();
    expect(await backend.gitInfo("")).toBeNull();
    expect(await backend.gitInfo("~/proj")).toBeNull();
  });

  it("a detached head and a changed repository are reported as they are now", async () => {
    const backend = new FakeBackend();
    expect(await backend.gitInfo("/proj")).toBeNull();
    backend.setGitRepo("/proj", { branch: "0123456", detached: true });
    expect(await backend.gitInfo("/proj/src")).toEqual({ branch: "0123456", detached: true });
    backend.setGitRepo("/proj/", { branch: "dev", detached: false });
    expect(await backend.gitInfo("/proj")).toEqual({ branch: "dev", detached: false });
    backend.setGitRepo("/proj", null);
    expect(await backend.gitInfo("/proj")).toBeNull();
  });

  it("does not hand out its own object, and records the call", async () => {
    const backend = new FakeBackend({ gitRepos: { "/proj": main } });
    const first = await backend.gitInfo("/proj");
    if (first) first.branch = "changed";
    expect(await backend.gitInfo("/proj")).toEqual(main);
    expect(backend.callsTo("gitInfo").map((call) => call.args)).toEqual([["/proj"], ["/proj"]]);
  });
});
