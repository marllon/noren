import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BENCH_MODEL_CATALOG,
  BENCH_MODEL_ID_PATTERN,
  BENCH_RAM_SHARE,
  BENCH_VRAM_SHARE,
  benchCatalogModelSchema,
  benchCatalogSchema,
  isBenchModelId,
  ollamaPullCommand,
  recommendedBenchModels,
  type BenchCatalogModel,
  type BenchRecommendation,
} from "./bench-models";

// The curated catalog, the choice by RAM or video memory and the install command (NOR-F16-04a).
// Pure functions: nothing here runs a command or reads the machine.

const GIB = 1024 * 1024 * 1024;

function model(overrides: Partial<BenchCatalogModel> = {}): BenchCatalogModel {
  return {
    id: "qwen3:8b",
    downloadBytes: 5_200_000_000,
    minMemoryBytes: 6 * GIB,
    uses: ["ask", "explain"],
    license: "Apache-2.0",
    ...overrides,
  };
}

/** The share of a memory, worked out with big integers so it does not share the code under test. */
function oracleShare(bytes: number, share: { numerator: number; denominator: number }): number {
  return Number((BigInt(bytes) * BigInt(share.numerator)) / BigInt(share.denominator));
}

function ids(result: BenchRecommendation): string[] {
  if (!result.ok) throw new Error("expected a recommendation");
  return result.models.map((entry) => entry.model.id);
}

/** The memory each recommended model needs, in the order of the list. */
function needed(result: BenchRecommendation): number[] {
  return result.ok ? result.models.map((entry) => entry.model.minMemoryBytes) : [];
}

describe("the catalog schema", () => {
  it("accepts the real catalog", () => {
    const parsed = benchCatalogSchema.safeParse(BENCH_MODEL_CATALOG);
    expect(parsed.success).toBe(true);
  });

  it("has only open permissive licenses and a way to use every model", () => {
    for (const entry of BENCH_MODEL_CATALOG) {
      expect(["Apache-2.0", "MIT"]).toContain(entry.license);
      expect(entry.uses.length).toBeGreaterThan(0);
      expect(entry.minMemoryBytes).toBeGreaterThanOrEqual(entry.downloadBytes);
    }
  });

  it("has every use covered by a model that runs on a small machine", () => {
    for (const use of ["ask", "explain", "command"] as const) {
      const small = BENCH_MODEL_CATALOG.filter(
        (entry) => entry.uses.includes(use) && entry.minMemoryBytes <= 4 * GIB,
      );
      expect(small.length, use).toBeGreaterThan(0);
    }
  });

  it("names no maker's product in the data a screen could print (ids are data, no label field)", () => {
    for (const entry of BENCH_MODEL_CATALOG) {
      expect(Object.keys(entry).sort()).toEqual(
        ["downloadBytes", "id", "license", "minMemoryBytes", "uses"].sort(),
      );
    }
  });

  it("has ids in the strict name:tag form, none twice", () => {
    const seen = new Set<string>();
    for (const entry of BENCH_MODEL_CATALOG) {
      expect(BENCH_MODEL_ID_PATTERN.test(entry.id), entry.id).toBe(true);
      expect(seen.has(entry.id), entry.id).toBe(false);
      seen.add(entry.id);
    }
  });

  it("refuses a duplicate id", () => {
    const parsed = benchCatalogSchema.safeParse([model(), model({ license: "MIT" })]);
    expect(parsed.success).toBe(false);
  });

  it("refuses an empty catalog", () => {
    expect(benchCatalogSchema.safeParse([]).success).toBe(false);
  });

  it.each<[string, unknown]>([
    ["no tag", model({ id: "qwen3" })],
    ["a space in the id", model({ id: "qwen3 :8b" })],
    ["upper case", model({ id: "Qwen3:8b" })],
    ["a license that is not open", model({ license: "Custom" as never })],
    ["no use", model({ uses: [] })],
    ["a use twice", model({ uses: ["ask", "ask"] })],
    ["an unknown use", model({ uses: ["chat" as never] })],
    ["a zero download", model({ downloadBytes: 0 })],
    ["a fractional download", model({ downloadBytes: 1.5 })],
    ["a negative memory", model({ minMemoryBytes: -1 })],
    ["a memory that is NaN", model({ minMemoryBytes: Number.NaN })],
    ["memory below the download", model({ downloadBytes: 6 * GIB, minMemoryBytes: 5 * GIB })],
    ["an extra field", { ...model(), label: "Fast" }],
    ["a missing license", { ...model(), license: undefined }],
    ["not an object", "qwen3:8b"],
  ])("refuses a model with %s", (_name, value) => {
    expect(benchCatalogModelSchema.safeParse(value).success).toBe(false);
  });

  it("accepts a valid model of its own", () => {
    expect(benchCatalogModelSchema.safeParse(model()).success).toBe(true);
  });
});

describe("recommendedBenchModels by RAM, no video memory", () => {
  const byRam = (gibs: number) => recommendedBenchModels({ ramBytes: gibs * GIB, vramBytes: null });

  it("gives a different and right list for 4, 8, 16 and 32 GiB", () => {
    const lists = [4, 8, 16, 32].map((gibs) => ids(byRam(gibs)));
    const [four = [], eight = [], sixteen = [], thirtyTwo = []] = lists;
    expect(four).toEqual(["qwen2.5-coder:1.5b"]);
    expect(eight).toEqual([
      "phi4-mini:latest",
      "qwen3:4b",
      "granite3.3:2b",
      "qwen3:1.7b",
      "qwen2.5-coder:1.5b",
    ]);
    expect(sixteen).toEqual([
      "qwen2.5-coder:14b",
      "granite3.3:8b",
      "qwen3:8b",
      "mistral:7b",
      "qwen2.5-coder:7b",
      "phi4-mini:latest",
      "qwen3:4b",
      "granite3.3:2b",
      "qwen3:1.7b",
      "qwen2.5-coder:1.5b",
    ]);
    expect(thirtyTwo[0]).toBe("qwen3:14b");
    expect(thirtyTwo).toHaveLength(BENCH_MODEL_CATALOG.length - 2);
    expect(new Set(lists.map((list) => list.join(","))).size).toBe(4);
    // Each bigger machine gets everything a smaller one got, and more.
    for (const [smaller, bigger] of [
      [four, eight],
      [eight, sixteen],
      [sixteen, thirtyTwo],
    ] as const) {
      expect(bigger.length).toBeGreaterThan(smaller.length);
      for (const id of smaller) expect(bigger).toContain(id);
    }
  });

  it("says it chose for the RAM, with 60% of it as the budget", () => {
    const result = byRam(16);
    if (!result.ok) throw new Error("expected a recommendation");
    expect(result.memory).toBe("ram");
    expect(result.budgetBytes).toBe(oracleShare(16 * GIB, BENCH_RAM_SHARE));
  });

  it("orders by the memory needed, largest first, and explains the first", () => {
    const result = byRam(32);
    if (!result.ok) throw new Error("expected a recommendation");
    expect(result.models[0]?.reason).toBe("largest-fit");
    expect(result.models[0]?.rank).toBe(1);
    expect(needed(result)).toEqual([...needed(result)].sort((a, b) => b - a));
    for (const [index, entry] of result.models.entries()) {
      expect(entry.rank).toBe(index + 1);
      if (index > 0) expect(entry.reason).toBe("fits");
      expect(entry.headroomBytes).toBe(result.budgetBytes - entry.model.minMemoryBytes);
    }
  });

  it("breaks a tie by id, so the order never depends on the order of the catalog", () => {
    const a = model({ id: "aa:1b", minMemoryBytes: GIB });
    const b = model({ id: "bb:1b", minMemoryBytes: GIB });
    const forward = recommendedBenchModels({ ramBytes: 4 * GIB, vramBytes: null }, [b, a]);
    const backward = recommendedBenchModels({ ramBytes: 4 * GIB, vramBytes: null }, [a, b]);
    expect(ids(forward)).toEqual(["aa:1b", "bb:1b"]);
    expect(ids(backward)).toEqual(["aa:1b", "bb:1b"]);
  });
});

describe("recommendedBenchModels by video memory", () => {
  const byVram = (vramGibs: number, ramGibs = 32) =>
    recommendedBenchModels({ ramBytes: ramGibs * GIB, vramBytes: vramGibs * GIB });

  it("gives a different and right list for 6, 12 and 24 GiB", () => {
    const six = ids(byVram(6));
    const twelve = ids(byVram(12));
    const twentyFour = ids(byVram(24));
    expect(six).toEqual([
      "phi4-mini:latest",
      "qwen3:4b",
      "granite3.3:2b",
      "qwen3:1.7b",
      "qwen2.5-coder:1.5b",
    ]);
    expect(twelve[0]).toBe("qwen3:14b");
    expect(twelve).toContain("qwen2.5-coder:14b");
    expect(twelve).not.toContain("qwen3:32b");
    expect(twentyFour.slice(0, 2)).toEqual(["qwen2.5-coder:32b", "qwen3:32b"]);
    expect(twentyFour).toHaveLength(BENCH_MODEL_CATALOG.length);
    expect(new Set([six.join(","), twelve.join(","), twentyFour.join(",")]).size).toBe(3);
  });

  it("uses the video memory, not the RAM, when it is known", () => {
    // 6 GiB of video memory next to 32 GiB of RAM: the list is the video memory's.
    const result = byVram(6, 32);
    if (!result.ok) throw new Error("expected a recommendation");
    expect(result.memory).toBe("vram");
    expect(result.budgetBytes).toBe(oracleShare(6 * GIB, BENCH_VRAM_SHARE));
    expect(ids(result)).not.toContain("qwen3:14b");
    // And the same RAM with no video memory known gives the bigger list.
    expect(ids(recommendedBenchModels({ ramBytes: 32 * GIB, vramBytes: null }))).toContain(
      "qwen3:14b",
    );
  });

  it("falls back to the RAM when no model fits the video memory", () => {
    const result = recommendedBenchModels({ ramBytes: 32 * GIB, vramBytes: 0 });
    if (!result.ok) throw new Error("expected a recommendation");
    expect(result.memory).toBe("ram");
    expect(result.models[0]?.model.id).toBe("qwen3:14b");
  });
});

describe("the edge of the memory a model needs", () => {
  // A model that needs exactly 6e9 bytes; 60% of 10e9 is exactly 6e9.
  const exact = model({ id: "edge:1b", downloadBytes: 1, minMemoryBytes: 6_000_000_000 });

  it("fits at exactly the budget and not one byte under it (RAM)", () => {
    const at = recommendedBenchModels({ ramBytes: 10_000_000_000, vramBytes: null }, [exact]);
    const under = recommendedBenchModels({ ramBytes: 9_999_999_999, vramBytes: null }, [exact]);
    expect(ids(at)).toEqual(["edge:1b"]);
    expect(at.ok && at.models[0]?.headroomBytes).toBe(0);
    expect(ids(under)).toEqual([]);
  });

  it("fits at exactly the budget and not one byte under it (video memory)", () => {
    const need = model({ id: "edge:2b", downloadBytes: 1, minMemoryBytes: 9_000_000_000 });
    const at = recommendedBenchModels({ ramBytes: 0, vramBytes: 10_000_000_000 }, [need]);
    const under = recommendedBenchModels({ ramBytes: 0, vramBytes: 9_999_999_999 }, [need]);
    expect(ids(at)).toEqual(["edge:2b"]);
    expect(ids(under)).toEqual([]);
  });

  it("does not step over 2^53 working out the budget", () => {
    const big = recommendedBenchModels({ ramBytes: Number.MAX_SAFE_INTEGER, vramBytes: null });
    if (!big.ok) throw new Error("expected a recommendation");
    expect(big.budgetBytes).toBe(oracleShare(Number.MAX_SAFE_INTEGER, BENCH_RAM_SHARE));
    expect(big.models).toHaveLength(BENCH_MODEL_CATALOG.length);
  });
});

describe("when no model fits", () => {
  it("is an empty list with the reason, not an error", () => {
    const result = recommendedBenchModels({ ramBytes: 2 * GIB, vramBytes: null });
    expect(result).toEqual({
      ok: true,
      memory: "ram",
      budgetBytes: oracleShare(2 * GIB, BENCH_RAM_SHARE),
      models: [],
      emptyReason: "no-model-fits",
    });
  });

  it("is empty for no RAM at all", () => {
    const result = recommendedBenchModels({ ramBytes: 0, vramBytes: null });
    expect(result.ok && result.models).toEqual([]);
    expect(result.ok && result.emptyReason).toBe("no-model-fits");
  });

  it("has no emptyReason when there is a list", () => {
    const result = recommendedBenchModels({ ramBytes: 16 * GIB, vramBytes: null });
    expect(result.ok && "emptyReason" in result).toBe(false);
  });
});

describe("hardware that is not valid", () => {
  it.each<[string, unknown]>([
    ["negative RAM", { ramBytes: -1, vramBytes: null }],
    ["NaN RAM", { ramBytes: Number.NaN, vramBytes: null }],
    ["infinite RAM", { ramBytes: Number.POSITIVE_INFINITY, vramBytes: null }],
    ["fractional RAM", { ramBytes: 1.5 * GIB + 0.5, vramBytes: null }],
    ["RAM beyond 2^53", { ramBytes: 2 ** 53, vramBytes: null }],
    ["RAM as text", { ramBytes: "16", vramBytes: null }],
    ["RAM missing", { vramBytes: null }],
    ["negative video memory", { ramBytes: 8 * GIB, vramBytes: -1 }],
    ["NaN video memory", { ramBytes: 8 * GIB, vramBytes: Number.NaN }],
    ["fractional video memory", { ramBytes: 8 * GIB, vramBytes: 0.5 }],
    ["video memory missing (undefined)", { ramBytes: 8 * GIB }],
    ["video memory as text", { ramBytes: 8 * GIB, vramBytes: "6" }],
    ["null", null],
    ["a number", 8],
  ])("refuses %s without throwing", (_name, hardware) => {
    expect(recommendedBenchModels(hardware as never)).toEqual({
      ok: false,
      reason: "invalid-hardware",
    });
  });
});

describe("properties of the choice", () => {
  const memory = fc.integer({ min: 0, max: 2 ** 40 });

  it("every model returned fits the memory it was chosen for", () => {
    fc.assert(
      fc.property(memory, fc.option(memory, { nil: null }), (ramBytes, vramBytes) => {
        const result = recommendedBenchModels({ ramBytes, vramBytes });
        if (!result.ok) return false;
        const source = result.memory === "vram" ? vramBytes : ramBytes;
        if (source === null) return false;
        const share = result.memory === "vram" ? BENCH_VRAM_SHARE : BENCH_RAM_SHARE;
        const budget = oracleShare(source, share);
        return (
          result.budgetBytes === budget &&
          result.models.every((entry) => entry.model.minMemoryBytes <= budget)
        );
      }),
    );
  });

  it("every model left out needs more than the budget", () => {
    fc.assert(
      fc.property(memory, (ramBytes) => {
        const result = recommendedBenchModels({ ramBytes, vramBytes: null });
        if (!result.ok) return false;
        const chosen = new Set(result.models.map((entry) => entry.model.id));
        return BENCH_MODEL_CATALOG.every(
          (entry) => chosen.has(entry.id) || entry.minMemoryBytes > result.budgetBytes,
        );
      }),
    );
  });

  it("more RAM never loses a model", () => {
    fc.assert(
      fc.property(memory, memory, (a, b) => {
        const [small, large] = a <= b ? [a, b] : [b, a];
        const few = ids(recommendedBenchModels({ ramBytes: small, vramBytes: null }));
        const many = ids(recommendedBenchModels({ ramBytes: large, vramBytes: null }));
        return few.every((id) => many.includes(id));
      }),
    );
  });

  it("the list is sorted by the memory needed, largest first, with ranks from 1", () => {
    fc.assert(
      fc.property(memory, fc.option(memory, { nil: null }), (ramBytes, vramBytes) => {
        const result = recommendedBenchModels({ ramBytes, vramBytes });
        if (!result.ok) return false;
        const sorted = [...needed(result)].sort((a, b) => b - a);
        return (
          result.models.every((entry, index) => entry.rank === index + 1) &&
          needed(result).every((bytes, index) => bytes === sorted[index])
        );
      }),
    );
  });

  it("never throws, whatever the numbers are", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.double({ noNaN: false }), fc.integer(), fc.constant(2 ** 53)),
        fc.oneof(fc.constant(null), fc.double({ noNaN: false }), fc.integer()),
        (ramBytes, vramBytes) => {
          const result = recommendedBenchModels({ ramBytes, vramBytes });
          return typeof result.ok === "boolean";
        },
      ),
    );
  });
});

describe("ollamaPullCommand", () => {
  it("gives the command for every model of the catalog", () => {
    for (const entry of BENCH_MODEL_CATALOG) {
      expect(ollamaPullCommand(entry.id)).toEqual({ ok: true, command: `ollama pull ${entry.id}` });
    }
  });

  it("accepts an id of a catalog it is given", () => {
    const own = model({ id: "tiny.model_x-1:3b-q4_0" });
    expect(ollamaPullCommand("tiny.model_x-1:3b-q4_0", [own])).toEqual({
      ok: true,
      command: "ollama pull tiny.model_x-1:3b-q4_0",
    });
  });

  it("refuses a well-formed id that is not in the catalog", () => {
    expect(ollamaPullCommand("qwen3:9999b")).toEqual({ ok: false, reason: "not-in-catalog" });
    expect(ollamaPullCommand("someone-else:7b")).toEqual({ ok: false, reason: "not-in-catalog" });
  });

  it.each<[string, unknown]>([
    ["a space", "qwen3:8b extra"],
    ["a leading space", " qwen3:8b"],
    ["a trailing space", "qwen3:8b "],
    ["a semicolon", "qwen3:8b;rm -rf /"],
    ["an ampersand", "qwen3:8b&calc"],
    ["a double ampersand", "qwen3:8b&&calc"],
    ["a pipe", "qwen3:8b|more"],
    ["a dollar", "qwen3:$HOME"],
    ["a dollar and parentheses", "qwen3:$(id)"],
    ["a backtick", "qwen3:`id`"],
    ["a double quote", 'qwen3:"8b"'],
    ["a single quote", "qwen3:'8b'"],
    ["a line break", "qwen3:8b\nrm"],
    ["a carriage return", "qwen3:8b\r"],
    ["a tab", "qwen3:8b\t"],
    ["two dots", "qwen3:8b..x"],
    ["two dots in the name", "qwen..3:8b"],
    ["a slash", "library/qwen3:8b"],
    ["a backslash", "qwen3:8b\\x"],
    ["a leading dash (an option)", "-qwen3:8b"],
    ["a dash after the colon", "qwen3:-8b"],
    ["a redirect", "qwen3:8b>out"],
    ["upper case", "QWEN3:8b"],
    ["no tag", "qwen3"],
    ["two colons", "qwen3:8b:x"],
    ["an empty tag", "qwen3:"],
    ["an empty text", ""],
    ["a non-ASCII letter", "qwen3:8bé"],
    ["a zero-width space", "qwen3:8b​"],
    ["a NUL", "qwen3:8b\u0000"],
    ["a text longer than the limit", `${"a".repeat(80)}:7b`],
    ["a number", 8],
    ["null", null],
    ["undefined", undefined],
    ["an object", { id: "qwen3:8b" }],
  ])("refuses an id with %s", (_name, id) => {
    const result = ollamaPullCommand(id);
    expect(result.ok).toBe(false);
  });

  it("calls the shape a bad id and the missing one not in the catalog", () => {
    expect(ollamaPullCommand("qwen3:8b;calc")).toEqual({ ok: false, reason: "bad-id" });
    expect(ollamaPullCommand(7)).toEqual({ ok: false, reason: "bad-id" });
  });

  it("only ever yields one word after `ollama pull`, whatever the text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (text) => {
        const result = ollamaPullCommand(text);
        if (!result.ok) return true;
        return (
          result.command === `ollama pull ${text}` &&
          /^ollama pull [a-z0-9._:-]+$/.test(result.command) &&
          isBenchModelId(text)
        );
      }),
      { numRuns: 500 },
    );
  });

  it("refuses a catalog id with a shell character put in it, even in a catalog of its own", () => {
    const evil = model({ id: "qwen3:8b;calc" });
    expect(ollamaPullCommand("qwen3:8b;calc", [evil])).toEqual({ ok: false, reason: "bad-id" });
  });
});
