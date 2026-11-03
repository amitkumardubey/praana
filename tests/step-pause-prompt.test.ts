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
        createDefaultTurnSink().onStepPause!(3),
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
        const pending = createDefaultTurnSink().onStepPause!(8);
        await new Promise((resolve) => setImmediate(resolve));
        input.write("yes\n");
        return pending;
      });
      expect(chunks.join("")).toContain(PROMPT_HINT);
      expect(continued).toBe(true);
      expect(input.isPaused()).toBe(false);

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

  it("does not prompt when stdin is not a TTY", async () => {
    const input = scriptedStdin("n\n", false);
    const handler = await withStdin(input as unknown as NodeJS.ReadStream, async () =>
      createDefaultTurnSink().onStepPause,
    );
    expect(handler).toBeUndefined();
  });
});
