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

/** Which part of the app a process is: Noren itself, its web view, or a shell (and its console host). */
export function roleOf(name) {
  const lower = name.toLowerCase();
  if (lower === "noren.exe") return "noren";
  if (lower === "msedgewebview2.exe") return "webview";
  return "shells";
}

/**
 * What the memory of a tree adds up to, in MB (1 MB = 1,048,576 bytes): the working set of every
 * process summed (the figure of the target; pages that processes share count once per process, so
 * it leans high), the private working set summed (each page once, what is not shared), both split
 * by role (`noren`, `webview`, `shells`), and how many processes there are of each kind.
 */
export function sumMemory(tree) {
  const kinds = {};
  const roles = {
    noren: { workingSetMb: 0, privateWorkingSetMb: 0 },
    webview: { workingSetMb: 0, privateWorkingSetMb: 0 },
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
  return {
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
