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

/** Runs axe on the page as it is now and fails with the nodes of every violation, of any impact. */
export async function expectNoAxeViolations(page: Page, surface: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(describeViolations(violations), `axe violations on ${surface}`).toEqual([]);
}
