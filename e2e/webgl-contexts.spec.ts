import { expect, test } from "@playwright/test";
import { manyTabsState } from "./many-tabs-fixture";

// NOR-F11-01c: a start with 30 tabs mounts 30 terminals at once. The WebGL context of a tab out of
// sight is made in its turn (one every 40 ms), not in the mount, so the graphics process is not
// busy for a second with whatever the person does first. Every terminal still gets its context.

const TABS = 30;

interface GlWindow extends Window {
  __glTimes?: number[];
}

test("the WebGL contexts of 30 tabs are made one after another, and every tab gets its own", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      const times: number[] = [];
      (window as GlWindow).__glTimes = times;
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...rest: unknown[]
      ) {
        if (type === "webgl2") times.push(performance.now());
        return (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof original;
    },
    { key: "noren.web.state", value: manyTabsState(["Alpha", "Beta"], TABS / 2) },
  );
  await page.goto("/");
  await expect(page.locator(".xterm")).toHaveCount(TABS);

  const times = () => page.evaluate(() => (window as GlWindow).__glTimes ?? []);
  // Each of the 30 terminals asks for one context, in its turn.
  await expect.poll(async () => (await times()).length, { timeout: 20_000 }).toBe(TABS);
  const all = await times();
  const first = all[0] ?? 0;
  const last = all[all.length - 1] ?? 0;
  // 28 of them wait for their turn, 40 ms apart: made all in the mount, the span would be a few ms.
  expect(last - first).toBeGreaterThanOrEqual(1000);
});
