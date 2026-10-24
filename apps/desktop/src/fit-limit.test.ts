import { describe, expect, it } from "vitest";
import { limitGrid } from "./fit-limit";

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
