/// <reference types="node" />
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DEEP_LINK_REGISTERED, configJsonSchema, parseConfigText } from "./index";

// `docs/config.schema.json` is what an editor reads to complete and check `config.jsonc`. It is
// generated from the zod schema in `config.ts`; this test fails when the two differ. To update it,
// run `pnpm --filter @noren/model config:schema` (which runs this file with NOREN_UPDATE_SCHEMA=1 and formats the result).

const SCHEMA_FILE = new URL("../../../docs/config.schema.json", import.meta.url);

describe("docs/config.schema.json", () => {
  if (process.env["NOREN_UPDATE_SCHEMA"] === "1") {
    it("is rewritten from the schema", () => {
      writeFileSync(SCHEMA_FILE, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
    });
    return;
  }

  it("is up to date with the schema in config.ts (run `pnpm --filter @noren/model config:schema` to update it)", () => {
    const onDisk: unknown = JSON.parse(readFileSync(SCHEMA_FILE, "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(configJsonSchema())));
  });

  it("forbids unknown settings and requires none", () => {
    const schema = configJsonSchema() as {
      additionalProperties?: boolean;
      required?: string[];
      properties: Record<string, { additionalProperties?: boolean; required?: string[] }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required ?? []).toEqual([]);
    for (const group of ["appearance", "notifications"]) {
      expect(schema.properties[group]?.additionalProperties).toBe(false);
      expect(schema.properties[group]?.required ?? []).toEqual([]);
    }
  });

  it("leaves the noren:// link unregistered unless the file says so", () => {
    const schema = configJsonSchema() as {
      properties: {
        deepLink: {
          additionalProperties: boolean;
          properties: { registered: { type: string; default: boolean } };
        };
      };
    };
    expect(DEFAULT_DEEP_LINK_REGISTERED).toBe(false);
    expect(schema.properties.deepLink.additionalProperties).toBe(false);
    expect(schema.properties.deepLink.properties.registered).toMatchObject({
      type: "boolean",
      default: false,
    });
    // A file that says nothing about the link leaves it unset, which the settings read as off.
    expect(parseConfigText("{}")).toEqual({ ok: true, config: {} });
    expect(parseConfigText('{ "deepLink": {} }')).toEqual({ ok: true, config: { deepLink: {} } });
    expect(parseConfigText('{ "deepLink": { "registered": true } }')).toEqual({
      ok: true,
      config: { deepLink: { registered: true } },
    });
    expect(parseConfigText('{ "deepLink": { "registered": "yes" } }').ok).toBe(false);
  });

  it("describes the sidebar position and its range of width", () => {
    const schema = configJsonSchema() as {
      properties: {
        appearance: {
          properties: {
            sidebar: {
              properties: {
                position: { enum: string[]; default: string };
                width: { minimum: number; maximum: number; type: string };
              };
            };
          };
        };
      };
    };
    const sidebar = schema.properties.appearance.properties.sidebar.properties;
    expect(sidebar.position.enum).toEqual(["left", "right"]);
    expect(sidebar.position.default).toBe("left");
    expect(sidebar.width).toMatchObject({ type: "integer", minimum: 180, maximum: 480 });
  });
});
