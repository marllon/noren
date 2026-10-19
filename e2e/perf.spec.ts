import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { seedSidebarState } from "./sidebar-fixture";
import { manyTabsState } from "./many-tabs-fixture";
import { report, summarize } from "./perf-stats";

// Measurements of NOR-F11-01a, taken in web mode (Chromium headless, `FakeBackend`): how fast the
// terminal takes a large output, whether the sidebar answers while one is coming in, and how long
// a change of space takes. The numbers go to `docs/PERF.md`, which also says how to run them alone
// (`node scripts/perf.mjs`). What is asserted here is only a floor wide enough to hold on a busy machine (the
// other specs run beside this one); the targets of the spec, section 11, are judged in the doc.

const REPS = 5;
const MB = 1024 * 1024;

interface Hook {
  lines(): string[];
  paneLines(paneId: string): string[];
  sendOutput(paneId: string, text: string): boolean;
  renderer(): "webgl" | "dom";
}
type HookWindow = Window & { __norenTest?: Hook };

/** The probe the page keeps: arms a stopwatch on one element and resolves when it changes. */
interface ProbeWindow extends HookWindow {
  __perfArm?: (el: Element, attr: string, wanted: string | null) => Promise<number>;
  __perfLongTasks?: number[];
  __perfSeq?: Promise<number>;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const tabList = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => tabList(page).getByRole("button", { name, exact: true });
const spaceButton = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Spaces", exact: true })
    .getByRole("button", { name, exact: true });

/** Waits for the first prompt of the shell of the active tab. */
async function ready(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        ((window as HookWindow).__norenTest?.lines() ?? []).some((l) => l.startsWith("fake$")),
      ),
    )
    .toBe(true);
}

/**
 * Installs the stopwatch in the page. `__perfArm(el, attr, wanted)` resolves with the milliseconds
 * from the press that started the gesture (the browser's own time stamp of the event, so a main
 * thread that was busy and kept the event waiting counts) to the next frame after `el` got
 * `wanted` in `attr` (any change of `attr` when `wanted` is null). It also keeps the length of
 * every long task (50 ms or more) of the main thread.
 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as ProbeWindow;
    w.__perfLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__perfLongTasks?.push(entry.duration);
    }).observe({ type: "longtask" });
    w.__perfArm = (el, attr, wanted) =>
      new Promise<number>((resolve) => {
        const initial = el.getAttribute(attr);
        let start = -1;
        const onDown = (event: Event) => {
          if (start < 0) start = event.timeStamp;
        };
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("click", onDown, true);
        const observer = new MutationObserver(() => {
          const now = el.getAttribute(attr);
          if (start < 0 || (wanted === null ? now === initial : now !== wanted)) return;
          observer.disconnect();
          document.removeEventListener("pointerdown", onDown, true);
          document.removeEventListener("click", onDown, true);
          requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start), 0));
        });
        observer.observe(el, { attributes: true, attributeFilter: [attr] });
      });
  });
}

/** Clicks `target` and answers how long the page took to show the result (see `installProbe`). */
async function clickAndTime(
  page: Page,
  target: Locator,
  attr: string,
  wanted: string | null,
): Promise<number> {
  const timed = target.evaluate(
    (el, [name, value]) => {
      const arm = (window as ProbeWindow).__perfArm;
      if (!arm) throw new Error("probe not installed");
      return arm(el, name ?? "", value);
    },
    [attr, wanted] as const,
  );
  // The page handles its messages in order: once this answers, the stopwatch is armed.
  await page.evaluate(() => true);
  await target.click();
  return timed;
}

const longTasks = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as ProbeWindow).__perfLongTasks ?? []);

/**
 * A page of its own, in a browser context of its own, so that no repetition starts with what the
 * one before kept (the saved state, the scrollback snapshots) and each one is a cold start.
 */
async function freshPage(
  browser: Browser,
  baseURL: string | undefined,
  state?: string,
): Promise<Page> {
  const page = await (await browser.newContext(baseURL === undefined ? {} : { baseURL })).newPage();
  if (state !== undefined) {
    await page.addInitScript(
      ({ key, value }) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      { key: "noren.web.state", value: state },
    );
  } else {
    await seedSidebarState(page);
  }
  await page.goto("/");
  await ready(page);
  await installProbe(page);
  return page;
}

test("throughput: a large seq in the FakeBackend shell, typed and drawn by xterm", async ({
  browser,
  baseURL,
}) => {
  const lastNumber = 1_000_000;
  // seq prints "1\r\n" .. "1000000\r\n"
  let bytes = 0;
  for (let n = 1, digits = 1, next = 10; n <= lastNumber; n++) {
    if (n === next) {
      digits++;
      next *= 10;
    }
    bytes += digits + 2;
  }

  const rates: number[] = [];
  const seconds: number[] = [];
  let renderer = "";
  for (let rep = 1; rep <= REPS; rep++) {
    const page = await freshPage(browser, baseURL);
    renderer = await page.evaluate(() => (window as HookWindow).__norenTest?.renderer() ?? "dom");
    await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
    await page.keyboard.type(`seq ${lastNumber}`);
    // Armed before Enter: the stopwatch starts at the key press and ends when the prompt is back.
    await page.evaluate(
      ([last]) => {
        const w = window as ProbeWindow;
        w.__perfSeq = new Promise<number>((resolve) => {
          const hook = (window as HookWindow).__norenTest;
          let t0 = -1;
          document.addEventListener(
            "keydown",
            (event) => {
              if (event.key === "Enter" && t0 < 0) {
                t0 = performance.now();
                const poll = () => {
                  const rows = (hook?.lines() ?? [])
                    .map((l) => l.trimEnd())
                    .filter((l) => l !== "");
                  if (rows[rows.length - 1] === "fake$" && rows[rows.length - 2] === String(last)) {
                    resolve(performance.now() - t0);
                  } else {
                    setTimeout(poll, 25);
                  }
                };
                poll();
              }
            },
            true,
          );
        });
      },
      [lastNumber] as const,
    );
    await page.keyboard.press("Enter");
    const ms = await page.evaluate(() => (window as ProbeWindow).__perfSeq ?? Promise.resolve(-1));
    seconds.push(ms / 1000);
    rates.push(bytes / MB / (ms / 1000));
    await page.context().close();
  }
  report("fake-seq-throughput", {
    command: `seq ${lastNumber}`,
    bytes,
    renderer,
    chromium: browser.version(),
    reps: REPS,
    seconds: summarize(seconds),
    mbPerSecond: summarize(rates),
  });
  // A floor, not a target: this only fails if the terminal stops taking the output.
  expect(Math.min(...rates)).toBeGreaterThan(0.5);
});

/** Feeds `total` bytes of numbered lines to a pane, one chunk every `intervalMs`, then a marker. */
async function startFeed(
  page: Page,
  options: { paneId: string; total: number; chunk: number; intervalMs: number; marker: string },
): Promise<void> {
  await page.evaluate((o) => {
    const hook = (window as HookWindow).__norenTest;
    if (!hook) throw new Error("no test hook");
    let text = "";
    for (let n = 1; text.length < o.chunk; n++) text += `${n * 7919}\r\n`;
    const perf = window as unknown as Record<string, unknown>;
    perf["__perfFeed"] = { done: false, feedMs: -1, drainMs: -1, sent: 0, found: false };
    const state = perf["__perfFeed"] as {
      done: boolean;
      feedMs: number;
      drainMs: number;
      sent: number;
      found: boolean;
    };
    const t0 = performance.now();
    const drain = () => {
      const deadline = performance.now() + 120_000;
      const poll = () => {
        const tail = hook.paneLines(o.paneId).slice(-8);
        if (tail.some((l) => l.includes(o.marker))) {
          state.drainMs = performance.now() - t0;
          state.found = true;
          state.done = true;
        } else if (performance.now() > deadline) {
          state.drainMs = performance.now() - t0;
          state.done = true;
        } else {
          setTimeout(poll, 50);
        }
      };
      poll();
    };
    const tick = () => {
      if (state.sent >= o.total) {
        state.feedMs = performance.now() - t0;
        hook.sendOutput(o.paneId, `\r\n${o.marker}\r\n`);
        drain();
        return;
      }
      hook.sendOutput(o.paneId, text);
      state.sent += text.length;
      setTimeout(tick, o.intervalMs);
    };
    tick();
  }, options);
}

interface FeedResult {
  done: boolean;
  feedMs: number;
  drainMs: number;
  sent: number;
  found: boolean;
}
const feedState = (page: Page): Promise<FeedResult> =>
  page.evaluate(() => (window as unknown as { __perfFeed: FeedResult }).__perfFeed);

test("sidebar: answers a click within a few frames while 50 MB of output comes in", async ({
  browser,
  baseURL,
}) => {
  const total = 50 * MB;
  const idleTab: number[] = [];
  const idleGroup: number[] = [];
  const loadedTab: number[] = [];
  const loadedGroup: number[] = [];
  const drainRates: number[] = [];
  const feedRates: number[] = [];
  const worstTasks: number[] = [];
  const lostMarkers: number[] = [];

  for (let rep = 1; rep <= REPS; rep++) {
    const page = await freshPage(browser, baseURL);
    const work = tabList(page).getByRole("button", { name: "Work", exact: true });
    // The same two gestures with nothing coming in: the noise the loaded ones are read against.
    for (let i = 0; i < 4; i++) {
      idleGroup.push(await clickAndTime(page, work, "data-nr-state", null));
      idleGroup.push(await clickAndTime(page, work, "data-nr-state", null));
      idleTab.push(await clickAndTime(page, tab(page, "build"), "data-nr-state", "active"));
      idleTab.push(await clickAndTime(page, tab(page, "api"), "data-nr-state", "active"));
    }
    await page.evaluate(() => {
      (window as ProbeWindow).__perfLongTasks = [];
    });

    // The output goes to the pane of the tab "api", which is the one on screen.
    await startFeed(page, {
      paneId: "p2",
      total,
      chunk: 64 * 1024,
      intervalMs: 4,
      marker: "NOREN-PERF-END",
    });
    let samples = 0;
    while (!(await feedState(page)).done && samples < 400) {
      loadedGroup.push(await clickAndTime(page, work, "data-nr-state", null));
      loadedGroup.push(await clickAndTime(page, work, "data-nr-state", null));
      loadedTab.push(await clickAndTime(page, tab(page, "build"), "data-nr-state", "active"));
      loadedTab.push(await clickAndTime(page, tab(page, "api"), "data-nr-state", "active"));
      samples += 4;
    }
    await expect.poll(async () => (await feedState(page)).done, { timeout: 150_000 }).toBe(true);
    const feed = await feedState(page);
    lostMarkers.push(feed.found ? 0 : 1);
    feedRates.push(feed.sent / MB / (feed.feedMs / 1000));
    drainRates.push(feed.sent / MB / (feed.drainMs / 1000));
    worstTasks.push(Math.max(0, ...(await longTasks(page))));
    await page.context().close();
  }

  report("sidebar-under-load", {
    outputMb: total / MB,
    feed: "64 KB every 4 ms (about 16 MB/s at most) into the visible terminal",
    reps: REPS,
    idleTabSwitchMs: summarize(idleTab),
    idleGroupToggleMs: summarize(idleGroup),
    loadedTabSwitchMs: summarize(loadedTab),
    loadedGroupToggleMs: summarize(loadedGroup),
    feedMbPerSecond: summarize(feedRates),
    drainMbPerSecond: summarize(drainRates),
    longestMainThreadTaskMs: summarize(worstTasks),
    repsWithoutEndMarker: lostMarkers.reduce((a, b) => a + b, 0),
  });
  // Floors for a busy machine; the target (100 ms) is judged in docs/PERF.md.
  expect(loadedTab.length).toBeGreaterThanOrEqual(REPS * 4);
  expect(summarize(loadedTab).median).toBeLessThan(1000);
  expect(summarize(loadedGroup).median).toBeLessThan(1000);
});

test("space: changing to another space with 30 tabs open takes a few frames", async ({
  browser,
  baseURL,
}) => {
  const perRep: number[] = [];
  const all: number[] = [];
  const cold: number[] = [];
  const mounted: number[] = [];
  for (let rep = 1; rep <= REPS; rep++) {
    const page = await freshPage(browser, baseURL, manyTabsState(["Alpha", "Beta"], 15));
    mounted.push(await page.locator(".xterm").count());
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      samples.push(
        await clickAndTime(page, spaceButton(page, "Beta"), "aria-current", "true"),
        await clickAndTime(page, spaceButton(page, "Alpha"), "aria-current", "true"),
      );
    }
    // The first switch of a page is the one that draws the other space for the first time.
    cold.push(samples[0] ?? Number.NaN);
    all.push(...samples.slice(1));
    perRep.push(summarize(samples.slice(1)).median);
    await page.context().close();
  }
  report("space-switch", {
    spaces: 2,
    tabsOpen: 30,
    xtermElementsInPage: summarize(mounted),
    reps: REPS,
    samplesPerRep: 12,
    repMedianOfLaterSwitchesMs: summarize(perRep),
    firstSwitchMs: summarize(cold),
    laterSwitchesMs: summarize(all),
  });
  expect(summarize(all).median).toBeLessThan(1000);
});
