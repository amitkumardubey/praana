/**
 * OpenTUI wrapper around TextareaRenderable that applies inverse video styling
 * and vertical padding to the input bar.
 *
 * The prompt "❯ " is a sibling TextRenderable so it is not user-editable.
 * Vertical padding and a bottom border provide visual separation.
 */
import { BoxRenderable, TextRenderable, TextareaRenderable, type RenderContext, type StyledText } from "@opentui/core";

const PROMPT = "❯ ";

export class InvertedEditor extends BoxRenderable {
  readonly inner: TextareaRenderable;

  get focused(): boolean {
    return this.inner.focused;
  }

  set focused(v: boolean) {
    if (v) {
      this.focus();
    } else {
      this.blur();
    }
  }

  constructor(ctx: RenderContext, options?: { paddingY?: number; placeholder?: string }) {
    super(ctx, { id: "inverted-editor", flexDirection: "column" });

    this.inner = new TextareaRenderable(ctx, {
      id: "inverted-editor-textarea",
      flexGrow: 1,
      minWidth: 1,
      textColor: "white",
      backgroundColor: "transparent",
      cursorColor: "white",
      cursorStyle: { style: "block", blinking: true },
      placeholder: options?.placeholder ?? "",
      // Chat prompt: Enter submits (OpenTUI Textarea defaults Enter→newline / Meta+Enter→submit).
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "linefeed", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "kpenter", shift: true, action: "newline" },
      ],
    });

    const paddingY = options?.paddingY ?? 1;

    if (paddingY > 0) {
      this.add(new BoxRenderable(ctx, { height: paddingY }));
    }

    const row = new BoxRenderable(ctx, {
      id: "inverted-editor-row",
      flexDirection: "row",
      flexGrow: 1,
      minHeight: 1,
    });
    row.add(new TextRenderable(ctx, { id: "inverted-editor-prompt", content: PROMPT }));
    row.add(this.inner);
    this.add(row);

    if (paddingY > 0) {
      this.add(new BoxRenderable(ctx, { height: paddingY }));
    }

    this.add(new BoxRenderable(ctx, { height: 1, border: ["bottom"], borderColor: "gray" }));
  }

  /** Delegate to the textarea — BoxRenderable.focus() is a no-op when not focusable. */
  override focus(): void {
    this.inner.focus();
  }

  override blur(): void {
    this.inner.blur();
  }

  setText(text: string): void {
    this.inner.setText(text);
  }

  getText(): string {
    return this.inner.plainText;
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.inner.onSubmit = handler
      ? () => {
          handler(this.getText());
        }
      : undefined;
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this.inner.onSubmit;
  }

  set placeholder(value: string | null) {
    this.inner.placeholder = value;
  }

  get placeholder(): StyledText | string | null {
    return this.inner.placeholder;
  }

  handleInput(_data: string): void {
    // OpenTUI dispatches keyboard input directly to focused renderables
    // via the renderer's key handler. This method is kept for API compatibility.
  }

  invalidate(): void {
    this.requestRender();
  }
}
