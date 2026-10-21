import { describe, expect, it } from "vitest";
import {
  BENCH_MODEL_CATALOG,
  FakeBackend,
  ollamaPullCommand,
  recommendedBenchModels,
} from "@noren/model";
import type { BenchCatalogModel, BenchHardware } from "@noren/model";
import { modelsViewOf, readModelsView, sharePercent } from "./models-view";
import type { ModelsView } from "./models-view";

// What the recommended models part of the AI settings shows: the list of `recommendedBenchModels`
// in its order, an install command only where `ollamaPullCommand` gives one, and the cases with no
// list (no reading, a rejected reading, nothing fits).

const GIB = 1024 ** 3;

function ready(view: ModelsView) {
  if (view.state !== "ready") throw new Error(`expected a list, got ${view.state}`);
  return view;
}

describe("modelsViewOf", () => {
  it("has no list for a computer whose memory is not known", () => {
    expect(modelsViewOf(null)).toEqual({ state: "unknown" });
  });

  it("lists, for 8 GiB of RAM and no video memory, the models of the RAM in the order of the choice", () => {
    const hardware: BenchHardware = { ramBytes: 8 * GIB, vramBytes: null };
    const view = ready(modelsViewOf(hardware));
    const chosen = recommendedBenchModels(hardware);
    expect(chosen.ok).toBe(true);
    expect(view.memory).toBe("ram");
    expect(view.rows.map((row) => row.id)).toEqual(
      chosen.ok ? chosen.models.map((entry) => entry.model.id) : [],
    );
    expect(view.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(view.rows[0]?.id).toBe("phi4-mini:latest");
    expect(view.rows[0]?.reason).toBe("largest-fit");
    expect(view.rows.slice(1).every((row) => row.reason === "fits")).toBe(true);
  });

  it("lists, for 24 GiB of video memory, another and longer list", () => {
    const view = ready(modelsViewOf({ ramBytes: 16 * GIB, vramBytes: 24 * GIB }));
    expect(view.memory).toBe("vram");
    expect(view.rows).toHaveLength(13);
    expect(view.rows[0]?.id).toBe("qwen2.5-coder:32b");
  });

  it("gives each row what the table shows and the install command", () => {
    const view = ready(modelsViewOf({ ramBytes: 8 * GIB, vramBytes: null }));
    for (const row of view.rows) {
      const model = BENCH_MODEL_CATALOG.find((entry) => entry.id === row.id);
      expect(model).toBeDefined();
      expect(row.downloadBytes).toBe(model?.downloadBytes);
      expect(row.minMemoryBytes).toBe(model?.minMemoryBytes);
      expect(row.uses).toEqual(model?.uses);
      expect(row.license).toBe(model?.license);
      expect(row.headroomBytes).toBe(view.budgetBytes - row.minMemoryBytes);
      expect(row.command).toBe(`ollama pull ${row.id}`);
    }
  });

  it("has an empty list, with the budget and the smallest need, when nothing fits", () => {
    const view = ready(modelsViewOf({ ramBytes: 1 * GIB, vramBytes: null }));
    expect(view.rows).toEqual([]);
    const smallest = Math.min(...BENCH_MODEL_CATALOG.map((model) => model.minMemoryBytes));
    expect(view.smallestNeedBytes).toBe(smallest);
    expect(view.budgetBytes).toBeLessThan(smallest);
  });

  it("gives no install command to a model whose id ollamaPullCommand refuses", () => {
    const first = BENCH_MODEL_CATALOG[0];
    if (first === undefined) throw new Error("the catalog is empty");
    const tampered: BenchCatalogModel[] = [
      { ...first, id: "evil; rm -rf /" },
      { ...first, id: "name:tag\nrm x" },
      { ...first, id: "ok:tag" },
    ];
    const view = ready(modelsViewOf({ ramBytes: 64 * GIB, vramBytes: null }, tampered));
    const byId = new Map(view.rows.map((row) => [row.id, row.command]));
    expect(byId.get("evil; rm -rf /")).toBeNull();
    expect(byId.get("name:tag\nrm x")).toBeNull();
    expect(byId.get("ok:tag")).toBe("ollama pull ok:tag");
  });

  it("refuses a reading that is not a memory without throwing", () => {
    const bad = { ramBytes: -1, vramBytes: null } as BenchHardware;
    expect(modelsViewOf(bad)).toEqual({ state: "invalid" });
    const fractional = { ramBytes: 1.5, vramBytes: null } as BenchHardware;
    expect(modelsViewOf(fractional)).toEqual({ state: "invalid" });
  });

  it("has a smallest need of null for an empty catalog", () => {
    const view = ready(modelsViewOf({ ramBytes: 8 * GIB, vramBytes: null }, []));
    expect(view.rows).toEqual([]);
    expect(view.smallestNeedBytes).toBeNull();
  });

  it("every row, on a sweep of computers, is a model that fits, in the order of the choice, with a safe command", () => {
    // fast-check is not a dependency of this app (it lives in @noren/model), so walk a grid instead.
    const rams = [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128].map((n) => n * GIB);
    const vrams = [null, 0, 2, 4, 6, 8, 12, 16, 24, 48, 96].map((n) => (n === null ? n : n * GIB));
    for (const ramBytes of rams) {
      for (const vramBytes of vrams) {
        const hardware = { ramBytes, vramBytes };
        const view = ready(modelsViewOf(hardware));
        const chosen = recommendedBenchModels(hardware);
        if (!chosen.ok) throw new Error("the reading is valid");
        expect(view.rows.map((row) => row.id)).toEqual(chosen.models.map((e) => e.model.id));
        for (const row of view.rows) {
          expect(row.minMemoryBytes).toBeLessThanOrEqual(view.budgetBytes);
          expect(row.command).toMatch(/^ollama pull [a-z0-9._:-]+$/);
          const pull = ollamaPullCommand(row.id);
          expect(pull.ok && pull.command).toBe(row.command);
        }
      }
    }
  });
});

describe("sharePercent", () => {
  it("is the share of each memory a model may take", () => {
    expect(sharePercent("ram")).toBe(60);
    expect(sharePercent("vram")).toBe(90);
  });
});

describe("readModelsView", () => {
  it("reads the memory once and makes the list", async () => {
    const backend = new FakeBackend({ hardware: { ramBytes: 8 * GIB, vramBytes: null } });
    const view = ready(await readModelsView(backend));
    expect(view.rows).toHaveLength(5);
    expect(backend.callsTo("readHardware")).toHaveLength(1);
  });

  it("is unknown for a backend that does not know the computer (the default)", async () => {
    expect(await readModelsView(new FakeBackend())).toEqual({ state: "unknown" });
  });

  it("is the failed view, with the reason, when reading rejects", async () => {
    const backend = {
      readHardware: () => Promise.reject(new Error("the command failed")),
    };
    expect(await readModelsView(backend)).toEqual({
      state: "failed",
      reason: "the command failed",
    });
    const text = { readHardware: () => Promise.reject("plain text") };
    expect(await readModelsView(text)).toEqual({ state: "failed", reason: "plain text" });
  });
});
