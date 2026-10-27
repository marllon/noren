import { describe, expect, it } from "vitest";
import { limitGrid, planFit } from "./fit-limit";
import type { FitConditions, Grid } from "./fit-limit";

const CELL = { width: 8, height: 16 };
const WINDOW = { width: 1280, height: 720 };

describe("limitGrid", () => {
  it("leaves a grid that fits the window as it is", () => {
    expect(limitGrid({ cols: 120, rows: 30 }, CELL, WINDOW)).toEqual({ cols: 120, rows: 30 });
  });

  it("leaves a grid as large as the window as it is", () => {
    expect(limitGrid({ cols: 160, rows: 45 }, CELL, WINDOW)).toEqual({ cols: 160, rows: 45 });
  });

  it("cuts the rows and the columns to what the window holds", () => {
    expect(limitGrid({ cols: 160, rows: 46 }, CELL, WINDOW)).toEqual({ cols: 160, rows: 45 });
    expect(limitGrid({ cols: 161, rows: 45 }, CELL, WINDOW)).toEqual({ cols: 160, rows: 45 });
    // A host that took the size of the terminal in it: 60 753 rows asked for.
    expect(limitGrid({ cols: 156, rows: 60_753 }, CELL, WINDOW)).toEqual({ cols: 156, rows: 45 });
  });

  it("counts whole cells only, so a terminal is never taller than the window", () => {
    const grid = limitGrid({ cols: 1000, rows: 1000 }, { width: 9, height: 17 }, WINDOW);
    expect(grid).toEqual({ cols: 142, rows: 42 });
    expect(grid.rows * 17).toBeLessThanOrEqual(WINDOW.height);
    expect(grid.cols * 9).toBeLessThanOrEqual(WINDOW.width);
  });

  it("keeps the fewest cells a terminal has, whatever the window", () => {
    expect(limitGrid({ cols: 80, rows: 24 }, CELL, { width: 4, height: 4 })).toEqual({
      cols: 2,
      rows: 1,
    });
  });

  it("cuts nothing when the size of a cell or of the window is not known", () => {
    expect(limitGrid({ cols: 80, rows: 5000 }, { width: 0, height: 0 }, WINDOW)).toEqual({
      cols: 80,
      rows: 5000,
    });
    expect(limitGrid({ cols: 80, rows: 5000 }, CELL, { width: 0, height: 0 })).toEqual({
      cols: 80,
      rows: 5000,
    });
  });

  it("is the fixed point of a box that takes the size of what is in it", () => {
    // Each fit asks for twice the rows the terminal has (two canvases in the flow): without the limit it
    // never stops, with it the second answer is the first.
    let grid = { cols: 100, rows: 38 };
    const seen: number[] = [];
    for (let step = 0; step < 12; step++) {
      grid = limitGrid({ cols: grid.cols, rows: grid.rows * 2 }, CELL, WINDOW);
      seen.push(grid.rows);
    }
    expect(seen.slice(1)).toEqual(new Array<number>(11).fill(45));
  });
});

describe("planFit", () => {
  const SHOWN: FitConditions = {
    visible: true,
    documentHidden: false,
    host: { width: 1000, height: 640 },
    cell: CELL,
    area: WINDOW,
  };
  const PROPOSED = { cols: 120, rows: 40 };

  it("gives the grid that fits while the view is shown and the host has room", () => {
    expect(planFit(PROPOSED, SHOWN)).toEqual({ cols: 120, rows: 40 });
  });

  it("cuts the grid to the window, as limitGrid does", () => {
    expect(planFit({ cols: 400, rows: 400 }, SHOWN)).toEqual({ cols: 160, rows: 45 });
  });

  it("changes nothing when the host has no width or no height", () => {
    // What the fit addon proposes for a host with no room is its own minimum, 2 columns.
    const folded = { cols: 2, rows: 40 };
    expect(planFit(folded, { ...SHOWN, host: { width: 0, height: 640 } })).toBeUndefined();
    expect(planFit(PROPOSED, { ...SHOWN, host: { width: 1000, height: 0 } })).toBeUndefined();
    expect(planFit(folded, { ...SHOWN, host: { width: 0, height: 0 } })).toBeUndefined();
  });

  it("changes nothing when the host is 10 pixels wide", () => {
    const sliver = { cols: 2, rows: 40 };
    expect(planFit(sliver, { ...SHOWN, host: { width: 10, height: 640 } })).toBeUndefined();
  });

  it("changes nothing while the page is hidden, whatever the host says", () => {
    expect(planFit(PROPOSED, { ...SHOWN, documentHidden: true })).toBeUndefined();
  });

  it("changes nothing while the view is not visible", () => {
    expect(planFit(PROPOSED, { ...SHOWN, visible: false })).toBeUndefined();
  });

  it("changes nothing when the addon proposes nothing or a size that is not a number", () => {
    expect(planFit(undefined, SHOWN)).toBeUndefined();
    expect(planFit({ cols: Number.NaN, rows: 40 }, SHOWN)).toBeUndefined();
    expect(planFit({ cols: 80, rows: Number.POSITIVE_INFINITY }, SHOWN)).toBeUndefined();
  });

  it("keeps a terminal of exactly the useful minimum and drops one cell below it", () => {
    expect(planFit({ cols: 20, rows: 3 }, SHOWN)).toEqual({ cols: 20, rows: 3 });
    expect(planFit({ cols: 19, rows: 40 }, SHOWN)).toBeUndefined();
    expect(planFit({ cols: 120, rows: 2 }, SHOWN)).toBeUndefined();
  });

  it("changes nothing when the window itself cuts the grid below the useful minimum", () => {
    expect(planFit(PROPOSED, { ...SHOWN, area: { width: 100, height: 720 } })).toBeUndefined();
    expect(planFit(PROPOSED, { ...SHOWN, area: { width: 1280, height: 30 } })).toBeUndefined();
  });

  it("fits once with the real size when the view comes back", () => {
    // What the terminal does with each answer: a size is applied only when the answer is a grid and
    // differs from the one the terminal has, and only then does the session hear of it.
    let terminal = { cols: 120, rows: 40 };
    const sent: Grid[] = [];
    const fitWith = (proposed: Grid, conditions: FitConditions) => {
      const next = planFit(proposed, conditions);
      if (next === undefined) return;
      if (next.cols === terminal.cols && next.rows === terminal.rows) return;
      terminal = next;
      sent.push(next);
    };
    const folded = { cols: 2, rows: 40 };
    fitWith(folded, { ...SHOWN, host: { width: 0, height: 640 } });
    fitWith(folded, { ...SHOWN, host: { width: 10, height: 640 } });
    fitWith(
      { cols: 2, rows: 1 },
      { ...SHOWN, documentHidden: true, host: { width: 0, height: 0 } },
    );
    fitWith({ cols: 90, rows: 30 }, { ...SHOWN, visible: false });
    expect(sent).toEqual([]);
    expect(terminal).toEqual({ cols: 120, rows: 40 });
    // The view is shown again, the page is shown again, the window is back: the observers fire in a
    // row and the size is applied once, the real one.
    fitWith({ cols: 90, rows: 30 }, SHOWN);
    fitWith({ cols: 90, rows: 30 }, SHOWN);
    fitWith({ cols: 90, rows: 30 }, SHOWN);
    expect(sent).toEqual([{ cols: 90, rows: 30 }]);
  });

  it("never gives the session fewer than 20 columns or 3 rows, whatever the host does", () => {
    let terminal = { cols: 120, rows: 40 };
    const sent: Grid[] = [];
    for (const visible of [true, false]) {
      for (const documentHidden of [false, true]) {
        for (const width of [0, 10, 100, 160, 168, 400, 1000]) {
          for (const height of [0, 20, 40, 48, 640]) {
            // The addon's answer for a host of that size: whole cells, never below 2 by 1.
            const proposed = {
              cols: Math.max(2, Math.floor(width / CELL.width)),
              rows: Math.max(1, Math.floor(height / CELL.height)),
            };
            const next = planFit(proposed, {
              visible,
              documentHidden,
              host: { width, height },
              cell: CELL,
              area: WINDOW,
            });
            if (next === undefined) continue;
            if (next.cols === terminal.cols && next.rows === terminal.rows) continue;
            terminal = next;
            sent.push(next);
          }
        }
      }
    }
    expect(sent.length).toBeGreaterThan(0);
    for (const grid of sent) {
      expect(grid.cols).toBeGreaterThanOrEqual(20);
      expect(grid.rows).toBeGreaterThanOrEqual(3);
    }
  });

  it("stops a pane made narrow on purpose at the last size of 20 columns or more", () => {
    let terminal = { cols: 80, rows: 40 };
    const sent: Grid[] = [];
    // A split dragged narrower, one step of 8 pixels at a time.
    for (let width = 640; width >= 8; width -= 8) {
      const next = planFit(
        { cols: Math.max(2, Math.floor(width / CELL.width)), rows: 40 },
        { ...SHOWN, host: { width, height: 640 } },
      );
      if (next === undefined || next.cols === terminal.cols) continue;
      terminal = next;
      sent.push(next);
    }
    expect(sent.at(0)).toEqual({ cols: 79, rows: 40 });
    expect(sent.at(-1)).toEqual({ cols: 20, rows: 40 });
    expect(sent.every((grid) => grid.cols >= 20)).toBe(true);
    expect(terminal.cols).toBe(20);
  });
});
