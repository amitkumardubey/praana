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
    expect(converted.properties).not.toBe(schema.properties);
    expect(converted.properties.n).not.toBe(schema.properties.n);
    expect(schema).toEqual(snapshot);
    expect(JSON.stringify(schema)).toBe(JSON.stringify(snapshot));
    expect("exclusiveMinimum" in (converted.properties as any).n).toBe(false);
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

  it("contains no exclusiveMinimum/exclusiveMaximum keys in any function declaration", async () => {
    const body = await captureGoogleRequestBody(defaultToolRegistry());
    const tools = body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    expect(tools).toHaveLength(1);
    const declarations = tools[0]!.functionDeclarations;
    expect(declarations.length).toBeGreaterThan(10);

    const found: string[] = [];
    for (const declaration of declarations) {
      findForbiddenKeys(declaration, found);
    }
    expect(found).toEqual([]);

    // Sanity: converted integer bounds are present, so the conversion ran.
    const serialized = JSON.stringify(declarations);
    expect(serialized).toContain('"minimum":1');
  });
});
