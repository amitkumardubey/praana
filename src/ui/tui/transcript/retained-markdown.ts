import {
  CodeRenderable,
  MarkdownRenderable,
  StyledText,
  type MarkdownOptions,
  type Renderable,
  type RenderContext,
  type SyntaxStyle,
} from "@opentui/core";

interface StyledSnapshot {
  content: string;
  styled: StyledText;
}

/**
 * OpenTUI 0.8's coalesced markdown preview is only inline-parsed: block syntax
 * leaks into the native buffer between a content append and async highlighting.
 * Keep the last fully transformed chunks instead. Use public CodeRenderable
 * hooks; retain upstream parsing, reconciliation, links and final output.
 */
export class RetainedMarkdownRenderable extends MarkdownRenderable {
  private readonly snapshots = new WeakMap<CodeRenderable, StyledSnapshot>();

  constructor(ctx: RenderContext, options: MarkdownOptions) {
    super(ctx, options);
    this.retainStyledBuffers();
  }

  override get content(): string {
    return super.content;
  }

  override set content(value: string) {
    if (super.content === value) return;
    super.content = value;
    this.retainStyledBuffers();
  }

  override get streaming(): boolean {
    return super.streaming;
  }

  override set streaming(value: boolean) {
    if (super.streaming === value) return;
    super.streaming = value;
    this.retainStyledBuffers();
  }

  override get syntaxStyle(): SyntaxStyle {
    return super.syntaxStyle;
  }

  override set syntaxStyle(value: SyntaxStyle) {
    if (super.syntaxStyle === value) return;
    super.syntaxStyle = value;
    // JSX may assign the theme after content. Flush the deferred rerender now
    // so it cannot reinstall a raw preview during the native lifecycle pass.
    this.refreshStyles();
  }

  override refreshStyles(): void {
    super.refreshStyles();
    this.retainStyledBuffers();
  }

  private retainStyledBuffers(): void {
    const visit = (node: Renderable): void => {
      if (node instanceof CodeRenderable && node.filetype === "markdown") {
        let snapshot = this.snapshots.get(node);
        if (snapshot?.content === node.content && !node.drawUnstyledText) return;
        if (!snapshot) {
          snapshot = { content: node.content, styled: new StyledText([]) };
          this.snapshots.set(node, snapshot);
          const saved = snapshot;
          const transform = node.onChunks;
          node.onChunks = async (chunks, context) => {
            const styled = await transform?.(chunks, context) ?? chunks;
            if (!node.isDestroyed && node.content === context.content) {
              saved.styled = new StyledText(styled);
            }
            return styled;
          };
        }
        // updateBlocks() may just have overwritten this buffer with a raw
        // preview. Restore before the renderer can present it. New blocks stay
        // empty until their first styled result; existing blocks keep theirs.
        node.drawUnstyledText = false;
        node.updateStreamingPreview(node.content, snapshot.styled);
        snapshot.content = node.content;
      }
      for (const child of node.getChildren()) visit(child);
    };
    for (const child of this.getChildren()) visit(child);
  }
}
