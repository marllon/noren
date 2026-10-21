import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards for the security review (docs/SECURITY_REVIEW.md): what the page is allowed to call and
// the few things it must never do. They read the source as it is, so a new call to the system, a new
// way to open a window or to build HTML from text fails here until someone decides it is safe.

const here = fileURLToPath(new URL(".", import.meta.url));
const tauriDir = join(here, "..", "src-tauri");

function sources(dir: string): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      found.push({ file: path.slice(here.length), text: readFileSync(path, "utf8") });
    }
  }
  return found;
}

/** The code of a file without its comments (so a comment can talk about what the code must not do). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const pageSources = sources(here).map(({ file, text }) => ({ file, text: code(text) }));

// The one file that may start a Worker: the host of the plugins, which runs each plugin in a Worker
// made from a blob (NOR-F18-01c, docs/SECURITY_REVIEW.md section 1). Any other file that starts one
// fails the guard below until someone decides it is safe.
const MAY_START_A_WORKER = ["plugin-host.ts"];

// The one file that may make an iframe: the panel of a plugin, whose frame has an empty `sandbox`
// (NOR-F18-01d, docs/SECURITY_REVIEW.md section 1). The list is explicit; any other file that makes
// a frame fails the guard below until someone decides it is safe.
const MAY_MAKE_A_FRAME = ["PluginPanel.tsx"];

describe("what the page may not do", () => {
  it.each([
    ["window.open", /\bwindow\.open\s*\(|\bopen\s*\(\s*["'`]https?:/],
    ["eval", /\beval\s*\(/],
    ["new Function", /\bnew\s+Function\s*\(/],
    ["string timers", /\bset(?:Timeout|Interval)\s*\(\s*["'`]/],
    ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
    ["innerHTML / outerHTML", /\.(?:inner|outer)HTML\s*=/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\.write(?:ln)?\s*\(/],
    ["an iframe", /<iframe|createElement\(\s*["']iframe["']/],
    ["a remote script", /createElement\(\s*["']script["']/],
    ["a link element", /<a\s|createElement\(\s*["']a["']/],
    ["location assignment", /\b(?:window\.)?location\.(?:href|assign|replace)\b\s*(?:=|\()/],
    ["a worker", /\bnew\s+(?:Shared)?Worker\s*\(/],
    ["fetch to the network", /\bfetch\s*\(/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["WebSocket", /\bnew\s+WebSocket\s*\(/],
    ["EventSource", /\bnew\s+EventSource\s*\(/],
    ["a WebLinksAddon with the default handler", /new\s+WebLinksAddon\s*\(\s*\)/],
  ])("does not use %s", (what, pattern) => {
    const exempt =
      what === "a worker" ? MAY_START_A_WORKER : what === "an iframe" ? MAY_MAKE_A_FRAME : [];
    const offenders = pageSources
      .filter(({ file, text }) => pattern.test(text) && !exempt.includes(file))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps the Worker to the host of the plugins, and the host does start one", () => {
    expect(MAY_START_A_WORKER).toHaveLength(1);
    const hosts = pageSources
      .filter(({ text }) => /\bnew\s+Worker\s*\(/.test(text))
      .map(({ file }) => file);
    expect(hosts).toEqual(MAY_START_A_WORKER);
  });

  it("keeps the frame to the panel of a plugin, which has an empty sandbox and a page of its own", () => {
    expect(MAY_MAKE_A_FRAME).toHaveLength(1);
    const frames = pageSources
      .filter(({ text }) => /<iframe|createElement\(\s*["']iframe["']/.test(text))
      .map(({ file }) => file);
    expect(frames).toEqual(MAY_MAKE_A_FRAME);
    const panel = pageSources.find(({ file }) => file === "PluginPanel.tsx")?.text ?? "";
    // The sandbox comes from one constant that is empty (see PluginPanel.test.tsx), the content only
    // through srcDoc (never a src address), and nothing gives the frame a power back.
    expect(panel).toMatch(/<iframe[^>]*\bsandbox=\{PANEL_SANDBOX\}/);
    expect(panel).toMatch(/<iframe[^>]*\bsrcDoc=\{panelDocument\(/);
    expect(panel).not.toMatch(/<iframe[^>]*\ssrc=/);
    expect(panel).not.toMatch(/allow-/);
    const document = pageSources.find(({ file }) => file === "plugin-panel.ts")?.text ?? "";
    expect(document).not.toMatch(/allow-/);
  });

  it("gives the terminal a handler for OSC 8 links that does not open a window", () => {
    const terminal = pageSources.find(({ file }) => file === "TerminalView.tsx");
    expect(terminal?.text).toMatch(/linkHandler:\s*\{[\s\S]*?allowNonHttpProtocols:\s*false/);
    expect(terminal?.text).toMatch(/linkHandler:\s*\{\s*activate:\s*activateLink,/);
    expect(terminal?.text).toMatch(/new WebLinksAddon\(activateLink\)/);
    // Whatever handler a link gets, it ends in the question unless Ctrl was held and the shell took
    // the link: there is no other way out of it.
    const handler = /const activateLink = [\s\S]*?\n {4}\};/.exec(terminal?.text ?? "")?.[0] ?? "";
    expect(handler).toMatch(/event\.ctrlKey \|\| event\.metaKey/);
    expect(handler).toMatch(
      /onOpenLinkRef\.current\?\.\(uri\) === true\) return;\s*requestExternalLink\(uri\);/,
    );
  });

  it("uses only the parts of the Tauri API that the capabilities grant", () => {
    const modules = new Set<string>();
    for (const { text } of pageSources) {
      for (const match of text.matchAll(/from\s+["']@tauri-apps\/api\/([a-z]+)["']/g)) {
        modules.add(match[1] ?? "");
      }
    }
    expect([...modules].sort()).toEqual(["core", "event", "path", "window"]);
    for (const { file, text } of pageSources) {
      expect(text, file).not.toMatch(/from\s+["']@tauri-apps\/plugin-/);
      // Looking whether the page is inside Tauri is fine; nothing may call through the internals.
      expect(text.replaceAll('"__TAURI_INTERNALS__" in window', ""), file).not.toMatch(
        /__TAURI__|__TAURI_INTERNALS__/,
      );
    }
  });

  it("calls only commands that the build script declares", () => {
    const build = readFileSync(join(tauriDir, "build.rs"), "utf8");
    const declared = new Set(
      [...build.slice(build.indexOf("const COMMANDS")).matchAll(/^\s+"([a-z_]+)",$/gm)].map(
        (match) => match[1],
      ),
    );
    const called = new Set<string>();
    for (const { text } of pageSources) {
      for (const match of text.matchAll(/\binvoke(?:<[^>(]*>)?\(\s*"([a-z_]+)"/g)) {
        called.add(match[1] ?? "");
      }
      for (const match of text.matchAll(/(?:_COMMAND|COMMAND)\s*=\s*"([a-z_]+)"/g)) {
        called.add(match[1] ?? "");
      }
    }
    expect(called.size).toBeGreaterThan(30);
    for (const command of called) {
      expect(declared.has(command), `${command} is invoked but not declared in build.rs`).toBe(
        true,
      );
    }
  });
});

describe("the page that is served", () => {
  const html = readFileSync(join(here, "..", "index.html"), "utf8");

  it("has no inline script, inline handler or remote resource", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
    expect(html).not.toMatch(/<(?:iframe|object|embed|base|form)\b/i);
  });
});
