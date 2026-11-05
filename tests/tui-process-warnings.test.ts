import { expect, it } from "bun:test";

it("routes process warnings while active and restores the default handler", async () => {
  const script = `
    import { routeTuiWarnings } from './src/ui/tui/process-warnings.ts';
    const before = process.listeners('warning');
    const restore = routeTuiWarnings({ warn(message, options) { console.log('LOG', message, options.cause.name); } });
    process.emitWarning('during-tui');
    await Bun.sleep(30);
    restore();
    console.log('RESTORED', JSON.stringify(process.listeners('warning') === before), process.listeners('warning').every((fn, i) => fn === before[i]));
    process.emitWarning('after-tui');
    await Bun.sleep(30);
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exit).toBe(0);
  expect(stdout).toContain("LOG during-tui Warning");
  expect(stdout).toContain("RESTORED false true");
  expect(stderr).not.toContain("during-tui");
  expect(stderr).toContain("after-tui");
});
