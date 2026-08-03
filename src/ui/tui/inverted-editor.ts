/**
 * OpenTUI wrapper around TextareaRenderable that applies inverse video styling
 * and vertical padding to the input bar.
 *
 * The prompt "❯ " is rendered as part of the textarea content.
 * Vertical padding and a bottom border provide visual separation.
 */
import { BoxRenderable, TextareaRenderable, type RenderContext, type StyledText } from "@opentui/core";

const PROMPT = "❯ ";

export class InvertedEditor extends BoxRenderable {
  readonly inner: TextareaRenderable;

  get focused(): boolean {
    return this.inner.focused;
  }

  set focused(v: boolean) {
    if (v) {
      this.inner.focus();
    } else {
      this.inner.blur();
    }
  }

  constructor(ctx: RenderContext, options?: { paddingY?: number; placeholder?: string }) {
    super(ctx, { id: "inverted-editor", flexDirection: "column" });

    this.inner = new TextareaRenderable(ctx, {
      flexGrow: 1,
      minWidth: 1,
      textColor: "white",
      backgroundColor: "transparent",
      cursorColor: "white",
      cursorStyle: { style: "block", blinking: true },
      placeholder: options?.placeholder ?? "",
    });

    const paddingY = options?.paddingY ?? 1;

    if (paddingY > 0) {
      this.add(new BoxRenderable(ctx, { height: paddingY }));
    }

    this.add(this.inner);

    if (paddingY > 0) {
      this.add(new BoxRenderable(ctx, { height: paddingY }));
    }

    this.add(new BoxRenderable(ctx, { height: 1, border: ["bottom"], borderColor: "gray" }));
  }

  setText(text: string): void {
    this.inner.setText(PROMPT + text);
  }

  getText(): string {
    const text = this.inner.plainText;
    if (text.startsWith(PROMPT)) {
      return text.slice(PROMPT.length);
    }
    return text;
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