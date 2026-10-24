import { z } from "zod";

// The curated list of local models and the choice by memory (NOR-F16-04a): which models from the
// catalog fit in the RAM or the video memory of this computer, in what order, and the one command
// that installs a model. Pure: no DOM, no Tauri, no file and no network, and nothing here runs a
// command. `ollamaPullCommand` only gives the text; the screen of NOR-F16-04c shows it and puts it
// in a terminal only after the person confirms. Reading the memory of the machine is
// NOR-F16-04b; here the memory is an argument.

const GB = 1_000_000_000;
const GIB = 1024 * 1024 * 1024;

/** Decimal gigabytes, the unit the model library prints for a download ("5.2GB"), as whole bytes. */
function gb(value: number): number {
  return Math.round(value * GB);
}

/** Binary gigabytes (GiB) as whole bytes. */
function gib(value: number): number {
  return Math.round(value * GIB);
}

/** What a model is good for: the three AI functions of the settings. */
export const BENCH_MODEL_USES = ["ask", "explain", "command"] as const;
export type BenchModelUse = (typeof BENCH_MODEL_USES)[number];

/**
 * The licenses the catalog accepts: open weights under a permissive license. A model under custom
 * terms (a research-only license, an acceptable-use policy that binds the person who runs it) is
 * not in the catalog.
 */
export const BENCH_MODEL_LICENSES = ["Apache-2.0", "MIT"] as const;
export type BenchModelLicense = (typeof BENCH_MODEL_LICENSES)[number];

/** The longest model id the catalog accepts. */
export const MAX_BENCH_MODEL_ID = 64;

/**
 * A model id in the form `name:tag` of the Ollama library: lower-case letters and digits, with a
 * single `.`, `-` or `_` between two runs of them, on both sides of one `:`. Nothing a shell reads
 * as more than a word (a space, `;`, `&`, `|`, `$`, a backtick, a quote, a line break, `..`, a
 * slash, a leading `-`) can match, so an id is safe as one word of a command in PowerShell and in
 * bash.
 */
export const BENCH_MODEL_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*:[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Whether `id` is a strict `name:tag` model id (and short enough). */
export function isBenchModelId(id: unknown): id is string {
  return (
    typeof id === "string" && id.length <= MAX_BENCH_MODEL_ID && BENCH_MODEL_ID_PATTERN.test(id)
  );
}

const wholeBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** One model of the catalog. The id is data, not a label: the screen words it in its own text. */
export const benchCatalogModelSchema = z
  .strictObject({
    id: z.string().refine(isBenchModelId, { message: "not a name:tag model id" }),
    /** Size of the download, in bytes. */
    downloadBytes: wholeBytes,
    /** The memory the model needs to run: the weights, the context and the runtime buffers. */
    minMemoryBytes: wholeBytes,
    uses: z
      .array(z.enum(BENCH_MODEL_USES))
      .min(1)
      .refine((uses) => new Set(uses).size === uses.length, { message: "a use is listed twice" }),
    license: z.enum(BENCH_MODEL_LICENSES),
  })
  .refine((model) => model.minMemoryBytes >= model.downloadBytes, {
    message: "the memory needed is smaller than the download",
    path: ["minMemoryBytes"],
  });
export type BenchCatalogModel = z.infer<typeof benchCatalogModelSchema>;

/** A list of models: not empty, and no id twice. */
export const benchCatalogSchema = z
  .array(benchCatalogModelSchema)
  .min(1)
  .refine((models) => new Set(models.map((model) => model.id)).size === models.length, {
    message: "an id is listed twice",
  });

/**
 * The curated models, all of them open weights under Apache-2.0 or MIT.
 *
 * Sizes: the download is the size the Ollama library page prints for the tag, read on 2026-10-21
 * (`https://ollama.com/library/<name>/tags`), and the license is the one on the page of the tag.
 * `minMemoryBytes` is that download plus 1 GiB for the context (4 K tokens) and the runtime
 * buffers, rounded up to half a GiB. A model whose tag is under a research-only license
 * (`qwen2.5-coder:3b`) is left out on purpose.
 */
export const BENCH_MODEL_CATALOG: readonly BenchCatalogModel[] = [
  {
    id: "qwen2.5-coder:1.5b",
    downloadBytes: gb(0.986),
    minMemoryBytes: gib(2),
    uses: ["explain", "command"],
    license: "Apache-2.0",
  },
  {
    id: "qwen3:1.7b",
    downloadBytes: gb(1.4),
    minMemoryBytes: gib(2.5),
    uses: ["ask", "explain", "command"],
    license: "Apache-2.0",
  },
  {
    id: "granite3.3:2b",
    downloadBytes: gb(1.5),
    minMemoryBytes: gib(2.5),
    uses: ["ask", "explain"],
    license: "Apache-2.0",
  },
  {
    id: "qwen3:4b",
    downloadBytes: gb(2.5),
    minMemoryBytes: gib(3.5),
    uses: ["ask", "explain", "command"],
    license: "Apache-2.0",
  },
  {
    id: "phi4-mini:latest",
    downloadBytes: gb(2.5),
    minMemoryBytes: gib(3.5),
    uses: ["ask", "explain", "command"],
    license: "MIT",
  },
  {
    id: "mistral:7b",
    downloadBytes: gb(4.4),
    minMemoryBytes: gib(5.5),
    uses: ["ask", "explain"],
    license: "Apache-2.0",
  },
  {
    id: "qwen2.5-coder:7b",
    downloadBytes: gb(4.7),
    minMemoryBytes: gib(5.5),
    uses: ["explain", "command"],
    license: "Apache-2.0",
  },
  {
    id: "granite3.3:8b",
    downloadBytes: gb(4.9),
    minMemoryBytes: gib(6),
    uses: ["ask", "explain"],
    license: "Apache-2.0",
  },
  {
    id: "qwen3:8b",
    downloadBytes: gb(5.2),
    minMemoryBytes: gib(6),
    uses: ["ask", "explain", "command"],
    license: "Apache-2.0",
  },
  {
    id: "qwen2.5-coder:14b",
    downloadBytes: gb(9),
    minMemoryBytes: gib(9.5),
    uses: ["explain", "command"],
    license: "Apache-2.0",
  },
  {
    id: "qwen3:14b",
    downloadBytes: gb(9.3),
    minMemoryBytes: gib(10),
    uses: ["ask", "explain", "command"],
    license: "Apache-2.0",
  },
  {
    id: "qwen2.5-coder:32b",
    downloadBytes: gb(20),
    minMemoryBytes: gib(20),
    uses: ["explain", "command"],
    license: "Apache-2.0",
  },
  {
    id: "qwen3:32b",
    downloadBytes: gb(20),
    minMemoryBytes: gib(20),
    uses: ["ask", "explain", "command"],
    license: "Apache-2.0",
  },
];

/** The memory of the computer, in bytes. `vramBytes` is `null` when it is not known. */
export interface BenchHardware {
  ramBytes: number;
  vramBytes: number | null;
}

/**
 * The part of a memory a model may take, as a fraction `numerator / denominator`.
 *
 * - RAM, 60%: the system, the terminal, the browser and the rest of the person's programs need the
 *   other 40%, and a model that leaves the machine swapping is worse than a smaller one.
 * - Video memory, 90%: the model is the main user of it, but the screen and the driver keep some.
 *
 * The share of `minMemoryBytes` is compared with `<=` on whole bytes: a model whose need is exactly
 * the budget fits.
 */
export const BENCH_RAM_SHARE = { numerator: 6, denominator: 10 } as const;
export const BENCH_VRAM_SHARE = { numerator: 9, denominator: 10 } as const;

/** `floor(bytes * numerator / denominator)` in whole numbers, with no step over 2^53. */
function shareOf(bytes: number, share: { numerator: number; denominator: number }): number {
  const { numerator, denominator } = share;
  const whole = Math.floor(bytes / denominator);
  const rest = bytes - whole * denominator;
  return whole * numerator + Math.floor((rest * numerator) / denominator);
}

/** Which memory a list was chosen for. */
export type BenchMemoryKind = "vram" | "ram";

/** Why a model is where it is on the list. */
export type BenchModelReason =
  /** The most capable model that fits (the one that needs the most memory). */
  | "largest-fit"
  /** Fits, with room to spare, and a more capable one is above it. */
  | "fits";

export interface BenchRecommendedModel {
  /** Position on the list, from 1. */
  rank: number;
  model: BenchCatalogModel;
  reason: BenchModelReason;
  /** The budget minus what the model needs; 0 or more. */
  headroomBytes: number;
}

export type BenchRecommendation =
  | {
      ok: true;
      /** The memory the models were chosen for. */
      memory: BenchMemoryKind;
      /** Whole bytes the models may take (the share of that memory). */
      budgetBytes: number;
      models: BenchRecommendedModel[];
      /**
       * Why `models` is empty: `no-model-fits` when even the smallest model of the catalog needs
       * more than the budget. `undefined` when there is a list.
       */
      emptyReason?: "no-model-fits";
    }
  | { ok: false; reason: "invalid-hardware" };

/**
 * The memory of a computer from a reading that is not trusted (the answer of the Rust side, or of
 * a test double): the `BenchHardware` it holds, or `null` when there is none to hold. The RAM must
 * be a whole number of bytes above 0 that a JavaScript number holds exactly (a negative, fractional,
 * zero, `NaN`, infinite, past-2^53 or not-a-number RAM leaves nothing to recommend with, so the
 * whole reading is `null`); a VRAM that is not such a number, or that is missing, is `null`: an
 * unknown VRAM, which the recommendation answers by using the RAM. Never throws, and leaves out any
 * other field.
 */
export function benchHardwareOf(input: unknown): BenchHardware | null {
  if (typeof input !== "object" || input === null) return null;
  const { ramBytes, vramBytes } = input as Record<string, unknown>;
  const known = (value: unknown): value is number => isMemoryAmount(value) && value > 0;
  if (!known(ramBytes)) return null;
  return { ramBytes, vramBytes: known(vramBytes) ? vramBytes : null };
}

function isMemoryAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function rankModels(
  catalog: readonly BenchCatalogModel[],
  budgetBytes: number,
): BenchRecommendedModel[] {
  const fitting = catalog
    .filter((model) => model.minMemoryBytes <= budgetBytes)
    .sort(
      (a, b) => b.minMemoryBytes - a.minMemoryBytes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return fitting.map((model, index) => ({
    rank: index + 1,
    model,
    reason: index === 0 ? "largest-fit" : "fits",
    headroomBytes: budgetBytes - model.minMemoryBytes,
  }));
}

/**
 * The models of `catalog` that fit this computer, the most capable first.
 *
 * When the video memory is known (a number, 0 included) the models are chosen for it, because a
 * model that fits there runs on the GPU; the budget is 90% of it. When it is `null`, or when no
 * model fits the video memory (a small or shared GPU next to plenty of RAM), they are chosen for
 * the RAM, with a budget of 60% of it, and `memory` says `ram`. A model fits when its
 * `minMemoryBytes` is at most the budget. The order is the memory the model needs, largest first
 * (more weights is more capable), then the id.
 *
 * A memory that is negative, fractional, not finite, not a number or beyond 2^53 is refused as
 * `{ ok: false, reason: "invalid-hardware" }`; this never throws. A computer where nothing fits is
 * `ok: true` with an empty list and `emptyReason: "no-model-fits"`.
 */
export function recommendedBenchModels(
  hardware: BenchHardware,
  catalog: readonly BenchCatalogModel[] = BENCH_MODEL_CATALOG,
): BenchRecommendation {
  const input: unknown = hardware;
  if (typeof input !== "object" || input === null) return { ok: false, reason: "invalid-hardware" };
  const { ramBytes, vramBytes } = input as Record<string, unknown>;
  if (!isMemoryAmount(ramBytes)) return { ok: false, reason: "invalid-hardware" };
  if (vramBytes !== null && !isMemoryAmount(vramBytes)) {
    return { ok: false, reason: "invalid-hardware" };
  }

  if (vramBytes !== null) {
    const budgetBytes = shareOf(vramBytes, BENCH_VRAM_SHARE);
    const models = rankModels(catalog, budgetBytes);
    if (models.length > 0) return { ok: true, memory: "vram", budgetBytes, models };
  }
  const budgetBytes = shareOf(ramBytes, BENCH_RAM_SHARE);
  const models = rankModels(catalog, budgetBytes);
  if (models.length === 0) {
    return { ok: true, memory: "ram", budgetBytes, models, emptyReason: "no-model-fits" };
  }
  return { ok: true, memory: "ram", budgetBytes, models };
}

export type OllamaPullResult =
  { ok: true; command: string } | { ok: false; reason: "bad-id" | "not-in-catalog" };

/**
 * The command that installs a model: `ollama pull <id>`. The id has to be a strict `name:tag`
 * (`bad-id` for anything else: a space, `;`, `&`, `|`, `$`, a backtick, a quote, a line break,
 * `..`, a leading `-`, a text that is not a string) and has to be in `catalog` (`not-in-catalog`),
 * so the command is one program with one word that is not an option. It is the same text in
 * PowerShell and in bash.
 *
 * This only returns text. It never runs the command: the screen shows it and puts it in a terminal
 * only after the person confirms.
 */
export function ollamaPullCommand(
  id: unknown,
  catalog: readonly BenchCatalogModel[] = BENCH_MODEL_CATALOG,
): OllamaPullResult {
  if (!isBenchModelId(id)) return { ok: false, reason: "bad-id" };
  if (!catalog.some((model) => model.id === id)) return { ok: false, reason: "not-in-catalog" };
  return { ok: true, command: `ollama pull ${id}` };
}
