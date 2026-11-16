import { describe, expect, it } from "bun:test";
import { GoogleDriver, toGoogleFunctionSchema } from "../src/llm/drivers/google.js";
import type { StreamRequest, ToolDefinition } from "../src/llm/types.js";
import { normalizeToolParameters } from "../src/turn.js";
import { createAllTools } from "../src/tools/index.js";
import type { EventLog } from "../src/event-log.js";
import type { StateGraph } from "../src/state-graph.js";

/**
 * Google function declarations accept a JSON Schema subset: `exclusiveMinimum`
 * / `exclusiveMaximum` (emitted by Zod `.positive()` / `.negative()` paths via
 * normalizeToolParameters) are rejected with HTTP 400. `toGoogleFunctionSchema`
 * converts the canonical tool schemas to the accepted subset without touching
 * the shared originals.
 */

describe("toGoogleFunctionSchema", () => {
  it("converts integer exclusiveMinimum to minimum n+1", () => {
    expect(toGoogleFunctionSchema({ type: "integer", exclusiveMinimum: 0 })).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(toGoogleFunctionSchema({ type: "integer", exclusiveMinimum: 5 })).toEqual({
      type: "integer",
      minimum: 6,
    });
  });

  it("drops exclusiveMinimum on non-integer types", () => {
    expect(toGoogleFunctionSchema({ type: "number", exclusiveMinimum: 0 })).toEqual({
      type: "number",
    });
    expect(toGoogleFunctionSchema({ type: "string", exclusiveMinimum: 0 })).toEqual({
      type: "string",
    });
  });

  it("converts integer exclusiveMaximum to maximum n-1", () => {
    expect(toGoogleFunctionSchema({ type: "integer", exclusiveMaximum: 100 })).toEqual({
      type: "integer",
      maximum: 99,
    });
  });

  it("drops exclusiveMaximum on non-integer types", () => {
    expect(toGoogleFunctionSchema({ type: "number", exclusiveMaximum: 42 })).toEqual({
      type: "number",
    });
  });

  it("applies fractional exclusive bounds with floor/ceil", () => {
    expect(toGoogleFunctionSchema({ type: "integer", exclusiveMinimum: 0.5 })).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(toGoogleFunctionSchema({ type: "integer", exclusiveMinimum: -0.5 })).toEqual({
      type: "integer",
      minimum: 0,
    });
    expect(toGoogleFunctionSchema({ type: "integer", exclusiveMaximum: 10.5 })).toEqual({
      type: "integer",
      maximum: 10,
    });
    expect(toGoogleFunctionSchema({ type: "integer", exclusiveMaximum: 10.2 })).toEqual({
      type: "integer",
      maximum: 10,
    });
    expect(toGoogleFunctionSchema({ type: "integer", exclusiveMaximum: 0.5 })).toEqual({
      type: "integer",
      maximum: 0,
    });
  });

  it("keeps a stricter existing minimum/maximum when converting", () => {
    // Stricter existing minimum (5 > 1) wins.
    expect(
      toGoogleFunctionSchema({ type: "integer", minimum: 5, exclusiveMinimum: 0 }),
    ).toEqual({ type: "integer", minimum: 5 });
    // Looser existing minimum loses to the converted bound.
    expect(
      toGoogleFunctionSchema({ type: "integer", minimum: -1, exclusiveMinimum: 0 }),
    ).toEqual({ type: "integer", minimum: 1 });
    // Stricter existing maximum (50 < 99) wins.
    expect(
      toGoogleFunctionSchema({ type: "integer", maximum: 50, exclusiveMaximum: 100 }),
    ).toEqual({ type: "integer", maximum: 50 });
    // Looser existing maximum loses to the converted bound.
    expect(
      toGoogleFunctionSchema({ type: "integer", maximum: 200, exclusiveMaximum: 100 }),
    ).toEqual({ type: "integer", maximum: 99 });
    // Fractional converted bounds still lose to stricter existing bounds.
    expect(
      toGoogleFunctionSchema({ type: "integer", minimum: 2, exclusiveMinimum: 0.5 }),
    ).toEqual({ type: "integer", minimum: 2 });
    expect(
      toGoogleFunctionSchema({ type: "integer", maximum: 5, exclusiveMaximum: 10.5 }),
    ).toEqual({ type: "integer", maximum: 5 });
  });

  it("treats type arrays containing integer (without number) as integer", () => {
    expect(
      toGoogleFunctionSchema({ type: ["integer", "null"], exclusiveMinimum: 0 }),
    ).toEqual({ type: ["integer", "null"], minimum: 1 });
    expect(
      toGoogleFunctionSchema({ type: ["integer", "null"], exclusiveMaximum: 10 }),
    ).toEqual({ type: ["integer", "null"], maximum: 9 });
    expect(
      toGoogleFunctionSchema({ type: ["string", "integer"], exclusiveMinimum: 0 }),
    ).toEqual({ type: ["string", "integer"], minimum: 1 });
    // A type array that also admits numbers is not an integer schema.
    expect(
      toGoogleFunctionSchema({ type: ["number", "null"], exclusiveMinimum: 0 }),
    ).toEqual({ type: ["number", "null"] });
    expect(
      toGoogleFunctionSchema({ type: ["integer", "number"], exclusiveMinimum: 0 }),
    ).toEqual({ type: ["integer", "number"] });
  });

  it("recurses into items (single schema and tuple arrays)", () => {
    expect(
      toGoogleFunctionSchema({
        type: "array",
        items: { type: "integer", exclusiveMinimum: 0 },
      }),
    ).toEqual({ type: "array", items: { type: "integer", minimum: 1 } });

    expect(
      toGoogleFunctionSchema({
        type: "array",
        items: [
          { type: "integer", exclusiveMinimum: 0 },
          { type: "string" },
        ],
      }),
    ).toEqual({
      type: "array",
      items: [{ type: "integer", minimum: 1 }, { type: "string" }],
    });
  });

  it("recurses into anyOf/oneOf/allOf", () => {
    expect(
      toGoogleFunctionSchema({
        oneOf: [{ type: "integer", exclusiveMinimum: 0 }, { type: "string" }],
      }),
    ).toEqual({ oneOf: [{ type: "integer", minimum: 1 }, { type: "string" }] });

    expect(
      toGoogleFunctionSchema({
        anyOf: [{ type: "number", exclusiveMinimum: 0 }],
        allOf: [{ type: "integer", exclusiveMaximum: 3 }],
      }),
    ).toEqual({
      anyOf: [{ type: "number" }],
      allOf: [{ type: "integer", maximum: 2 }],
    });
  });

  it("recurses into schema-valued additionalProperties/additionalItems", () => {
    // As z.record(z.string(), z.number().int().positive()) would emit.
    expect(
      toGoogleFunctionSchema({
        type: "object",
        additionalProperties: { type: "integer", exclusiveMinimum: 0 },
      }),
    ).toEqual({
      type: "object",
      additionalProperties: { type: "integer", minimum: 1 },
    });
    expect(
      toGoogleFunctionSchema({
        type: "array",
        items: [{ type: "string" }],
        additionalItems: { type: "integer", exclusiveMaximum: 5 },
      }),
    ).toEqual({
      type: "array",
      items: [{ type: "string" }],
      additionalItems: { type: "integer", maximum: 4 },
    });
  });

  it("recurses into $defs and definitions", () => {
    expect(
      toGoogleFunctionSchema({
        $defs: { count: { type: "integer", exclusiveMinimum: 0 } },
        type: "object",
        properties: { n: { $ref: "#/$defs/count" } },
      }),
    ).toEqual({
      $defs: { count: { type: "integer", minimum: 1 } },
      type: "object",
      properties: { n: { $ref: "#/$defs/count" } },
    });
    expect(
      toGoogleFunctionSchema({
        definitions: { id: { type: "integer", exclusiveMinimum: 1 } },
        type: "object",
        properties: { i: { $ref: "#/definitions/id" } },
      }),
    ).toEqual({
      definitions: { id: { type: "integer", minimum: 2 } },
      type: "object",
      properties: { i: { $ref: "#/definitions/id" } },
    });
  });

  it("recurses into patternProperties values", () => {
    expect(
      toGoogleFunctionSchema({
        type: "object",
        patternProperties: {
          "^x-": { type: "integer", exclusiveMinimum: 0 },
        },
      }),
    ).toEqual({
      type: "object",
      patternProperties: {
        "^x-": { type: "integer", minimum: 1 },
      },
    });
  });

  it("recurses into contains/not/if/then/else/propertyNames/prefixItems", () => {
    expect(
      toGoogleFunctionSchema({
        type: "array",
        contains: { type: "integer", exclusiveMinimum: 0 },
      }),
    ).toEqual({ type: "array", contains: { type: "integer", minimum: 1 } });

    expect(toGoogleFunctionSchema({ not: { type: "integer", exclusiveMinimum: 0 } })).toEqual({
      not: { type: "integer", minimum: 1 },
    });

    expect(
      toGoogleFunctionSchema({
        if: { type: "integer", exclusiveMinimum: 0 },
        then: { type: "integer", exclusiveMaximum: 5 },
        else: { type: "string" },
      }),
    ).toEqual({
      if: { type: "integer", minimum: 1 },
      then: { type: "integer", maximum: 4 },
      else: { type: "string" },
    });

    expect(
      toGoogleFunctionSchema({
        type: "object",
        propertyNames: { type: "integer", exclusiveMinimum: 0 },
      }),
    ).toEqual({
      type: "object",
      propertyNames: { type: "integer", minimum: 1 },
    });

    expect(
      toGoogleFunctionSchema({
        type: "array",
        prefixItems: [{ type: "integer", exclusiveMinimum: 0 }],
      }),
    ).toEqual({
      type: "array",
      prefixItems: [{ type: "integer", minimum: 1 }],
    });
  });

  it("recurses into properties values and leaves user property names untouched", () => {
    const schema = {
      type: "object",
      properties: {
        exclusiveMinimum: { type: "string" },
        line: { type: "integer", exclusiveMinimum: 0 },
        nested: {
          type: "object",
          properties: {
            exclusiveMaximum: { type: "boolean" },
            col: { type: "integer", exclusiveMaximum: 10 },
          },
        },
      },
    };
    const converted = toGoogleFunctionSchema(schema);
    const props = converted.properties as Record<string, any>;
    // A user property literally named `exclusiveMinimum` is preserved as-is.
    expect(props.exclusiveMinimum).toEqual({ type: "string" });
    expect(props.line).toEqual({ type: "integer", minimum: 1 });
    expect(props.nested.properties.exclusiveMaximum).toEqual({ type: "boolean" });
    expect(props.nested.properties.col).toEqual({ type: "integer", maximum: 9 });
    expect(Object.keys(props)).toEqual(["exclusiveMinimum", "line", "nested"]);
  });

  it("keeps boolean and non-object schemas at schema positions as-is", () => {
    expect(toGoogleFunctionSchema({ type: "array", items: true })).toEqual({
      type: "array",
      items: true,
    });
    expect(toGoogleFunctionSchema({ type: "array", items: false })).toEqual({
      type: "array",
      items: false,
    });
    expect(toGoogleFunctionSchema({ type: "array", items: null })).toEqual({
      type: "array",
      items: null,
    });
    expect(toGoogleFunctionSchema({ type: "object", additionalProperties: false })).toEqual({
      type: "object",
      additionalProperties: false,
    });
    expect(
      toGoogleFunctionSchema({ type: "object", properties: { a: true, b: false, z: null } }),
    ).toEqual({
      type: "object",
      properties: { a: true, b: false, z: null },
    });
    expect(toGoogleFunctionSchema({ not: true })).toEqual({ not: true });
  });

  it("leaves every other keyword and value untouched", () => {
    const schema = {
      type: "object",
      description: "a tool",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "File path" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max" },
      },
    };
    expect(toGoogleFunctionSchema(schema)).toEqual(schema);
  });

  it("preserves payload keywords (default/const/enum/examples) untouched", () => {
    const schema = {
      type: "object",
      default: { exclusiveMinimum: 999, nested: { exclusiveMaximum: 7 } },
      const: { exclusiveMinimum: "keep" },
      enum: [{ exclusiveMinimum: 1 }, { exclusiveMaximum: 2 }],
      examples: [{ exclusiveMinimum: true }],
    };
    const converted = toGoogleFunctionSchema(schema);
    expect(converted).toEqual(schema);
    expect(converted.default).toEqual({ exclusiveMinimum: 999, nested: { exclusiveMaximum: 7 } });
    expect((converted.default as any).exclusiveMinimum).toBe(999);
    expect(((converted.default as any).nested as any).exclusiveMaximum).toBe(7);
    expect(converted.const).toEqual({ exclusiveMinimum: "keep" });
    expect(converted.enum).toEqual([{ exclusiveMinimum: 1 }, { exclusiveMaximum: 2 }]);
    expect(converted.examples).toEqual([{ exclusiveMinimum: true }]);
  });

  it("returns a deep copy and never mutates the input", () => {
    const schema = {
      type: "object",
      properties: {
        n: { type: "integer", exclusiveMinimum: 0 },
        items: { type: "array", items: { type: "integer", exclusiveMinimum: 0 } },
      },
    };
    const snapshot = structuredClone(schema);
    const converted = toGoogleFunctionSchema(schema);
    expect(converted).not.toBe(schema);
    expect(converted.properties as Record<string, unknown>).not.toBe(schema.properties);
    expect((converted.properties as Record<string, unknown>).n).not.toBe(schema.properties.n);
    expect(schema).toEqual(snapshot);
    expect(JSON.stringify(schema)).toBe(JSON.stringify(snapshot));
    expect("exclusiveMinimum" in (converted.properties as any).n).toBe(false);
  });

  it("shares no mutable object with the input", () => {
    const schema = {
      type: "object",
      properties: {
        n: { type: "integer", exclusiveMinimum: 0 },
        tags: { type: "array", items: { type: "string" } },
        meta: {
          type: "object",
          additionalProperties: { type: "integer", exclusiveMinimum: 0 },
        },
      },
      required: ["n", "tags"],
      enum: [{ a: [1, 2] }],
      default: { deep: { list: [1] } },
      examples: [{ x: { y: [3] } }],
    };
    const snapshot = structuredClone(schema);
    const result = toGoogleFunctionSchema(schema);

    // Mutate every nested object/array of the result in place.
    const corrupt = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          corrupt(node[i]);
          const item = node[i];
          if (item && typeof item === "object") {
            (item as Record<string, unknown>).__corrupt = true;
          } else {
            node[i] = "__corrupt";
          }
        }
        return;
      }
      if (node && typeof node === "object") {
        const record = node as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          const value = record[key];
          corrupt(value);
          if (value && typeof value === "object") {
            (value as Record<string, unknown>).__corrupt = true;
          } else {
            record[key] = "__corrupt";
          }
        }
      }
    };
    corrupt(result);

    expect(result).not.toBe(schema);
    expect(result.required).not.toBe(schema.required);
    expect(result.enum).not.toBe(schema.enum);
    expect((result.enum as unknown[])[0]).not.toBe((schema.enum as unknown[])[0]);
    expect(result.default).not.toBe(schema.default);
    expect(result.examples).not.toBe(schema.examples);
    expect((result.properties as Record<string, unknown>).meta).not.toBe(
      (schema.properties as Record<string, unknown>).meta,
    );
    expect(schema).toEqual(snapshot);
    expect(JSON.stringify(schema)).toBe(JSON.stringify(snapshot));
  });
});

describe("Google function declarations for the full default tool registry", () => {
  const forbiddenKeys = new Set(["exclusiveMinimum", "exclusiveMaximum"]);

  function findForbiddenKeys(node: unknown, found: string[]): void {
    if (Array.isArray(node)) {
      for (const item of node) findForbiddenKeys(item, found);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (forbiddenKeys.has(key)) found.push(key);
        findForbiddenKeys(value, found);
      }
    }
  }

  async function captureGoogleRequestBody(tools: ToolDefinition[]): Promise<Record<string, unknown>> {
    const driver = new GoogleDriver();
    const request: StreamRequest = {
      provider: "google",
      model: "gemini-google-tool-schema-test",
      messages: [{ role: "user", content: "hi" }],
      tools,
    };
    let body: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      const frames = [
        { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] },
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join("");
      return new Response(frames, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const eventTypes: string[] = [];
      for await (const event of driver.stream(request, { apiKey: "test-key" })) {
        eventTypes.push(event.type);
      }
      expect(eventTypes.at(-1)).toBe("done");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(body).toBeDefined();
    return body!;
  }

  function defaultToolRegistry(): ToolDefinition[] {
    const tools = createAllTools({
      eventLog: {} as unknown as EventLog,
      stateGraph: {} as unknown as StateGraph,
      memoryStore: null,
      memoryEnabled: true,
      incognito: false,
      contextEngine: {} as never,
      cwd: process.cwd(),
      skills: [],
      skillRuntime: null,
      classicMode: false,
    });
    return Object.entries(tools).map(([name, def]) => ({
      name,
      description: (def as { description?: string }).description ?? "",
      parameters: normalizeToolParameters((def as { parameters?: unknown }).parameters),
    }));
  }

  function capturedDeclarations(body: Record<string, unknown>): Array<Record<string, unknown>> {
    const tools = body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    expect(tools).toHaveLength(1);
    const declarations = tools[0]!.functionDeclarations;
    expect(declarations.length).toBeGreaterThan(10);
    return declarations;
  }

  it("contains no exclusiveMinimum/exclusiveMaximum keys in any function declaration", async () => {
    const body = await captureGoogleRequestBody(defaultToolRegistry());
    const declarations = capturedDeclarations(body);

    const found: string[] = [];
    for (const declaration of declarations) {
      findForbiddenKeys(declaration, found);
    }
    expect(found).toEqual([]);
  });

  it("converts retrieve_artifact and read_file integer bounds to minimum 1", async () => {
    const body = await captureGoogleRequestBody(defaultToolRegistry());
    const declarations = capturedDeclarations(body);
    const byName = new Map(declarations.map((d) => [d.name as string, d]));

    const expectations: Array<[string, string[]]> = [
      ["retrieve_artifact", ["lineStart", "lineEnd"]],
      ["read_file", ["offset", "limit"]],
    ];

    for (const [toolName, props] of expectations) {
      const decl = byName.get(toolName);
      expect(decl, `${toolName} should be declared`).toBeDefined();
      const parameters = (decl as Record<string, unknown>).parameters as Record<string, unknown>;
      const properties = parameters.properties as Record<string, Record<string, unknown>>;
      for (const prop of props) {
        const value = properties[prop];
        expect(value, `${toolName}.${prop} should be present`).toBeDefined();
        expect(value!.minimum, `${toolName}.${prop} should have minimum 1`).toBe(1);
        expect("exclusiveMinimum" in value!, `${toolName}.${prop} should not have exclusiveMinimum`).toBe(
          false,
        );
      }
    }
  });
});
