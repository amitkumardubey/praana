import type { Session } from "../session.js";

type BannerOptions = {
  session: Session;
  cwd: string;
  model: string;
};

function fallbackLines({ session, cwd, model }: BannerOptions): string[] {
  const memoryStats = session.getMemoryStats();
  const digestLen = session.digest?.length ?? 0;
  const content = [
    `ARIA v0.1.0`,
    `session: ${session.id}`,
    `cwd: ${cwd}`,
    `model: ${model}`,
    `memory entries: ${memoryStats.total}`,
    `digest chars: ${digestLen}`,
    session.memoryEnabled
      ? `memory db: ${session.getMemoryDbPath() ?? "(unknown)"}`
      : "memory: disabled",
  ];

  const width = Math.max(...content.map((s) => s.length));
  const top = `┌${"─".repeat(width + 2)}┐`;
  const body = content.map((line) => `│ ${line.padEnd(width)} │`);
  const bottom = `└${"─".repeat(width + 2)}┘`;
  return [top, ...body, bottom];
}

export async function renderSessionBanner(options: BannerOptions): Promise<string[]> {
  try {
    const mod = (await import("@earendil-works/pi-tui")) as any;
    const Text = mod.Text as
      | (new (text: string, paddingX?: number, paddingY?: number) => {
          render: (width: number) => string[];
        })
      | undefined;
    if (!Text) return fallbackLines(options);

    const fallback = fallbackLines(options).join("\n");
    const width = Math.max(60, process.stdout.columns ?? 100);
    const text = new Text(fallback, 0, 0);
    return text.render(width);
  } catch {
    return fallbackLines(options);
  }
}
