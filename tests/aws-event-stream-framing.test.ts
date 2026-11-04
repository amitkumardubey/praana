import { expect, it } from "bun:test";
import { parseAwsEventStream } from "../src/llm/aws-sigv4.js";

it("rejects a zero-length event frame without spinning", async () => {
  const script = `
    import { parseAwsEventStream } from ${JSON.stringify(new URL("../src/llm/aws-sigv4.ts", import.meta.url).href)};
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16)); c.close(); } });
    try { for await (const frame of parseAwsEventStream(stream)) {} process.exit(1); }
    catch (err) { process.exit(/fram/i.test(String(err)) ? 0 : 2); }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 1000);
  const exit = await child.exited;
  clearTimeout(timer);
  expect(exit).toBe(0);
});

it("rejects headers longer than the frame", async () => {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 16);
  view.setUint32(4, 1);
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
  const consume = async () => { for await (const frame of parseAwsEventStream(stream)) {} };
  await expect(consume()).rejects.toThrow(/fram/i);
});
