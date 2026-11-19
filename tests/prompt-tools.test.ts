import { describe, expect, test } from "bun:test";
import { buildToolGeneration, type ToolWireDef } from "../src/prompt/tools.js";

const read: ToolWireDef = {
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } }, required: ["path"] },
};
const edit: ToolWireDef = {
  name: "edit_file",
  description: "Edit a file",
  parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" } } },
};

describe("buildToolGeneration", () => {
  test("sorts tools by name and every schema key recursively", () => {
    const gen = buildToolGeneration([read, edit]);
    expect(gen.tools.map((t) => t.name)).toEqual(["edit_file", "read_file"]);
    const props = (gen.tools[1]!.parameters.properties as Record<string, unknown>);
    expect(Object.keys(props)).toEqual(["limit", "path"]);
    expect(Object.keys(gen.tools[1]!.parameters)).toEqual(["properties", "required", "type"]);
  });

  test("tool order and nested schema key order do not change the id", () => {
    const shuffled: ToolWireDef = {
      name: "read_file",
      description: "Read a file",
      parameters: { required: ["path"], properties: { limit: { type: "number" }, path: { type: "string" } }, type: "object" },
    };
    expect(buildToolGeneration([shuffled, edit]).id).toBe(buildToolGeneration([edit, read]).id);
  });

  test("array order inside a schema is significant", () => {
    const a = { ...read, parameters: { enum: ["a", "b"] } };
    const b = { ...read, parameters: { enum: ["b", "a"] } };
    expect(buildToolGeneration([a]).id).not.toBe(buildToolGeneration([b]).id);
  });

  test("a changed description, schema, name or capability choice changes the id", () => {
    const id = buildToolGeneration([read, edit], { reasoning: "high" }).id;
    expect(buildToolGeneration([{ ...read, description: "Read a file." }, edit], { reasoning: "high" }).id).not.toBe(id);
    expect(buildToolGeneration([{ ...read, parameters: { type: "object" } }, edit], { reasoning: "high" }).id).not.toBe(id);
    expect(buildToolGeneration([{ ...read, name: "read" }, edit], { reasoning: "high" }).id).not.toBe(id);
    expect(buildToolGeneration([read, edit], { reasoning: "low" }).id).not.toBe(id);
    expect(buildToolGeneration([read, edit]).id).not.toBe(id);
  });

  test("capability choice key order does not change the id", () => {
    expect(buildToolGeneration([read], { a: 1, b: { y: 1, x: 2 } }).id).toBe(buildToolGeneration([read], { b: { x: 2, y: 1 }, a: 1 }).id);
  });

  test("rejects duplicate tool names", () => {
    expect(() => buildToolGeneration([read, { ...read, description: "other" }])).toThrow(/Duplicate tool name: read_file/);
  });

  test("does not mutate its input and returns copies", () => {
    const tools = [read, edit];
    const snapshot = JSON.stringify(tools);
    const choices = { b: 1, a: 2 };
    const gen = buildToolGeneration(tools, choices);
    expect(JSON.stringify(tools)).toBe(snapshot);
    expect(tools.map((t) => t.name)).toEqual(["read_file", "edit_file"]);
    expect(Object.keys(choices)).toEqual(["b", "a"]);
    expect(gen.tools[1]!.parameters).not.toBe(read.parameters);
  });

  test("returns only wire fields even when given runtime fields", () => {
    const withRuntime = { ...read, execute: () => "x" } as unknown as ToolWireDef;
    const gen = buildToolGeneration([withRuntime]);
    expect(Object.keys(gen.tools[0]!)).toEqual(["name", "description", "parameters"]);
  });

  test("id is a stable sha256 hex digest", () => {
    const a = buildToolGeneration([read, edit]);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(buildToolGeneration([read, edit]).id).toBe(a.id);
    expect(buildToolGeneration([]).id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects values that are not JSON data", () => {
    expect(() => buildToolGeneration([{ ...read, parameters: { f: () => 1 } }])).toThrow(/JSON data/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => buildToolGeneration([{ ...read, parameters: cyclic }])).toThrow(/cycles/);
    expect(() => buildToolGeneration([read], { n: Number.NaN })).toThrow(/non-finite/);
  });

  test("omits undefined object values like JSON serialization does", () => {
    const a = buildToolGeneration([{ ...read, parameters: { type: "object", extra: undefined } }]);
    const b = buildToolGeneration([{ ...read, parameters: { type: "object" } }]);
    expect(a.id).toBe(b.id);
  });
});

describe("buildToolGeneration with external schemas", () => {
  test("keeps an own __proto__ key as data and does not touch prototypes", () => {
    const parsed = JSON.parse('{"type":"object","__proto__":{"polluted":true},"properties":{}}');
    const gen = buildToolGeneration([{ ...read, parameters: parsed }]);
    const params = gen.tools[0]!.parameters;
    expect(Object.keys(params)).toContain("__proto__");
    expect(JSON.stringify(params)).toContain('"__proto__":{"polluted":true}');
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect((params as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const without = buildToolGeneration([{ ...read, parameters: { type: "object", properties: {} } }]);
    expect(gen.id).not.toBe(without.id);
  });

  test("rejects non-plain objects instead of flattening them", () => {
    for (const bad of [new Date(0), new Map(), new Set(), /x/, new (class Foo { a = 1; })()]) {
      expect(() => buildToolGeneration([{ ...read, parameters: { nested: bad } }])).toThrow(/JSON data/);
      expect(() => buildToolGeneration([read], { bad })).toThrow(/JSON data/);
    }
  });

  test("requires plain-object parameters, capability choices and string fields", () => {
    expect(() => buildToolGeneration([{ ...read, parameters: [] as never }])).toThrow(/plain object/);
    expect(() => buildToolGeneration([{ ...read, parameters: null as never }])).toThrow(/plain object/);
    expect(() => buildToolGeneration([{ ...read, parameters: new Map() as never }])).toThrow(/plain object/);
    expect(() => buildToolGeneration([read], [] as never)).toThrow(/plain object/);
    expect(() => buildToolGeneration([{ ...read, description: 1 as never }])).toThrow(/strings/);
  });
});
