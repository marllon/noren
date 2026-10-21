import {
  BENCH_MODEL_CATALOG,
  BENCH_RAM_SHARE,
  BENCH_VRAM_SHARE,
  ollamaPullCommand,
  recommendedBenchModels,
} from "@noren/model";
import type {
  Backend,
  BenchCatalogModel,
  BenchHardware,
  BenchMemoryKind,
  BenchModelReason,
  BenchModelUse,
} from "@noren/model";

// What the "Recommended models" part of the AI settings shows, worked out from the memory of the
// computer: the list `recommendedBenchModels` chose (in its order), the install command of each model
// when `ollamaPullCommand` gives one, and the cases where there is no list. Pure: it reads nothing
// (the memory is an argument) and never runs a command; `readModelsView` is the one function that
// asks the backend.

/** One model of the list, with what the table says about it. */
export interface ModelsViewRow {
  /** Position on the list, from 1. */
  rank: number;
  /** The model as the Ollama library names it (`qwen3:8b`). */
  id: string;
  downloadBytes: number;
  minMemoryBytes: number;
  uses: readonly BenchModelUse[];
  license: string;
  reason: BenchModelReason;
  /** The budget minus what the model needs. */
  headroomBytes: number;
  /** The text `ollama pull <id>`, or `null` when `ollamaPullCommand` refuses the id (then no button). */
  command: string | null;
}

/** The part of a memory a model may take, as a whole percent (`60`, `90`). */
export function sharePercent(memory: BenchMemoryKind): number {
  const share = memory === "vram" ? BENCH_VRAM_SHARE : BENCH_RAM_SHARE;
  return Math.round((share.numerator * 100) / share.denominator);
}

export type ModelsView =
  /** No reading: the browser cannot ask, or the RAM could not be read. Nothing is chosen. */
  | { state: "unknown" }
  /** Reading the memory rejected. */
  | { state: "failed"; reason: string }
  /** A reading `recommendedBenchModels` refuses (it cannot come from `benchHardwareOf`, but is not trusted). */
  | { state: "invalid" }
  | {
      state: "ready";
      hardware: BenchHardware;
      /** The memory the list was chosen for. */
      memory: BenchMemoryKind;
      /** Whole bytes a model may take. */
      budgetBytes: number;
      rows: ModelsViewRow[];
      /** The memory the smallest model of the catalog needs; `null` for an empty catalog. */
      smallestNeedBytes: number | null;
    };

/** The view for a reading of the memory of the computer (`null` when it is not known). */
export function modelsViewOf(
  hardware: BenchHardware | null,
  catalog: readonly BenchCatalogModel[] = BENCH_MODEL_CATALOG,
): ModelsView {
  if (hardware === null) return { state: "unknown" };
  const recommendation = recommendedBenchModels(hardware, catalog);
  if (!recommendation.ok) return { state: "invalid" };
  const rows = recommendation.models.map(
    ({ rank, model, reason, headroomBytes }): ModelsViewRow => {
      const pull = ollamaPullCommand(model.id, catalog);
      return {
        rank,
        id: model.id,
        downloadBytes: model.downloadBytes,
        minMemoryBytes: model.minMemoryBytes,
        uses: model.uses,
        license: model.license,
        reason,
        headroomBytes,
        command: pull.ok ? pull.command : null,
      };
    },
  );
  return {
    state: "ready",
    hardware,
    memory: recommendation.memory,
    budgetBytes: recommendation.budgetBytes,
    rows,
    smallestNeedBytes:
      catalog.length === 0 ? null : Math.min(...catalog.map((model) => model.minMemoryBytes)),
  };
}

/** Reads the memory once and makes the view; a rejected read is the `failed` view, never a throw. */
export async function readModelsView(
  backend: Pick<Backend, "readHardware">,
  catalog: readonly BenchCatalogModel[] = BENCH_MODEL_CATALOG,
): Promise<ModelsView> {
  try {
    return modelsViewOf(await backend.readHardware(), catalog);
  } catch (error) {
    return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
