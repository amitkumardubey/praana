import { describe, it, expect } from "bun:test";
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
