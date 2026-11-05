import { TextRenderable, type RenderContext, type TextOptions } from "@opentui/core";

/**
 * The coral `❯ ` prefix is layout, not message text.
 *
 * Copying a selection that spans a user row must return the message alone, so
 * this text renderable contributes nothing to `Selection.getSelectedText()`.
 * It stays `selectable` (the default): OpenTUI's native hit test ignores that
 * flag, so a non-selectable glyph would also refuse to *start* a selection on
 * its two columns — the drag has to keep working from the prefix.
 */
export class PrefixGlyphRenderable extends TextRenderable {
  constructor(ctx: RenderContext, options: TextOptions) {
    super(ctx, options);
  }

  override getSelectedText(): string {
    return "";
  }
}
