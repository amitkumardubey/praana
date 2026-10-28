import { describe, it, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { normalizeToolParameters } from "../src/turn.js";
import { createAllTools } from "../src/tools/index.js";
import type { EventLog } from "../src/event-log.js";
import type { StateGraph } from "../src/state-graph.js";

// The tool JSON Schema is what the model sees. A silent change here makes the
// model call tools wrongly, so these tests pin the exact shape.

describe("normalizeToolParameters", () => {
  it("emits draft-7 object schemas that reject unknown properties", () => {
    const schema = z.object({
      path: z.string().describe("File path"),
      limit: z.number().int().optional().describe("Max lines"),
      mode: z.enum(["a", "b"]),
      items: z.array(z.object({ name: z.string() })),
    });
    expect(normalizeToolParameters(schema)).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        limit: { type: "integer", description: "Max lines" },
        mode: { type: "string", enum: ["a", "b"] },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "mode", "items"],
      additionalProperties: false,
    });
  });

  it("adds no implicit safe-integer bounds to integers", () => {
    const json = normalizeToolParameters(z.object({ n: z.number().int() }));
    const n = (json.properties as Record<string, Record<string, unknown>>).n;
    expect(n).toEqual({ type: "integer" });
  });

  it("keeps explicit integer bounds", () => {
    const json = normalizeToolParameters(z.object({ n: z.number().int().min(1).max(50) }));
    const n = (json.properties as Record<string, Record<string, unknown>>).n;
    expect(n).toEqual({ type: "integer", minimum: 1, maximum: 50 });
  });

  it("strips the schema envelope keys", () => {
    const json = normalizeToolParameters(z.object({ a: z.string() }));
    expect(json.$schema).toBeUndefined();
    expect(json.$ref).toBeUndefined();
    expect(json.definitions).toBeUndefined();
    expect(json.$defs).toBeUndefined();
  });

  it("keeps defaults optional and records default values", () => {
    const json = normalizeToolParameters(z.object({ max: z.number().int().default(20) }));
    expect(json.required).toBeUndefined();
    const max = (json.properties as Record<string, Record<string, unknown>>).max;
    expect(max).toEqual({ type: "integer", default: 20 });
  });

  it("emits exclusiveMinimum for positive numbers", () => {
    const json = normalizeToolParameters(z.object({ n: z.number().positive() }));
    const n = (json.properties as Record<string, Record<string, unknown>>).n;
    expect(n).toEqual({ type: "number", exclusiveMinimum: 0 });
  });

  it("emits anyOf for unions without touching non-object branches", () => {
    const json = normalizeToolParameters(
      z.object({ glob: z.union([z.string(), z.array(z.string())]).optional() }),
    );
    const glob = (json.properties as Record<string, Record<string, unknown>>).glob;
    expect(glob).toEqual({ anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] });
  });

  it("does not close loose objects or records", () => {
    const json = normalizeToolParameters(
      z.object({
        open: z.looseObject({ a: z.string() }),
        map: z.record(z.string(), z.number()),
      }),
    );
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.open.additionalProperties).not.toBe(false);
    expect(props.map.additionalProperties).toEqual({ type: "number" });
  });

  it("falls back to an empty strict object for a non-zod schema", () => {
    expect(normalizeToolParameters(undefined)).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });
});

describe("registered tool parameter schemas", () => {
  for (const classicMode of [true, false]) {
    it(`every ${classicMode ? "classic" : "engine"} tool has a non-empty object schema`, () => {
      const tools = createAllTools({
        eventLog: {} as unknown as EventLog,
        stateGraph: {} as unknown as StateGraph,
        memoryStore: null,
        memoryEnabled: true,
        incognito: false,
        contextEngine: null,
        cwd: process.cwd(),
        skills: [],
        skillRuntime: null,
        classicMode,
      });
      const names = Object.keys(tools);
      expect(names.length).toBeGreaterThan(10);
      for (const name of names) {
        const schema = normalizeToolParameters((tools[name] as { parameters?: unknown }).parameters);
        expect(schema.type, `${name} type`).toBe("object");
        expect(typeof schema.properties, `${name} properties`).toBe("object");
        expect(schema.additionalProperties, `${name} additionalProperties`).toBe(false);
      }
    });
  }

  it("keeps the parameters of edit_file the model relies on", () => {
    const tools = createAllTools({
      eventLog: {} as unknown as EventLog,
      stateGraph: {} as unknown as StateGraph,
      memoryStore: null,
      memoryEnabled: false,
      incognito: false,
      contextEngine: null,
      cwd: process.cwd(),
      skills: [],
      skillRuntime: null,
      classicMode: true,
    });
    const schema = normalizeToolParameters((tools.edit_file as { parameters?: unknown }).parameters);
    const props = Object.keys(schema.properties as Record<string, unknown>);
    expect(props).toContain("path");
    expect(schema.required).toContain("path");
  });
});

describe("tool parameter schema baseline", () => {
  // tests/fixtures/tool-parameter-schemas.json holds the schemas of every registered tool as
  // produced before the zod 4 upgrade. The model sees these bytes, so any change must be
  // deliberate: rerun with PRAANA_WRITE_TOOL_SCHEMAS=1 to rewrite the baseline after review.
  const baselinePath = join(import.meta.dir, "fixtures", "tool-parameter-schemas.json");

  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value as object)
              .sort()
              .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
          )
        : value;

  it("matches the committed baseline for every classic and engine tool", () => {
    const actual: Record<string, unknown> = {};
    for (const classicMode of [true, false]) {
      const tools = createAllTools({
        eventLog: {} as unknown as EventLog,
        stateGraph: {} as unknown as StateGraph,
        memoryStore: null,
        memoryEnabled: true,
        incognito: false,
        contextEngine: null,
        cwd: join(import.meta.dir, ".."),
        skills: [],
        skillRuntime: null,
        classicMode,
      });
      for (const [name, def] of Object.entries(tools)) {
        actual[`${classicMode ? "classic" : "engine"}:${name}`] = normalizeToolParameters(
          (def as { parameters?: unknown }).parameters,
        );
      }
    }
    const serialized = JSON.stringify(stable(actual), null, 2) + "\n";
    if (process.env.PRAANA_WRITE_TOOL_SCHEMAS) writeFileSync(baselinePath, serialized);
    expect(serialized).toBe(readFileSync(baselinePath, "utf-8"));
  });
});
