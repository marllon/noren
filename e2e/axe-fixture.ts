import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// The axe-core check the accessibility tests share. It fails on a violation of any impact
// (critical, serious, moderate or minor), runs every rule axe has on by default, and leaves
// nothing out of the page: no disabled rule, no excluded element. A surface that cannot pass is
// fixed in its component, not here.

/** One line per node of every violation: impact, rule, help text, where and why. */
function describeViolations(
  violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"],
): string[] {
  return violations.map(
    (v) =>
      `${v.impact ?? "?"} ${v.id}: ${v.help}\n` +
      v.nodes.map((n) => `    ${n.target.join(" ")}\n    ${n.failureSummary ?? ""}`).join("\n"),
  );
}

/**
 * Runs axe on the page as it is now and fails with the nodes of every violation, of any impact.
 *
 * `sandboxedFrame` is for the one frame the app draws that no script can enter on purpose: the
 * sandboxed frame of a plugin panel, whose content is the plugin's. Axe cannot run inside it and
 * waits for it a minute by default, and the default mode hangs on it, so the page is analyzed in
 * the legacy mode with a short wait. No rule is changed and nothing is left out: the page around the
 * frame and the frame element itself (its title, its place) are checked as always; axe only reports
 * the content of the frame as "not tested" (the `frame-tested` rule, in `incomplete`).
 */
export async function expectNoAxeViolations(
  page: Page,
  surface: string,
  options: { sandboxedFrame?: boolean } = {},
): Promise<void> {
  // Axe reads the colors the page has right now: a fade or a slide that is still running (a list
  // that comes in, a space that changes) would be read half way. The animations that end are let to
  // end; the ones that never end (a pulse, a spinner) are left running.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const builder = new AxeBuilder({ page });
  if (options.sandboxedFrame === true) builder.setLegacyMode(true).options({ frameWaitTime: 2000 });
  const { violations } = await builder.analyze();
  expect(describeViolations(violations), `axe violations on ${surface}`).toEqual([]);
}
