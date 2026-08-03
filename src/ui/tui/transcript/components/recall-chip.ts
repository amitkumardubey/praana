import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";

/** Violet memory recall chip (design §4). */
export class RecallChipComponent extends BoxRenderable {
  private readonly opts: TranscriptRenderOpts;
  private readonly textNode: TextRenderable;
  private readonly preview: string;
  private readonly count: number;
  private readonly query: string | null;

  constructor(ctx: RenderContext, preview: string, count: number, query: string | null, opts: TranscriptRenderOpts) {
    super(ctx, { id: "recall-chip", flexDirection: "row" });
    this.opts = opts;
    this.preview = preview;
    this.count = count;
    this.query = query;
    this.textNode = new TextRenderable(ctx, { content: this.paint() });
    this.add(this.textNode);
  }

  getPreview(): string {
    return this.preview;
  }

  getCount(): number {
    return this.count;
  }

  getQuery(): string | null {
    return this.query;
  }

  private paint(): string {
    const label = TUI_STYLE.memory(`◆ recall ${this.count}`);
    const queryPart = this.query ? TUI_STYLE.faint(` · "${this.query.slice(0, 40)}"`) : "";
    const previewPart = this.preview ? TUI_STYLE.faint(` → "${this.preview.slice(0, 48)}"`) : "";
    return label + queryPart + previewPart;
  }
}
