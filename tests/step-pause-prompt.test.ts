import { describe, expect, it } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { createDefaultTurnSink } from "../src/ui-events.js";

const PROMPT_HINT = "Enter or y = continue, anything else = stop";

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode(_mode: boolean): this {
    return this;
  }
}

async function withStdin<T>(stdin: NodeJS.ReadStream, fn: () => Promise<T>): Promise<T> {
  const original = process.stdin;
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", { value: original, configurable: true });
    if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

function scriptedStdin(line: string, tty: boolean): Readable & { isTTY: boolean } {
  const input = Readable.from([line]) as Readable & { isTTY: boolean; setRawMode?: (mode: boolean) => Readable };
  input.isTTY = tty;
  input.setRawMode = () => input;
  return input;
}

describe("plain-terminal step pause prompt", () => {
  it("treats Enter, y, and yes as continue and anything else as stop", async () => {
    const cases: Array<[string, boolean]> = [
      ["\n", true],
      ["y\n", true],
      ["Y\n", true],
      ["yes\n", true],
      ["YES\n", true],
      ["  Yes  \n", true],
      ["n\n", false],
      ["no\n", false],
      ["esc\n", false],
      ["maybe\n", false],
    ];
    for (const [line, expected] of cases) {
      const input = scriptedStdin(line, true);
      const continued = await withStdin(input as unknown as NodeJS.ReadStream, () =>
        createDefaultTurnSink().onStepPause!(3, new AbortController().signal),
      );
      expect({ line: JSON.stringify(line), continued }).toEqual({
        line: JSON.stringify(line),
        continued: expected,
      });
    }
  });

  it("writes the answer rule to stdout and leaves stdin readable", async () => {
    const input = new FakeStdin();
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, enc?: unknown, cb?: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      const done = typeof enc === "function" ? enc : cb;
      if (typeof done === "function") (done as () => void)();
      return true;
    }) as typeof process.stdout.write;

    try {
      const continued = await withStdin(input as unknown as NodeJS.ReadStream, async () => {
        const pending = createDefaultTurnSink().onStepPause!(8, new AbortController().signal);
        await new Promise((resolve) => setImmediate(resolve));
        input.write("yes\n");
        return pending;
      });
      expect(chunks.join("")).toContain(PROMPT_HINT);
      expect(continued).toBe(true);
      expect(input.isPaused()).toBe(true);
      input.resume();

      let later = "";
      input.on("data", (chunk) => {
        later += String(chunk);
      });
      input.write("next-line\n");
      await new Promise((resolve) => setImmediate(resolve));
      expect(later).toContain("next-line");
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("resumes a flowing stdin, keeps a paused stdin paused, and leaves an untouched stdin readable", async () => {
    const cases: Array<{ name: string; setup: (input: FakeStdin) => void; flowing: boolean | null; receives: boolean }> = [
      { name: "flowing", setup: (input) => input.resume(), flowing: true, receives: true },
      { name: "paused", setup: (input) => input.pause(), flowing: false, receives: false },
      { name: "untouched", setup: () => {}, flowing: null, receives: true },
    ];
    for (const c of cases) {
      const input = new FakeStdin();
      c.setup(input);
      expect(input.readableFlowing).toBe(c.flowing);
      const abort = new AbortController();
      const result = await withStdin(input as unknown as NodeJS.ReadStream, async () => {
        const pending = createDefaultTurnSink().onStepPause!(2, abort.signal);
        abort.abort();
        return pending;
      });
      expect(result).toBe(false);
      let later = "";
      input.on("data", (chunk) => {
        later += String(chunk);
      });
      input.write("next\n");
      await new Promise((resolve) => setImmediate(resolve));
      expect({ name: c.name, received: later.includes("next") }).toEqual({ name: c.name, received: c.receives });
    }
  });

  it("stops on cancellation and restores a paused stdin", async () => {
    const input = new FakeStdin();
    input.pause();
    const abort = new AbortController();
    const baseline = input.listenerCount("data");
    const result = await withStdin(input as unknown as NodeJS.ReadStream, async () => {
      const pending = createDefaultTurnSink().onStepPause!(2, abort.signal);
      abort.abort();
      return pending;
    });
    expect(result).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(baseline);
  });

  it("stops when stdin closes before a line", async () => {
    const input = new FakeStdin();
    const result = await withStdin(input as unknown as NodeJS.ReadStream, async () => {
      const pending = createDefaultTurnSink().onStepPause!(2, new AbortController().signal);
      input.end();
      return Promise.race([pending, new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100))]);
    });
    expect(result).toBe(false);
  });

  it("does not prompt when stdin is not a TTY", async () => {
    const input = scriptedStdin("n\n", false);
    const handler = await withStdin(input as unknown as NodeJS.ReadStream, async () =>
      createDefaultTurnSink().onStepPause,
    );
    expect(handler).toBeUndefined();
  });
});
