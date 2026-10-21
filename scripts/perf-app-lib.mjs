// The parts of the real-app measurement (NOR-F11-01b, `scripts/perf.mjs`) that need no process:
// which processes belong to the app, what their memory adds up to, and how a time is read.

/**
 * The processes of the tree under `rootPid` (the root included), from a list of
 * `{ pid, ppid, name, ws, wsPrivate }`: the shells, their console hosts and every process the
 * web view started (its browser process and the ones below it), whatever the depth. A process
 * whose parent is a process of the tree belongs to it; the walk cannot loop on a list that points
 * a process at its own descendant (a process id the system reused).
 */
export function processTree(rootPid, processes) {
  const byParent = new Map();
  for (const process of processes) {
    if (process.pid === process.ppid) continue;
    const children = byParent.get(process.ppid) ?? [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const root = processes.find((process) => process.pid === rootPid);
  if (root === undefined) return [];
  const tree = [root];
  const seen = new Set([rootPid]);
  for (let at = 0; at < tree.length; at++) {
    for (const child of byParent.get(tree[at].pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      tree.push(child);
    }
  }
  return tree;
}

const MB = 1024 * 1024;

/**
 * Which part of the app a process is: Noren itself, its web view, the console host made for a tab
 * (`openconsole.exe` or `conhost.exe`: Noren opens one pseudo console per tab), or anything else
 * in the tree, which is a shell and whatever the shell started (the user's own programs).
 */
export function roleOf(name) {
  const lower = name.toLowerCase();
  if (lower === "noren.exe") return "noren";
  if (lower === "msedgewebview2.exe") return "webview";
  if (lower === "openconsole.exe" || lower === "conhost.exe") return "consoles";
  return "shells";
}

/**
 * What the memory of a tree adds up to, in MB (1 MB = 1,048,576 bytes), by the definition of the
 * spec (section 11): `ownedPrivateWorkingSetMb`, the private working set summed over Noren, its
 * web view processes and the console hosts of the tabs; the shells and what they start do not
 * count. Beside it, the working set summed over the whole tree (pages that processes share count
 * once per process, so it leans high) and the private working set summed over the whole tree,
 * both split by role (`noren`, `webview`, `consoles`, `shells`), and how many processes there are
 * of each kind.
 */
export function sumMemory(tree) {
  const kinds = {};
  const roles = {
    noren: { workingSetMb: 0, privateWorkingSetMb: 0 },
    webview: { workingSetMb: 0, privateWorkingSetMb: 0 },
    consoles: { workingSetMb: 0, privateWorkingSetMb: 0 },
    shells: { workingSetMb: 0, privateWorkingSetMb: 0 },
  };
  let ws = 0;
  let wsPrivate = 0;
  for (const process of tree) {
    ws += process.ws;
    wsPrivate += process.wsPrivate;
    const role = roles[roleOf(process.name)];
    role.workingSetMb += process.ws / MB;
    role.privateWorkingSetMb += process.wsPrivate / MB;
    const name = process.name.toLowerCase();
    kinds[name] = (kinds[name] ?? 0) + 1;
  }
  const owned = roles.noren.privateWorkingSetMb + roles.webview.privateWorkingSetMb;
  return {
    ownedPrivateWorkingSetMb: owned + roles.consoles.privateWorkingSetMb,
    workingSetMb: ws / MB,
    privateWorkingSetMb: wsPrivate / MB,
    roles,
    processes: tree.length,
    kinds,
  };
}

/**
 * Milliseconds from the moment the script launched the app (`launchedMs`, on the clock of the
 * system) to a moment the app reported on the same clock (`reportedMs`, as a text of digits, so
 * no reader rounds it).
 */
export function launchTo(launchedMs, reportedMs) {
  return Number(BigInt(reportedMs) - BigInt(launchedMs));
}

/**
 * The marks the app and its page reported (`[name, milliseconds since 1970]`, the page's with a
 * fraction) as milliseconds since `createdMs`, the creation of the process, to a tenth of a
 * millisecond. A mark reached twice keeps the first time. A report with no marks (an older build)
 * gives an empty object.
 */
export function marksSince(createdMs, marks) {
  const since = {};
  for (const [name, at] of marks ?? []) {
    if (!(name in since)) since[name] = Math.round((at - createdMs) * 10) / 10;
  }
  return since;
}

/** Tabs of the many-tabs side of the app measurement when `--app-tabs` is not given (NOR-F11-01b). */
export const DEFAULT_MANY_TABS = 30;
/** The most tabs `noren --smoke-perf --perf-tabs` takes (`MAX_TABS` in `src-tauri/src/perf.rs`). */
export const MAX_MANY_TABS = 100;

/**
 * The number of tabs of the many-tabs side from the arguments of the script: `--app-tabs <n>`
 * (`--app-tabs=<n>` too), a whole number from 2 to 100, or the default (30) when the option is not
 * there. It throws a sentence that says what is wrong, so the script can end before it launches
 * anything.
 */
export function parseAppTabs(argv) {
  let text;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--app-tabs") {
      text = argv[i + 1];
      if (text === undefined || text.startsWith("--")) throw new Error("--app-tabs needs a number");
    } else if (argv[i].startsWith("--app-tabs=")) {
      text = argv[i].slice("--app-tabs=".length);
    }
  }
  if (text === undefined) return DEFAULT_MANY_TABS;
  const tabs = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(tabs) || tabs < 2 || tabs > MAX_MANY_TABS) {
    throw new Error(`--app-tabs takes a whole number from 2 to ${MAX_MANY_TABS}, not ${text}`);
  }
  return tabs;
}

/**
 * Seconds the script waits for the report of the prompts of a run. The shells of a restored
 * workspace start one after the other, so the wait grows with the tabs: never under 120 s.
 */
export function resultWaitSeconds(tabs) {
  return Math.max(120, 60 + 3 * tabs);
}

/**
 * The summary the script prints and writes (`summarize` is `e2e/perf-stats.ts`): the 1-tab runs
 * (`first`) and the many-tabs runs (`many`, `tabs` tabs each; none with `--first-only`), as
 * `{ label: Summary }`. The labels of the 30-tab side are the ones `docs/PERF.md` has always quoted.
 */
export function appSummary(first, many, tabs, summarize) {
  const pick = (list, key) => summarize(list.map((entry) => entry[key]));
  const rolePick = (list, name, key) => summarize(list.map((entry) => entry.roles[name][key]));
  const summary = {
    "first prompt, 1 tab (ms from process creation)": pick(first, "firstPromptMs"),
    "first prompt, 1 tab (ms from launch in the script)": pick(first, "firstPromptFromLaunchMs"),
    "first prompt, 1 tab (ms from main)": pick(first, "firstPromptFromMainMs"),
    "app-ready, 1 tab (ms from main)": pick(first, "appReadyFromMainMs"),
  };
  if (many.length > 0) {
    const t = `${tabs} tabs`;
    Object.assign(summary, {
      [`first prompt, ${t} (ms from process creation)`]: pick(many, "firstPromptMs"),
      [`last of ${tabs} prompts (ms from process creation)`]: pick(many, "lastPromptMs"),
      [`memory, ${t}, TOTAL by the spec: private working set of Noren + web view + consoles (MB)`]:
        pick(many, "ownedPrivateWorkingSetMb"),
      [`memory, ${t}, working set sum, whole tree (MB)`]: pick(many, "workingSetMb"),
      [`memory, ${t}, private working set sum, whole tree (MB)`]: pick(many, "privateWorkingSetMb"),
      [`memory, ${t}, Noren process, working set (MB)`]: rolePick(many, "noren", "workingSetMb"),
      [`memory, ${t}, web view processes, working set (MB)`]: rolePick(
        many,
        "webview",
        "workingSetMb",
      ),
      [`memory, ${t}, console hosts, working set (MB)`]: rolePick(many, "consoles", "workingSetMb"),
      [`memory, ${t}, shells, working set (MB)`]: rolePick(many, "shells", "workingSetMb"),
      [`memory, ${t}, web view processes, private (MB)`]: rolePick(
        many,
        "webview",
        "privateWorkingSetMb",
      ),
      [`memory, ${t}, console hosts, private (MB)`]: rolePick(
        many,
        "consoles",
        "privateWorkingSetMb",
      ),
      [`memory, ${t}, shells, private (MB)`]: rolePick(many, "shells", "privateWorkingSetMb"),
      [`memory, ${t}, Noren process, private (MB)`]: rolePick(many, "noren", "privateWorkingSetMb"),
      [`processes, ${t}`]: pick(many, "processes"),
    });
  }
  Object.assign(summary, {
    "memory, 1 tab, working set sum, whole tree (MB)": pick(first, "workingSetMb"),
    "memory, 1 tab, private working set sum, whole tree (MB)": pick(first, "privateWorkingSetMb"),
    "memory, 1 tab, TOTAL by the spec (MB)": pick(first, "ownedPrivateWorkingSetMb"),
  });
  return summary;
}
