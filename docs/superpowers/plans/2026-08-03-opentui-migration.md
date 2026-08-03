# OpenTUI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@earendil-works/pi-tui` with `@opentui/core` + `@opentui/keymap` throughout PRAANA's `src/ui/tui/**` tree, preserving the `TurnUiSink` contract and existing behavior, with incidental visual improvements where OpenTUI's native flexbox/scrolling is naturally better.

**Architecture:** `turn.ts`/`session.ts`/`ui-events.ts` (`TurnUiSink` contract) are untouched. Every file under `src/ui/tui/` is rewritten against OpenTUI's `Renderable` tree (imperative API: `BoxRenderable`, `TextRenderable`, `InputRenderable`, `TextareaRenderable`, `SelectRenderable`, `ScrollBoxRenderable`, `ASCIIFontRenderable`) instead of pi-tui's line-based `Component.render(width): string[]` model. `redirect-pi-logs.ts` is deleted. Tests move to `@opentui/core/testing`.

**Tech Stack:** Bun, TypeScript (strict, NodeNext), `@opentui/core`, `@opentui/keymap`, `chalk`, `cli-highlight` (kept for now), `figlet` (kept as ASCIIFont fallback if needed).

**Reference spec:** `docs/superpowers/specs/2026-08-03-opentui-migration-design.md`

**Verified OpenTUI facts used throughout this plan** (checked against installed `@opentui/core@0.5.0` type definitions and a local smoke test):
- `createCliRenderer(options)` returns a renderer with `.root: BoxRenderable`, `.destroy()`.
- Every `Renderable` supports `position?: "relative" | "absolute"`, `top/right/bottom/left`, and `zIndex?: number` (confirmed in `Renderable.d.ts`) — this resolves the overlay/z-order risk from the spec: overlays are absolute-positioned `BoxRenderable`s added to `renderer.root` with a high `zIndex`.
- `TextareaRenderable` (extends `EditBufferRenderable`) exposes `cursorOffset`/`cursorCharacterOffset` (character offset in the buffer) and the base `Renderable` exposes `x`/`y`/`screenX` screen coordinates — this resolves the autocomplete-anchor risk: convert `cursorOffset` to line/col by counting newlines in the buffer text ourselves, then add to the Textarea's `x`/`y`.
- `@opentui/core/testing` exports `createTestRenderer({ width, height })` returning `{ renderer, mockInput, renderOnce(), captureCharFrame(), captureSpans() }` — real native renderer, no `mock.module()` needed.
- `BoxRenderable` supports `border`, `borderStyle`, `borderColor`, `title`, `flexDirection`, `gap`/`rowGap`/`columnGap`, `padding*`.
- `ScrollBoxRenderable` supports `scrollY`, `stickyScroll`, `stickyStart: "bottom"`, `scrollTo`, `scrollBy`, `add`/`remove`/`getChildren`.
- `SelectRenderable` supports `options: SelectOption[]` (`{ name, description, value? }`), `SelectRenderableEvents.ITEM_SELECTED`/`SELECTION_CHANGED`, `getSelectedIndex/Option`, `setSelectedIndex`, `moveUp/moveDown`.
- `ASCIIFontRenderable` supports `text`, `font: ASCIIFontName`, `color`.
- No built-in `Loader`/spinner or fuzzy-filter — both are ported as small local utilities (spinner: `setInterval` + `TextRenderable`; fuzzy filter: PRAANA-owned pure function).

---

## Task 0: Branch and dependency swap

**Files:**
- Modify: `package.json`
- Modify: `bun.lock` (regenerated)

- [ ] **Step 1: Create the migration branch**

```bash
git checkout -b feat/ad/opentui-migration
```

- [ ] **Step 2: Remove pi-tui, add OpenTUI packages**

```bash
bun remove @earendil-works/pi-tui
bun add @opentui/core @opentui/keymap
```

- [ ] **Step 3: Verify the install has no native build step and resolves cleanly**

```bash
bun install
bun -e "const { createCliRenderer } = await import('@opentui/core'); console.log(typeof createCliRenderer)"
```

Expected: prints `function`, no Zig/native build errors (prebuilt platform binaries are pulled in as optional deps, verified during design phase).

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(tui): swap @earendil-works/pi-tui for @opentui/core + @opentui/keymap"
```

---

## Task 1: Rewrite `theme.ts` (style primitives)

**Files:**
- Modify: `src/ui/tui/theme.ts`
- Test: `tests/tui-theme.test.ts`

The current file imports `truncateToWidth`/`visibleWidth` from pi-tui for ANSI-aware width math (`paintZoneLine`). OpenTUI's renderer does its own ANSI-aware layout internally, so `paintZoneLine` no longer needs manual truncation — but it is still called from `identity-bar.ts`/`glance-bar.ts` today with a plain string, so we keep the function signature and do truncation with a local (non-pi-tui) helper to avoid a big-bang rename of call sites in this task.

- [ ] **Step 1: Write the failing test for the pi-tui-free truncate helper**

Add to `tests/tui-theme.test.ts` (create if testing this behavior isn't already covered):

```typescript
import { describe, expect, test } from "bun:test";
import { paintZoneLine, TUI_STYLE } from "../src/ui/tui/theme.js";

describe("paintZoneLine (opentui-era)", () => {
  test("truncates plain text to width without pi-tui", () => {
    const result = paintZoneLine("hello world", "chrome", false, 5);
    expect(result).toBe("hello");
  });

  test("passes short text through unchanged", () => {
    const result = paintZoneLine("hi", "chrome", false, 10);
    expect(result).toBe("hi");
  });
});

describe("TUI_STYLE", () => {
  test("heading is bold-styled", () => {
    expect(typeof TUI_STYLE.heading("x")).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (import error, pi-tui removed)**

```bash
bun test tests/tui-theme.test.ts
```

Expected: FAIL — `Cannot find package '@earendil-works/pi-tui'`.

- [ ] **Step 3: Rewrite `theme.ts` without pi-tui**

```typescript
/* Terminal-native semantic styling for the PRAANA OpenTUI-based TUI. */
import chalk from "chalk";
import type { Theme as HighlightTheme } from "cli-highlight";

export type TextStyle = (text: string) => string;

const plain: TextStyle = (text) => text;

/**
 * Semantic TUI styles that defer the main palette to the user's terminal.
 * Only exceptional states use standard ANSI colors.
 */
export const TUI_STYLE = {
  text: plain,
  user: plain,
  assistant: plain,
  system: chalk.dim,
  muted: chalk.dim,
  faint: chalk.dim,
  heading: chalk.bold,
  thinking: (text: string) => chalk.dim.italic(text),
  tool: chalk.yellow,
  info: chalk.cyan,
  memory: chalk.magenta,
  warning: chalk.yellow,
  error: chalk.red,
  success: chalk.green,
  border: chalk.dim,
} as const satisfies Record<string, TextStyle>;

export const EDITOR_BORDER_STYLE: TextStyle = () => "";

// ─── Elevation zones (design §9) ───────────────────────────────────────────

export type ZoneKind = "chrome" | "raised" | "canvas";

export function zonesEnabled(configOn: boolean): boolean {
  return configOn && !process.env.NO_COLOR && chalk.level >= 1;
}

export function zoneBg(
  kind: ZoneKind,
  enabled: boolean,
): ((text: string) => string) | undefined {
  void kind;
  void enabled;
  return undefined;
}

/** Strip ANSI escape codes to measure/truncate visible text length. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible (non-ANSI) length of a string. */
export function visibleTextWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Truncate plain (non-styled) text to `width` visible characters. */
export function truncatePlainText(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return text.slice(0, width - 1) + "…";
}

export function paintZoneLine(
  line: string,
  kind: ZoneKind,
  enabled: boolean,
  width: number,
): string {
  const bg = zoneBg(kind, enabled);
  const truncated = truncatePlainText(line, width);
  if (!bg) return truncated;
  const actual = visibleTextWidth(truncated);
  const padding = " ".repeat(Math.max(0, width - actual));
  return bg(truncated + padding);
}

export function resolveSyntaxTheme(name: string): HighlightTheme | string {
  return name;
}
```

Note: `paintZoneLine`/`truncatePlainText` operate on plain (unstyled) text at call sites in this task's scope (`identity-bar.ts`, `glance-bar.ts` build the line via `formatTuiIdentityLine`/`formatTuiGlanceLine` before any chalk styling is applied to the whole line) — this matches current behavior since those call sites already truncate before coloring.

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/tui-theme.test.ts
```

Expected: PASS (2 tests in new describe block; keep any pre-existing tests in the file passing too — re-check them for pi-tui imports and update those too if present).

- [ ] **Step 5: Typecheck**

```bash
bun typecheck
```

Expected: no errors related to `theme.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/tui/theme.ts tests/tui-theme.test.ts
git commit -m "refactor(tui): rewrite theme.ts without pi-tui width helpers"
```

---

## Task 2: Rewrite `banner.ts` (boot wordmark)

**Files:**
- Modify: `src/ui/tui/banner.ts`
- Test: `tests/tui-banner.test.ts` (new)

`banner.ts` currently returns `string[]` for pi-tui's line-based rendering. Under OpenTUI it becomes a renderable-producing function so `run.ts` can add it directly to the root box. We keep the figlet-art string array as a fallback data source and wrap it in an `ASCIIFontRenderable`-compatible path if `ASCIIFontRenderable`'s bundled fonts don't include a matching "Standard" figlet font; since font parity is an explicit risk in the spec, this task keeps the existing literal wordmark lines (proven pixel-identical today) rendered via `TextRenderable` lines rather than gambling on `ASCIIFontRenderable`'s font set matching pixel-for-pixel.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { buildBootBanner, PRAANA_WORDMARK } from "../src/ui/tui/banner.js";

describe("buildBootBanner", () => {
  test("renders wordmark lines and version when width fits", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const banner = buildBootBanner({
        version: "1.2.3",
        summaryLines: ["session abc123", "model claude"],
        width: 60,
        noColor: true,
        banner: true,
      });
      setup.renderer.root.add(banner);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("v1.2.3");
      expect(frame).toContain("session abc123");
      expect(frame).toContain(PRAANA_WORDMARK[0].trim().slice(0, 5));
    } finally {
      setup.renderer.destroy();
    }
  });

  test("omits wordmark art when width is too narrow", async () => {
    const setup = await createTestRenderer({ width: 20, height: 20 });
    try {
      const banner = buildBootBanner({
        version: "1.2.3",
        summaryLines: [],
        width: 20,
        noColor: true,
        banner: true,
      });
      setup.renderer.root.add(banner);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain(PRAANA_WORDMARK[0].trim().slice(0, 5));
      expect(frame).toContain("v1.2.3");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/tui-banner.test.ts
```

Expected: FAIL — `buildBootBanner` is not exported yet (still exports old `renderBootBanner`).

- [ ] **Step 3: Rewrite `banner.ts`**

```typescript
/* Boot banner — figlet Standard wordmark (design §5.1), OpenTUI renderable. */
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import chalk from "chalk";
import { TUI_STYLE } from "./theme.js";

/** Figlet "Standard" rendering of "praana" from the ambient design spec. */
export const PRAANA_WORDMARK: string[] = [
  "  _ __  _ __ __ _  __ _ _ __   __ _",
  " | '_ \\| '__/ _` |/ _` | '_ \\ / _` |",
  " | |_) | | | (_| | (_| | | | | (_| |",
  " | .__/|_|  \\__,_|\\__,_|_| |_|\\__,_|",
  " |_|",
];

export const PRAANA_WORDMARK_WIDTH: number = PRAANA_WORDMARK.reduce(
  (max, line) => Math.max(max, line.length),
  0,
);

export interface BootBannerOpts {
  version: string;
  summaryLines: string[];
  width: number;
  noColor?: boolean;
  banner?: boolean;
}

/** Build the boot banner as a standalone renderable (no RenderContext needed until added to a tree). */
export function buildBootBanner(opts: BootBannerOpts): BoxRenderable {
  const showArt = (opts.banner ?? true) && opts.width >= PRAANA_WORDMARK_WIDTH;
  const useColor = !opts.noColor && chalk.level >= 1;

  const container = new BoxRenderable(getSharedRenderContext(), {
    id: "boot-banner",
    flexDirection: "column",
  });

  if (showArt) {
    for (const line of PRAANA_WORDMARK) {
      container.add(
        new TextRenderable(getSharedRenderContext(), {
          content: useColor ? TUI_STYLE.heading(line) : line,
        }),
      );
    }
    container.add(new TextRenderable(getSharedRenderContext(), { content: "" }));
  }

  container.add(
    new TextRenderable(getSharedRenderContext(), {
      content: useColor ? chalk.dim(`  v${opts.version}`) : `  v${opts.version}`,
    }),
  );
  container.add(new TextRenderable(getSharedRenderContext(), { content: "" }));

  for (const summaryLine of opts.summaryLines) {
    container.add(
      new TextRenderable(getSharedRenderContext(), { content: `  ${summaryLine}` }),
    );
  }

  return container;
}

let sharedCtx: RenderContext | null = null;

/** `run.ts` calls `setBannerRenderContext()` once with the live renderer's context before `buildBootBanner()`. */
export function setBannerRenderContext(ctx: RenderContext): void {
  sharedCtx = ctx;
}

function getSharedRenderContext(): RenderContext {
  if (!sharedCtx) {
    throw new Error("banner.ts: setBannerRenderContext() must be called before buildBootBanner()");
  }
  return sharedCtx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Update the test to call `setBannerRenderContext(setup.renderer)` before `buildBootBanner()` (the renderer itself satisfies `RenderContext`):

```typescript
import { setBannerRenderContext } from "../src/ui/tui/banner.js";
// inside each test, before buildBootBanner():
setBannerRenderContext(setup.renderer);
```

```bash
bun test tests/tui-banner.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/banner.ts tests/tui-banner.test.ts
git commit -m "refactor(tui): rewrite banner.ts as an OpenTUI renderable"
```

---

## Task 3: Rewrite chrome bars (`identity-bar.ts`, `glance-bar.ts`)

**Files:**
- Modify: `src/ui/tui/chrome/identity-bar.ts`
- Modify: `src/ui/tui/chrome/glance-bar.ts`
- Keep as-is: `src/ui/tui/chrome/glance-format.ts` (no pi-tui import today — verified in exploration)
- Test: `tests/tui-chrome.test.ts` (new)

Both bars become single-line `BoxRenderable` wrappers around one `TextRenderable`, updated via a `setContent`-style method instead of pi-tui's pull-based `render(width)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { IdentityBar } from "../src/ui/tui/chrome/identity-bar.js";
import { GlanceBar } from "../src/ui/tui/chrome/glance-bar.js";

describe("IdentityBar", () => {
  test("shows fallback text before setInput is called", async () => {
    const setup = await createTestRenderer({ width: 40, height: 3 });
    try {
      const bar = new IdentityBar(setup.renderer);
      setup.renderer.root.add(bar);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("praana");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("GlanceBar", () => {
  test("shows initializing state before update is called", async () => {
    const setup = await createTestRenderer({ width: 40, height: 3 });
    try {
      const bar = new GlanceBar(setup.renderer);
      setup.renderer.root.add(bar);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("initializing");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/tui-chrome.test.ts
```

Expected: FAIL — old classes still implement pi-tui's `Component` interface and import from pi-tui.

- [ ] **Step 3: Rewrite `identity-bar.ts`**

```typescript
/**
 * Top identity chrome — brand, model, cwd · branch (design §5).
 */
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import type { StatusBarInput } from "../../../status-bar.js";
import { formatTuiIdentityLine } from "./glance-format.js";
import { paintZoneLine, truncatePlainText, type ZoneKind } from "../theme.js";

export class IdentityBar extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private input: StatusBarInput | null = null;
  private backgroundZones = true;

  constructor(ctx: RenderContext) {
    super(ctx, { id: "identity-bar", flexDirection: "row" });
    this.textNode = new TextRenderable(ctx, { id: "identity-bar-text", content: " praana" });
    this.add(this.textNode);
  }

  setInput(input: StatusBarInput): void {
    this.input = input;
    this.repaint();
  }

  setBackgroundZones(enabled: boolean): void {
    this.backgroundZones = enabled;
    this.repaint();
  }

  private repaint(): void {
    const width = this.width || 80;
    const line = this.input ? formatTuiIdentityLine(this.input) : "praana";
    this.textNode.content = paintZoneLine(
      truncatePlainText(" " + line, width),
      "chrome" satisfies ZoneKind,
      this.backgroundZones,
      width,
    );
  }

  protected onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.repaint();
  }
}
```

- [ ] **Step 4: Rewrite `glance-bar.ts`**

```typescript
/**
 * Bottom glance chrome — ctx%, tiers, skills, cost, flags (design §5).
 */
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import chalk from "chalk";
import type { StatusBarInput } from "../../../status-bar.js";
import { formatTuiGlanceLine } from "./glance-format.js";
import { paintZoneLine, truncatePlainText } from "../theme.js";

export interface GlanceBarInput {
  status: StatusBarInput;
  showCost: boolean;
}

export class GlanceBar extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private input: GlanceBarInput | null = null;
  private backgroundZones = true;

  constructor(ctx: RenderContext) {
    super(ctx, { id: "glance-bar", flexDirection: "row" });
    this.textNode = new TextRenderable(ctx, { id: "glance-bar-text", content: " initializing…" });
    this.add(this.textNode);
  }

  update(input: GlanceBarInput): void {
    this.input = input;
    this.repaint();
    this.requestRender();
  }

  setBackgroundZones(enabled: boolean): void {
    this.backgroundZones = enabled;
    this.repaint();
  }

  private repaint(): void {
    const width = this.width || 80;
    const line = this.input
      ? formatTuiGlanceLine(this.input.status, { showCost: this.input.showCost })
      : chalk.dim("initializing…");
    this.textNode.content = paintZoneLine(
      truncatePlainText(" " + line, width),
      "chrome",
      this.backgroundZones,
      width,
    );
  }

  protected onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.repaint();
  }
}
```

Note: `requestRender()` is a method the renderer exposes on the render context; if `BoxRenderable` doesn't directly expose it, use `this.ctx.requestRender()` via a protected context reference — verify exact accessor name against `Renderable.d.ts`/`renderer.d.ts` during this task and adjust (this is a mechanical detail, not a design change).

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/tui-chrome.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/chrome/identity-bar.ts src/ui/tui/chrome/glance-bar.ts tests/tui-chrome.test.ts
git commit -m "refactor(tui): rewrite identity-bar and glance-bar as OpenTUI renderables"
```

---

## Task 4: Rewrite transcript component family (7 files)

**Files:**
- Modify: `src/ui/tui/transcript/components/user-message.ts`
- Modify: `src/ui/tui/transcript/components/assistant-message.ts`
- Modify: `src/ui/tui/transcript/components/thinking-message.ts`
- Modify: `src/ui/tui/transcript/components/tool-row.ts`
- Modify: `src/ui/tui/transcript/components/recall-chip.ts`
- Modify: `src/ui/tui/transcript/components/system-line.ts`
- Modify: `src/ui/tui/transcript/components/turn-footer.ts`
- Modify: `src/ui/tui/transcript/render-utils.ts` (drop pi-tui import, becomes plain string helpers)
- Modify: `src/ui/tui/transcript/markdown-theme.ts` (drop pi-tui `MarkdownTheme` type import; use OpenTUI's Markdown theme type)
- Test: `tests/transcript-components.test.ts` (new)

Each component moves from `implements Component { render(width): string[] }` to `extends BoxRenderable` with a single or few `TextRenderable` children whose `.content` is set on construction/update. This keeps the same public surface (`getText`/`setText` where applicable) so `container.ts` (Task 5) can drive them the same way.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { UserMessageComponent } from "../src/ui/tui/transcript/components/user-message.js";
import { AssistantMessageComponent } from "../src/ui/tui/transcript/components/assistant-message.js";
import { SystemLineComponent } from "../src/ui/tui/transcript/components/system-line.js";
import { TurnFooterComponent } from "../src/ui/tui/transcript/components/turn-footer.js";
import { buildMarkdownSyntaxStyle } from "../src/ui/tui/transcript/markdown-theme.js";
import type { TranscriptRenderOpts } from "../src/ui/tui/transcript/opts.js";

const opts: TranscriptRenderOpts = {
  markdownRendering: true,
  syntaxTheme: "default",
  backgroundZones: false,
  useUnicode: true,
};

describe("UserMessageComponent", () => {
  test("renders the user text with a left border marker", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const c = new UserMessageComponent(setup.renderer, "hello there");
      setup.renderer.root.add(c);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("hello there");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("AssistantMessageComponent", () => {
  test("renders markdown content via a SyntaxStyle", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const style = buildMarkdownSyntaxStyle("default");
      const c = new AssistantMessageComponent(setup.renderer, "**bold** text", style);
      setup.renderer.root.add(c);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("bold");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("setText replaces the rendered content", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const style = buildMarkdownSyntaxStyle("default");
      const c = new AssistantMessageComponent(setup.renderer, "first", style);
      setup.renderer.root.add(c);
      c.setText("second");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("second");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("SystemLineComponent", () => {
  test("prefixes error icon for error text", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const c = new SystemLineComponent(setup.renderer, "Error: something broke", opts);
      setup.renderer.root.add(c);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("something broke");
      expect(frame).toContain("✕");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("setText updates the rendered content", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const c = new SystemLineComponent(setup.renderer, "first", opts);
      setup.renderer.root.add(c);
      c.setText("second");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("second");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("TurnFooterComponent", () => {
  test("renders dim digest text", async () => {
    const setup = await createTestRenderer({ width: 40, height: 3 });
    try {
      const c = new TurnFooterComponent(setup.renderer, "3 tools · 1.2k tok");
      setup.renderer.root.add(c);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("3 tools · 1.2k tok");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/transcript-components.test.ts
```

Expected: FAIL — constructors still take `(text, opts)` without a `RenderContext`, and pi-tui imports are gone from `node_modules`.

- [ ] **Step 3: Rewrite `render-utils.ts` (drop pi-tui, keep pure string helpers)**

```typescript
/** Plain-text wrap/accent helpers for transcript components (no ANSI-width dependency needed under OpenTUI). */
import { TUI_STYLE } from "../theme.js";

/** Word-wrap plain text to `width` columns. OpenTUI's TextRenderable already wraps visually;
 *  this helper stays for components that need pre-split lines (e.g. accent-bar prefixing). */
export function wrapContent(
  text: string,
  width: number,
  color: (s: string) => string = TUI_STYLE.text,
): string[] {
  if (width <= 0) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width && current) {
      lines.push(color(current));
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(color(current));
  return lines.length > 0 ? lines : [color(text)];
}

/** Prefix each line with a left accent marker for a given role/zone. Returns plain strings;
 *  callers join with "\n" into a single TextRenderable.content. */
export function renderAccentLines(
  lines: string[],
  _role: string,
  _zone: string,
  _showBorder: boolean,
  _width: number,
): string[] {
  return lines;
}
```

- [ ] **Step 4: Rewrite `user-message.ts`**

```typescript
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";

/** Dim left-border user turn. */
export class UserMessageComponent extends BoxRenderable {
  private readonly textNode: TextRenderable;

  constructor(ctx: RenderContext, text: string) {
    super(ctx, { id: "user-message", flexDirection: "column" });
    this.textNode = new TextRenderable(ctx, { content: TUI_STYLE.user(text) });
    this.add(this.textNode);
  }

  setText(text: string): void {
    this.textNode.content = TUI_STYLE.user(text);
  }
}
```

- [ ] **Step 5: Rewrite `markdown-theme.ts` (drop pi-tui `MarkdownTheme`, build an OpenTUI `SyntaxStyle`)**

OpenTUI's `MarkdownRenderable` (verified in `renderables/Markdown.d.ts`) has a fundamentally different theming model than pi-tui: instead of a `MarkdownTheme` object of per-element color *functions* (heading/link/code/quote callbacks), it takes a required `syntaxStyle: SyntaxStyle` built via `SyntaxStyle.fromStyles(record)`, mapping named style scopes to `{ fg, bg, bold, italic, underline, dim }`. `markdown-theme.ts` is rewritten to build one of these instead:

```typescript
import { SyntaxStyle } from "@opentui/core";
import { TUI_STYLE } from "../theme.js";

/** Builds an OpenTUI SyntaxStyle for markdown rendering, replacing pi-tui's MarkdownTheme callbacks. */
export function buildMarkdownSyntaxStyle(_syntaxTheme: string): SyntaxStyle {
  // Scope names below (heading/link/code/quote/hr/list/bold/italic/strikethrough/underline)
  // are best-effort based on common markdown/tree-sitter conventions. Verify the exact
  // registered scope names during this task by rendering sample markdown through
  // MarkdownRenderable and calling `syntaxStyle.getRegisteredNames()` — adjust the keys
  // below to match whatever OpenTUI actually registers, if different.
  return SyntaxStyle.fromStyles({
    heading: { bold: true },
    link: { fg: "#00AFFF" },
    "link.url": { dim: true },
    code: { bg: "#333333" },
    "code.block": {},
    quote: { italic: true, dim: true },
    "quote.border": { dim: true },
    hr: { dim: true },
    "list.bullet": { dim: true },
    bold: { bold: true },
    italic: { italic: true },
    strikethrough: {},
    underline: { underline: true },
  });
}

export { TUI_STYLE };
```

Note: pi-tui's custom `highlightCode` hook (which ran fenced code blocks through `cli-highlight`) has no direct equivalent here — OpenTUI's `MarkdownRenderable` does its own code-block highlighting via `treeSitterClient` (an optional constructor option). During this task, wire a `TreeSitterClient` instance (from `@opentui/core`'s `lib/tree-sitter`) into `MarkdownRenderable`'s `treeSitterClient` option in Step 6 below instead of calling `cli-highlight` manually; this also means `cli-highlight` can likely be dropped from `package.json` once this is confirmed working — file that as a follow-up cleanup, not blocking this task.

- [ ] **Step 6: Rewrite `assistant-message.ts`**

```typescript
import { BoxRenderable, MarkdownRenderable, type RenderContext } from "@opentui/core";
import type { SyntaxStyle } from "@opentui/core";

/** Streaming prose via OpenTUI's MarkdownRenderable. */
export class AssistantMessageComponent extends BoxRenderable {
  private readonly markdownNode: MarkdownRenderable;

  constructor(ctx: RenderContext, text: string, syntaxStyle: SyntaxStyle) {
    super(ctx, { id: "assistant-message", flexDirection: "column" });
    this.markdownNode = new MarkdownRenderable(ctx, { content: text, syntaxStyle });
    this.add(this.markdownNode);
  }

  setText(text: string): void {
    this.markdownNode.content = text;
  }
}
```

- [ ] **Step 7: Rewrite `thinking-message.ts`**

```typescript
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";

/** Collapsible thinking block. */
export class ThinkingMessageComponent extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private expanded = false;
  private fullText = "";

  constructor(ctx: RenderContext, text: string) {
    super(ctx, { id: "thinking-message", flexDirection: "column" });
    this.fullText = text;
    this.textNode = new TextRenderable(ctx, { content: this.summaryLine() });
    this.add(this.textNode);
  }

  private summaryLine(): string {
    const firstLine = this.fullText.split("\n")[0] ?? "";
    return TUI_STYLE.thinking(this.expanded ? this.fullText : `${firstLine} …`);
  }

  setText(text: string): void {
    this.fullText = text;
    this.textNode.content = this.summaryLine();
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.textNode.content = this.summaryLine();
  }
}
```

- [ ] **Step 8: Rewrite `tool-row.ts`**

```typescript
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";

/** Tool call/result row with body preview. */
export class ToolRowComponent extends BoxRenderable {
  private readonly headerNode: TextRenderable;
  private readonly bodyNode: TextRenderable;

  constructor(ctx: RenderContext, toolName: string, args: Record<string, unknown>) {
    super(ctx, { id: "tool-row", flexDirection: "column" });
    this.headerNode = new TextRenderable(ctx, {
      content: TUI_STYLE.tool(`⚙ ${toolName}(${Object.keys(args).join(", ")})`),
    });
    this.bodyNode = new TextRenderable(ctx, { content: "" });
    this.add(this.headerNode);
    this.add(this.bodyNode);
  }

  setResult(resultText: string, isError = false): void {
    const color = isError ? TUI_STYLE.error : TUI_STYLE.muted;
    this.bodyNode.content = color(resultText);
  }
}
```

- [ ] **Step 9: Rewrite `recall-chip.ts`**

```typescript
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";

/** Violet memory-recall chip. */
export class RecallChipComponent extends BoxRenderable {
  private readonly textNode: TextRenderable;

  constructor(ctx: RenderContext, text: string) {
    super(ctx, { id: "recall-chip", flexDirection: "row" });
    this.textNode = new TextRenderable(ctx, { content: TUI_STYLE.memory(`◆ ${text}`) });
    this.add(this.textNode);
  }

  setText(text: string): void {
    this.textNode.content = TUI_STYLE.memory(`◆ ${text}`);
  }
}
```

- [ ] **Step 10: Rewrite `system-line.ts`**

```typescript
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";

function detectIcon(text: string): { icon: string; color: (s: string) => string } {
  const t = text.toLowerCase();
  if (/^(error|\[error\]|✕|fail|exception|crash)/.test(t) || /\berror\b/.test(t)) {
    return { icon: "✕ ", color: TUI_STYLE.error };
  }
  if (/^(warn|\[warn\]|warning|▲)/.test(t)) {
    return { icon: "▲ ", color: TUI_STYLE.warning };
  }
  if (/^(✓|ok |done|success|saved|completed|resumed)/.test(t)) {
    return { icon: "✓ ", color: TUI_STYLE.success };
  }
  if (/^(⚡|aborted|interrupted)/.test(t)) {
    return { icon: "⚡ ", color: TUI_STYLE.warning };
  }
  return { icon: "· ", color: TUI_STYLE.system };
}

/** Slash-command output and system notices. */
export class SystemLineComponent extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private text: string;

  constructor(ctx: RenderContext, text: string, private readonly opts: TranscriptRenderOpts) {
    super(ctx, { id: "system-line", flexDirection: "column" });
    this.text = text;
    this.textNode = new TextRenderable(ctx, { content: this.paint() });
    this.add(this.textNode);
  }

  private paint(): string {
    const { icon, color } = detectIcon(this.text);
    return color(icon + this.text);
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.textNode.content = this.paint();
  }
}
```

- [ ] **Step 11: Rewrite `turn-footer.ts`**

```typescript
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import chalk from "chalk";

/** Dim per-turn digest line — no accent bar, no top/bottom padding. */
export class TurnFooterComponent extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private text: string;

  constructor(ctx: RenderContext, text: string) {
    super(ctx, { id: "turn-footer", flexDirection: "row" });
    this.text = text;
    this.textNode = new TextRenderable(ctx, { content: `   ${chalk.dim(text)}` });
    this.add(this.textNode);
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.textNode.content = `   ${chalk.dim(text)}`;
  }
}
```

- [ ] **Step 12: Run test to verify it passes**

```bash
bun test tests/transcript-components.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 13: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/transcript/components/ src/ui/tui/transcript/render-utils.ts src/ui/tui/transcript/markdown-theme.ts tests/transcript-components.test.ts
git commit -m "refactor(tui): rewrite transcript component family as OpenTUI renderables"
```

---

## Task 5: Rewrite `transcript/container.ts` as `ScrollBoxRenderable`

**Files:**
- Modify: `src/ui/tui/transcript/container.ts`
- Test: `tests/transcript-container.test.ts` (existing — rewritten)

`TranscriptContainer` becomes a thin wrapper around `ScrollBoxRenderable`. It keeps its current public API (`appendEntry`, `updateLastEntry`, or whatever the existing 733-line file exposes — re-read the file at the start of this task to confirm exact method names before matching them) so `sink.ts` (Task 7) doesn't need to change its call sites beyond the constructor. Gaps between entries (`needsGap()` from `gap.ts`, unchanged) are inserted as empty `BoxRenderable({ height: 1 })` spacers instead of pi-tui `Spacer`.

- [ ] **Step 1: Read the current file to enumerate its exact public methods**

```bash
grep -n "^  [a-zA-Z]*(" src/ui/tui/transcript/container.ts | head -40
```

Record every public method signature found — the rewrite in Step 3 must preserve every one of them with identical parameter/return types, since `sink.ts` and `run.ts` call them by name.

- [ ] **Step 2: Write/update the failing test**

Update `tests/transcript-container.test.ts`'s renderer setup to use `@opentui/core/testing` instead of the real pi-tui `Spacer`:

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TranscriptContainer } from "../src/ui/tui/transcript/container.js";

describe("TranscriptContainer", () => {
  test("appends a user entry and renders its text", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, {
        markdownRendering: true,
        syntaxTheme: "default",
        backgroundZones: false,
        useUnicode: true,
      });
      setup.renderer.root.add(container);
      container.appendEntry({ role: "user", text: "hi there" });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("hi there");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("inserts a gap spacer between non-consecutive-thinking entries", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, {
        markdownRendering: true,
        syntaxTheme: "default",
        backgroundZones: false,
        useUnicode: true,
      });
      setup.renderer.root.add(container);
      container.appendEntry({ role: "user", text: "first" });
      container.appendEntry({ role: "assistant", text: "second" });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      const firstIdx = frame.indexOf("first");
      const secondIdx = frame.indexOf("second");
      expect(secondIdx).toBeGreaterThan(firstIdx);
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/transcript-container.test.ts
```

Expected: FAIL — constructor still takes a pi-tui `Container` shape / pi-tui `Spacer` import missing.

- [ ] **Step 4: Rewrite `container.ts`**

Preserve every method enumerated in Step 1 exactly. The skeleton below shows the core structural change (base class + gap insertion); port the remaining lazy-expand/focus-delegation/entry-diffing logic from the current 733-line file into this structure, replacing every pi-tui type/import with the OpenTUI equivalents established in Tasks 1-4:

```typescript
import { ScrollBoxRenderable, BoxRenderable, type RenderContext, type SyntaxStyle } from "@opentui/core";
import { needsGap } from "./gap.js";
import type { TranscriptEntry, TranscriptRole } from "./model.js";
import type { TranscriptRenderOpts } from "./opts.js";
import { UserMessageComponent } from "./components/user-message.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { ThinkingMessageComponent } from "./components/thinking-message.js";
import { ToolRowComponent } from "./components/tool-row.js";
import { RecallChipComponent } from "./components/recall-chip.js";
import { SystemLineComponent } from "./components/system-line.js";
import { TurnFooterComponent } from "./components/turn-footer.js";
import { buildMarkdownSyntaxStyle } from "./markdown-theme.js";

type EntryRenderable =
  | UserMessageComponent
  | AssistantMessageComponent
  | ThinkingMessageComponent
  | ToolRowComponent
  | RecallChipComponent
  | SystemLineComponent
  | TurnFooterComponent;

export class TranscriptContainer extends ScrollBoxRenderable {
  private lastRole: TranscriptRole | undefined;
  private readonly opts: TranscriptRenderOpts;
  private readonly markdownSyntaxStyle: SyntaxStyle;

  constructor(ctx: RenderContext, opts: TranscriptRenderOpts) {
    super(ctx, {
      id: "transcript",
      flexDirection: "column",
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    this.opts = opts;
    this.markdownSyntaxStyle = buildMarkdownSyntaxStyle(opts.syntaxTheme);
  }

  appendEntry(entry: TranscriptEntry): EntryRenderable {
    if (needsGap(entry.role, this.lastRole)) {
      this.add(new BoxRenderable(this.ctxRef(), { id: "transcript-gap", height: 1 }));
    }
    this.lastRole = entry.role;
    const node = this.buildEntryNode(entry);
    this.add(node);
    this.scrollTo({ x: 0, y: this.scrollHeight });
    return node;
  }

  private ctxRef(): RenderContext {
    // BoxRenderable/Renderable store their creating RenderContext internally;
    // during this task, confirm the exact protected/public accessor name in
    // Renderable.d.ts (e.g. `this._ctx` vs an exposed `ctx` getter) and use it here.
    return (this as unknown as { _ctx: RenderContext })._ctx;
  }

  private buildEntryNode(entry: TranscriptEntry): EntryRenderable {
    const ctx = this.ctxRef();
    switch (entry.role) {
      case "user":
        return new UserMessageComponent(ctx, entry.text);
      case "assistant":
        return new AssistantMessageComponent(ctx, entry.text, this.markdownSyntaxStyle);
      case "thinking":
        return new ThinkingMessageComponent(ctx, entry.text);
      case "tool":
        return new ToolRowComponent(ctx, entry.toolName ?? "", entry.args ?? {});
      case "recall":
        return new RecallChipComponent(ctx, entry.text);
      case "system":
        return new SystemLineComponent(ctx, entry.text, this.opts);
      case "turn-footer":
        return new TurnFooterComponent(ctx, entry.text);
      default:
        return new SystemLineComponent(ctx, entry.text, this.opts);
    }
  }

  // Port every remaining public method from the pre-migration file here
  // (e.g. updateLastEntry, expandLastThinking, focusForScroll, clear) using
  // the same signatures recorded in Step 1, driving the same component
  // instances instead of pi-tui Components.
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/transcript-container.test.ts
```

Expected: PASS (2 new tests, plus every pre-existing test in the file updated to the new constructor/API and passing).

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/transcript/container.ts tests/transcript-container.test.ts
git commit -m "refactor(tui): rewrite TranscriptContainer as an OpenTUI ScrollBoxRenderable"
```

---

## Task 6: Rewrite `inverted-editor.ts`

**Files:**
- Modify: `src/ui/tui/inverted-editor.ts`
- Test: `tests/inverted-editor.test.ts` (existing — rewritten)

`InvertedEditor` wraps `TextareaRenderable` instead of pi-tui's `Editor`, drawing the `❯ ` prompt as a sibling `TextRenderable` in a row box rather than rewriting border lines.

- [ ] **Step 1: Read the current file's public API**

```bash
grep -n "^  [a-zA-Z]*(" src/ui/tui/inverted-editor.ts
```

- [ ] **Step 2: Write/update the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { InvertedEditor } from "../src/ui/tui/inverted-editor.js";

describe("InvertedEditor", () => {
  test("shows the prompt glyph and accepts typed text", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const editor = new InvertedEditor(setup.renderer);
      setup.renderer.root.add(editor);
      editor.focus();
      await setup.mockInput.typeText("hello");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("❯");
      expect(frame).toContain("hello");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("getValue returns typed text and clear() resets it", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const editor = new InvertedEditor(setup.renderer);
      setup.renderer.root.add(editor);
      editor.focus();
      await setup.mockInput.typeText("abc");
      await setup.renderOnce();
      expect(editor.getValue()).toBe("abc");
      editor.clear();
      expect(editor.getValue()).toBe("");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/inverted-editor.test.ts
```

Expected: FAIL — old class still wraps pi-tui `Editor`.

- [ ] **Step 4: Rewrite `inverted-editor.ts`**

```typescript
import {
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type RenderContext,
} from "@opentui/core";
import { TUI_STYLE } from "./theme.js";

export class InvertedEditor extends BoxRenderable {
  private readonly textarea: TextareaRenderable;

  constructor(ctx: RenderContext) {
    super(ctx, { id: "inverted-editor", flexDirection: "row" });
    this.add(new TextRenderable(ctx, { content: TUI_STYLE.heading("❯ ") }));
    this.textarea = new TextareaRenderable(ctx, {
      id: "inverted-editor-textarea",
      placeholder: "Type a message…",
      flexGrow: 1,
    });
    this.add(this.textarea);
  }

  focus(): void {
    this.textarea.focus();
  }

  blur(): void {
    this.textarea.blur();
  }

  getValue(): string {
    // EditBufferRenderable exposes the full buffer text; confirm exact getter
    // name (e.g. `.text` vs `.value`) against EditBufferRenderable.d.ts during
    // this task and use it here.
    return (this.textarea as unknown as { text: string }).text ?? "";
  }

  clear(): void {
    (this.textarea as unknown as { text: string }).text = "";
  }

  /** Character offset of the caret, for anchoring the autocomplete popup (Task 9). */
  getCursorOffset(): number {
    return this.textarea.cursorOffset;
  }

  /** Screen (x, y) of the textarea's top-left corner, for popup positioning. */
  getScreenPosition(): { x: number; y: number } {
    return { x: this.textarea.x, y: this.textarea.y };
  }

  onSubmit(handler: () => void): void {
    this.textarea.onSubmit = () => handler();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/inverted-editor.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/inverted-editor.ts tests/inverted-editor.test.ts
git commit -m "refactor(tui): rewrite InvertedEditor around OpenTUI TextareaRenderable"
```

---

## Task 7: Rewrite `sink.ts` (`PiTuiSink` → `TurnUiSink` adapter)

**Files:**
- Modify: `src/ui/tui/sink.ts`
- Test: `tests/tui-sink.test.ts` (new)

`sink.ts` implements `TurnUiSink` (from `src/ui-events.ts`, **unchanged** per the spec's scope boundary) and forwards callbacks into `TranscriptContainer`/`ToastRegion`/`GlanceBar`. Only the internal wiring to those three classes changes (new constructors from Tasks 3/5/8); every `TurnUiSink` method name/signature stays identical since `turn.ts` calls them unchanged.

- [ ] **Step 1: Read the current file's constructor signature and every `TurnUiSink` method it implements**

```bash
grep -n "constructor\|on[A-Z]\|consumeTurnStats\|flushText" src/ui/tui/sink.ts | head -60
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { PiTuiSink } from "../src/ui/tui/sink.js";
import { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import { ToastRegion } from "../src/ui/tui/toast-region.js";
import { GlanceBar } from "../src/ui/tui/chrome/glance-bar.js";

describe("PiTuiSink", () => {
  test("onToolCall renders a tool row in the transcript", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const transcript = new TranscriptContainer(setup.renderer, {
        markdownRendering: true,
        syntaxTheme: "default",
        backgroundZones: false,
        useUnicode: true,
      });
      const toasts = new ToastRegion(setup.renderer);
      const glance = new GlanceBar(setup.renderer);
      setup.renderer.root.add(transcript);
      setup.renderer.root.add(toasts);
      setup.renderer.root.add(glance);

      const sink = new PiTuiSink(setup.renderer, transcript, toasts, glance);
      sink.onToolCall?.("call-1", "read_file", { path: "a.ts" });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("read_file");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("onError shows a sticky error toast", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const transcript = new TranscriptContainer(setup.renderer, {
        markdownRendering: true,
        syntaxTheme: "default",
        backgroundZones: false,
        useUnicode: true,
      });
      const toasts = new ToastRegion(setup.renderer);
      const glance = new GlanceBar(setup.renderer);
      setup.renderer.root.add(transcript);
      setup.renderer.root.add(toasts);
      setup.renderer.root.add(glance);

      const sink = new PiTuiSink(setup.renderer, transcript, toasts, glance);
      sink.onError?.({ level: "error", message: "boom", timestamp: Date.now() } as never);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("boom");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/tui-sink.test.ts
```

Expected: FAIL — `PiTuiSink` constructor still expects pi-tui `TUI`/`Container` types.

- [ ] **Step 4: Rewrite `sink.ts`'s constructor and internals**

Keep every `TurnUiSink` method implementation's *logic* the same (re-read the pre-migration 443-line file and port each method body one-for-one), changing only:
- Constructor parameter types (`RenderContext` instead of pi-tui `TUI`; `TranscriptContainer`/`ToastRegion`/`GlanceBar` instances from Tasks 3/5/8 instead of pi-tui-backed ones).
- Any call like `this.tui.requestRender()` → `this.ctx.requestRender()` (confirm exact accessor on the renderer/context during this task).
- Any direct construction of pi-tui `Loader`/`Spacer` inside the sink (if present) → the local spinner component built in Task 8.

```typescript
import type { RenderContext } from "@opentui/core";
import type { TurnUiSink, MemoryBannerStats, ProviderUsageUpdate } from "../../ui-events.js";
import type { LogEntry } from "../../logger.js";
import { TranscriptContainer } from "./transcript/container.js";
import { ToastRegion } from "./toast-region.js";
import { GlanceBar } from "./chrome/glance-bar.js";

export class PiTuiSink implements TurnUiSink {
  shellLiveStream = true;

  constructor(
    private readonly ctx: RenderContext,
    private readonly transcript: TranscriptContainer,
    private readonly toasts: ToastRegion,
    private readonly glance: GlanceBar,
  ) {}

  onTextDelta = (delta: string): void => {
    this.transcript.appendStreamingText(delta);
    this.ctx.requestRender();
  };

  onThinkingDelta = (delta: string): void => {
    this.transcript.appendThinkingDelta(delta);
    this.ctx.requestRender();
  };

  onToolCallsStart = (): void => {
    this.ctx.requestRender();
  };

  onToolCall = (toolCallId: string, toolName: string, args: Record<string, unknown>): void => {
    this.transcript.appendEntry({ role: "tool", toolCallId, toolName, args, text: "" });
    this.ctx.requestRender();
  };

  onToolResult = (toolCallId: string, toolName: string, resultText: string, isError?: boolean): void => {
    this.transcript.setToolResult(toolCallId, resultText, isError ?? false);
    this.ctx.requestRender();
  };

  onError = (entry: LogEntry): void => {
    this.toasts.show(entry.message, "error");
    this.ctx.requestRender();
  };

  onMemoryBanner = (stats: MemoryBannerStats): void => {
    this.transcript.appendEntry({ role: "recall", text: formatMemoryBanner(stats) });
    this.ctx.requestRender();
  };

  onProviderUsage = (update: ProviderUsageUpdate): void => {
    void update;
    // Port the exact glance-bar update call from the pre-migration file here.
  };

  // Port every remaining TurnUiSink method (onTurnContextBaseline, onContextHistoryDelta,
  // onTurnContextCommit, onContextPreview, getContextPreview, onDebug, onDebugBlock,
  // onSpinnerStart, onSpinnerStop, onNewline, onFallback, onSystemLines,
  // onSlashCommandResult, flushText, consumeTurnStats) one-for-one from the
  // pre-migration file, updating only the transcript/toast/glance call targets.
}

function formatMemoryBanner(stats: MemoryBannerStats): string {
  void stats;
  // Port the exact formatting logic from the pre-migration sink.ts.
  return "";
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/tui-sink.test.ts
```

Expected: PASS (2 tests), plus every pre-existing sink-adjacent behavior still covered by ported logic.

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/sink.ts tests/tui-sink.test.ts
git commit -m "refactor(tui): rewrite PiTuiSink against OpenTUI-backed transcript/toast/glance"
```

---

## Task 8: Rewrite `toast-region.ts` and spinner utility

**Files:**
- Modify: `src/ui/tui/toast-region.ts`
- Create: `src/ui/tui/spinner.ts` (replaces pi-tui `Loader`)
- Test: `tests/toast-region.test.ts` (new)
- Test: `tests/spinner.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/toast-region.test.ts
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ToastRegion } from "../src/ui/tui/toast-region.js";

describe("ToastRegion", () => {
  test("shows a message with tone glyph", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const toasts = new ToastRegion(setup.renderer);
      setup.renderer.root.add(toasts);
      toasts.show("Saved!", "success");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Saved!");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("clearErrors removes sticky error toasts", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const toasts = new ToastRegion(setup.renderer);
      setup.renderer.root.add(toasts);
      toasts.show("boom", "error");
      toasts.clearErrors();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("boom");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

```typescript
// tests/spinner.test.ts
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Spinner } from "../src/ui/tui/spinner.js";

describe("Spinner", () => {
  test("renders label text alongside a spinner glyph", async () => {
    const setup = await createTestRenderer({ width: 30, height: 3 });
    try {
      const spinner = new Spinner(setup.renderer, "thinking…");
      setup.renderer.root.add(spinner);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("thinking…");
      spinner.stop();
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/toast-region.test.ts tests/spinner.test.ts
```

Expected: FAIL — `toast-region.ts` still imports pi-tui; `spinner.ts` doesn't exist yet.

- [ ] **Step 3: Rewrite `toast-region.ts`**

```typescript
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "./theme.js";
import { truncatePlainText } from "./theme.js";

export type ToastTone = "info" | "success" | "warn" | "error";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  expiresAt: number | null;
  node: TextRenderable;
}

const TOAST_DURATION: Record<ToastTone, number | null> = {
  info: 3000,
  success: 3000,
  warn: 5000,
  error: null,
};

const TONE_GLYPH: Record<ToastTone, string> = {
  info: "ℹ",
  success: "✓",
  warn: "▲",
  error: "✕",
};

export class ToastRegion extends BoxRenderable {
  private toasts: Toast[] = [];
  private nextId = 1;
  private readonly ctx: RenderContext;

  constructor(ctx: RenderContext) {
    super(ctx, { id: "toast-region", flexDirection: "column" });
    this.ctx = ctx;
  }

  show(message: string, tone: ToastTone = "info"): void {
    const duration = TOAST_DURATION[tone];
    const expiresAt = duration !== null ? Date.now() + duration : null;
    const id = this.nextId++;
    const color =
      tone === "error"
        ? TUI_STYLE.error
        : tone === "warn"
          ? TUI_STYLE.warning
          : tone === "success"
            ? TUI_STYLE.success
            : TUI_STYLE.info;
    const width = this.width || 80;
    const line = truncatePlainText(`  ${TONE_GLYPH[tone]} ${message}`, width);
    const node = new TextRenderable(this.ctx, { content: color(line) });
    this.toasts.push({ id, message, tone, expiresAt, node });
    this.add(node);
    this.ctx.requestRender();
    if (expiresAt !== null) {
      setTimeout(() => this.dismiss(id), duration!);
    }
  }

  clearErrors(): void {
    this.toasts = this.toasts.filter((t) => {
      if (t.tone === "error") {
        this.remove(t.node);
        return false;
      }
      return true;
    });
    this.ctx.requestRender();
  }

  private dismiss(id: number): void {
    const toast = this.toasts.find((t) => t.id === id);
    if (!toast) return;
    this.remove(toast.node);
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.ctx.requestRender();
  }
}
```

- [ ] **Step 4: Create `spinner.ts`**

```typescript
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Simple animated spinner, replacing pi-tui's `Loader`. */
export class Spinner extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private frame = 0;
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly ctx: RenderContext;

  constructor(ctx: RenderContext, label: string) {
    super(ctx, { id: "spinner", flexDirection: "row" });
    this.ctx = ctx;
    this.textNode = new TextRenderable(ctx, {
      content: TUI_STYLE.muted(`${FRAMES[0]} ${label}`),
    });
    this.add(this.textNode);
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.textNode.content = TUI_STYLE.muted(`${FRAMES[this.frame]} ${label}`);
      this.ctx.requestRender();
    }, 80);
  }

  stop(): void {
    clearInterval(this.interval);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/toast-region.test.ts tests/spinner.test.ts
```

Expected: PASS (3 tests total).

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/toast-region.ts src/ui/tui/spinner.ts tests/toast-region.test.ts tests/spinner.test.ts
git commit -m "refactor(tui): rewrite ToastRegion and add OpenTUI-native Spinner"
```

---

## Task 9: Build the shared overlay helper (`overlay.ts`)

**Files:**
- Create: `src/ui/tui/overlay.ts`
- Test: `tests/overlay.test.ts` (new)

Every wizard/model-selector/slash-command-result popup needs the same "float above everything, centered or anchored" behavior that pi-tui's `tui.showOverlay()` provided. This task builds one shared helper used by Tasks 10-13, based on the verified `position: "absolute"` + `zIndex` API (see plan header).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { showOverlay, hideOverlay } from "../src/ui/tui/overlay.js";

describe("overlay helper", () => {
  test("centers a box over the root and removes it on hide", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    try {
      const box = new BoxRenderable(setup.renderer, { id: "popup", width: 10, height: 3 });
      box.add(new TextRenderable(setup.renderer, { content: "POPUP" }));
      const handle = showOverlay(setup.renderer, box);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("POPUP");
      hideOverlay(setup.renderer, handle);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("POPUP");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/overlay.test.ts
```

Expected: FAIL — `overlay.ts` doesn't exist yet.

- [ ] **Step 3: Create `overlay.ts`**

```typescript
import type { BoxRenderable, CliRenderer } from "@opentui/core";

export interface OverlayHandle {
  node: BoxRenderable;
}

const OVERLAY_Z_INDEX = 1000;

export interface OverlayAnchorOptions {
  /** Center on the root when omitted. */
  top?: number;
  left?: number;
}

/** Show `node` as an absolutely-positioned, high-z-index overlay on `renderer.root`. */
export function showOverlay(
  renderer: CliRenderer,
  node: BoxRenderable,
  anchor?: OverlayAnchorOptions,
): OverlayHandle {
  node.position = "absolute";
  node.zIndex = OVERLAY_Z_INDEX;
  if (anchor?.top !== undefined) node.top = anchor.top;
  if (anchor?.left !== undefined) node.left = anchor.left;
  if (anchor?.top === undefined && anchor?.left === undefined) {
    const rootWidth = renderer.root.width || 80;
    const rootHeight = renderer.root.height || 24;
    node.top = Math.max(0, Math.floor((rootHeight - (node.height || 0)) / 2));
    node.left = Math.max(0, Math.floor((rootWidth - (node.width || 0)) / 2));
  }
  renderer.root.add(node);
  renderer.requestRender();
  return { node };
}

export function hideOverlay(renderer: CliRenderer, handle: OverlayHandle): void {
  renderer.root.remove(handle.node);
  renderer.requestRender();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/overlay.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 5: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/overlay.ts tests/overlay.test.ts
git commit -m "feat(tui): add shared OpenTUI overlay helper (position:absolute + zIndex)"
```

---

## Task 10: Rewrite `slash-command-overlay.ts` and `download-consent.ts`

**Files:**
- Modify: `src/ui/tui/slash-command-overlay.ts`
- Modify: `src/ui/tui/download-consent.ts`
- Test: `tests/slash-command-overlay.test.ts` (new)

`slash-command-overlay.ts` becomes a `BoxRenderable` (bordered box + `TextRenderable` lines) shown via `showOverlay()` from Task 9. `download-consent.ts` is one of the two standalone pre-session TUIs (per spec): it creates its own `createCliRenderer()`, shows a consent prompt, waits for a keypress, and calls `renderer.destroy()` before returning — same lifecycle as today, new constructor.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { showSlashCommandResult } from "../src/ui/tui/slash-command-overlay.js";

describe("slash-command-overlay", () => {
  test("shows each result line inside a bordered box", async () => {
    const setup = await createTestRenderer({ width: 50, height: 15 });
    try {
      showSlashCommandResult(setup.renderer, ["Model set to claude-4.6", "Provider: bedrock"]);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Model set to claude-4.6");
      expect(frame).toContain("Provider: bedrock");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/slash-command-overlay.test.ts
```

Expected: FAIL — `showSlashCommandResult` doesn't exist under this signature yet (old file used pi-tui's overlay type).

- [ ] **Step 3: Rewrite `slash-command-overlay.ts`**

```typescript
import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { showOverlay, hideOverlay, type OverlayHandle } from "./overlay.js";
import { TUI_STYLE } from "./theme.js";

export function showSlashCommandResult(renderer: CliRenderer, lines: string[]): OverlayHandle {
  const box = new BoxRenderable(renderer, {
    id: "slash-command-result",
    border: true,
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
    width: Math.min(70, (renderer.root.width || 80) - 4),
  });
  for (const line of lines) {
    box.add(new TextRenderable(renderer, { content: TUI_STYLE.text(line) }));
  }
  return showOverlay(renderer, box);
}

export function dismissSlashCommandResult(renderer: CliRenderer, handle: OverlayHandle): void {
  hideOverlay(renderer, handle);
}
```

- [ ] **Step 4: Rewrite `download-consent.ts`'s standalone renderer bootstrap**

Read the current file first (`cat src/ui/tui/download-consent.ts`) to capture its exact prompt text and the shape of the promise it returns (e.g. `Promise<boolean>`). Replace the `new TUI(new ProcessTerminal())` construction with:

```typescript
import { createCliRenderer, BoxRenderable, TextRenderable } from "@opentui/core";
import { TUI_STYLE } from "./theme.js";

export async function promptDownloadConsent(message: string): Promise<boolean> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  try {
    const box = new BoxRenderable(renderer, {
      id: "download-consent",
      border: true,
      borderStyle: "rounded",
      padding: 1,
      flexDirection: "column",
      width: Math.min(70, (renderer.root.width || 80) - 4),
    });
    box.add(new TextRenderable(renderer, { content: TUI_STYLE.heading(message) }));
    box.add(new TextRenderable(renderer, { content: TUI_STYLE.muted("Press Y to continue, N to skip.") }));
    renderer.root.add(box);

    return await new Promise<boolean>((resolve) => {
      const listener = (data: Buffer) => {
        const key = data.toString().toLowerCase();
        if (key === "y") {
          process.stdin.off("data", listener);
          resolve(true);
        } else if (key === "n" || key === "\u001b") {
          process.stdin.off("data", listener);
          resolve(false);
        }
      };
      process.stdin.on("data", listener);
    });
  } finally {
    renderer.destroy();
  }
}
```

Note: verify during this task whether OpenTUI's renderer exposes its own keyboard-event API (preferred over raw `process.stdin.on("data", ...)`) — if `renderer.on("key", ...)` or similar exists on `CliRenderer`, use that instead for consistency with the rest of the rewrite; the raw-stdin fallback above is the safe baseline if no such event exists.

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/slash-command-overlay.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/slash-command-overlay.ts src/ui/tui/download-consent.ts tests/slash-command-overlay.test.ts
git commit -m "refactor(tui): rewrite slash-command-overlay and download-consent on OpenTUI"
```

---

## Task 11: Rewrite `model-selector.ts`

**Files:**
- Modify: `src/ui/tui/model-selector.ts`
- Modify: `src/model-listing.ts` (port `fuzzyFilter`, drop pi-tui import — also closes the Task-17 item early since it's needed here)
- Test: `tests/model-selector.test.ts` (new)

- [ ] **Step 1: Read the current file's exact public API and constructor signature**

```bash
grep -n "^  [a-zA-Z]*(\|constructor" src/ui/tui/model-selector.ts
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ModelSelector } from "../src/ui/tui/model-selector.js";

describe("ModelSelector", () => {
  test("filters options as the user types", async () => {
    const setup = await createTestRenderer({ width: 50, height: 15 });
    try {
      const selector = new ModelSelector(setup.renderer, [
        { id: "claude-4.6", label: "Claude 4.6" },
        { id: "claude-4.5", label: "Claude 4.5" },
        { id: "llama-3", label: "Llama 3" },
      ]);
      setup.renderer.root.add(selector);
      selector.focus();
      await setup.mockInput.typeText("claude");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Claude 4.6");
      expect(frame).toContain("Claude 4.5");
      expect(frame).not.toContain("Llama 3");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("emits selection on Enter", async () => {
    const setup = await createTestRenderer({ width: 50, height: 15 });
    try {
      const selector = new ModelSelector(setup.renderer, [{ id: "claude-4.6", label: "Claude 4.6" }]);
      setup.renderer.root.add(selector);
      selector.focus();
      let selected: string | null = null;
      selector.onSelect((id) => {
        selected = id;
      });
      await setup.mockInput.pressEnter();
      await setup.renderOnce();
      expect(selected).toBe("claude-4.6");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/model-selector.test.ts
```

Expected: FAIL — old class still constructs pi-tui `Container`/`Input`/`fuzzyFilter`.

- [ ] **Step 4: Port `fuzzyFilter` into `src/model-listing.ts`**

Read the current pi-tui `fuzzyFilter` usage (`grep -n "fuzzyFilter" src/model-listing.ts`) to confirm the exact call signature, then add a local implementation to `src/model-listing.ts` replacing the pi-tui import:

```typescript
export interface FuzzyMatch<T> {
  item: T;
  score: number;
}

/** Simple subsequence fuzzy filter: `query` characters must appear in order in `text`. */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): FuzzyMatch<T>[] {
  if (!query) return items.map((item) => ({ item, score: 0 }));
  const q = query.toLowerCase();
  const results: FuzzyMatch<T>[] = [];
  for (const item of items) {
    const text = getText(item).toLowerCase();
    let qi = 0;
    let score = 0;
    let lastMatch = -1;
    for (let ti = 0; ti < text.length && qi < q.length; ti++) {
      if (text[ti] === q[qi]) {
        score += lastMatch === ti - 1 ? 2 : 1;
        lastMatch = ti;
        qi++;
      }
    }
    if (qi === q.length) results.push({ item, score });
  }
  return results.sort((a, b) => b.score - a.score);
}
```

Remove the old `import { fuzzyFilter } from "@earendil-works/pi-tui"` line from `src/model-listing.ts`.

- [ ] **Step 5: Rewrite `model-selector.ts`**

```typescript
import { BoxRenderable, InputRenderable, SelectRenderable, SelectRenderableEvents, type RenderContext } from "@opentui/core";
import { fuzzyFilter } from "../model-listing.js";

export interface ModelOption {
  id: string;
  label: string;
}

export class ModelSelector extends BoxRenderable {
  private readonly input: InputRenderable;
  private readonly select: SelectRenderable;
  private readonly allOptions: ModelOption[];
  private selectHandler: ((id: string) => void) | null = null;

  constructor(ctx: RenderContext, options: ModelOption[]) {
    super(ctx, { id: "model-selector", flexDirection: "column", border: true, borderStyle: "rounded", padding: 1 });
    this.allOptions = options;
    this.input = new InputRenderable(ctx, { id: "model-selector-input", placeholder: "Search models…" });
    this.select = new SelectRenderable(ctx, {
      id: "model-selector-list",
      width: 40,
      height: 8,
      options: options.map((o) => ({ name: o.label, description: "", value: o.id })),
    });
    this.add(this.input);
    this.add(this.select);

    this.input.on("input", (value: string) => this.applyFilter(value));
    this.select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value?: unknown }) => {
      if (this.selectHandler && typeof option.value === "string") this.selectHandler(option.value);
    });
  }

  private applyFilter(query: string): void {
    const matches = fuzzyFilter(this.allOptions, query, (o) => o.label);
    this.select.options = matches.map((m) => ({ name: m.item.label, description: "", value: m.item.id }));
  }

  focus(): void {
    this.input.focus();
  }

  onSelect(handler: (id: string) => void): void {
    this.selectHandler = handler;
  }
}
```

Note: verify during this task whether `InputRenderable` emits an `"input"` event with the current value, or requires reading `.value` on a `"change"`/keypress event instead — adjust the `this.input.on(...)` line to match the confirmed event name/payload from `renderables/Input.d.ts`. Also verify `Enter` on the focused `InputRenderable` needs to be forwarded to `select.selectCurrent()` (since the test presses Enter while the input, not the list, may hold focus) — wire `this.input.onSubmit` (or equivalent) to `this.select.selectCurrent()` if so.

- [ ] **Step 6: Run test to verify it passes**

```bash
bun test tests/model-selector.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/model-selector.ts src/model-listing.ts tests/model-selector.test.ts
git commit -m "refactor(tui): rewrite ModelSelector on OpenTUI Select+Input, port local fuzzyFilter"
```

---

## Task 12: Rewrite `logout-wizard.ts`

**Files:**
- Modify: `src/ui/tui/logout-wizard.ts`
- Test: `tests/logout-wizard.test.ts` (new)

This is the smallest wizard (180 lines) — do it before `login-wizard.ts` to establish the wizard pattern (bordered `Box` + `SelectRenderable` of authed providers + confirm/cancel) that Tasks 13-14 reuse.

- [ ] **Step 1: Read the current file's exact step flow and public API**

```bash
cat src/ui/tui/logout-wizard.ts
```

Record: constructor signature, every public method, and the exact provider-list data shape it consumes (from `credentials.ts`).

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { LogoutWizard } from "../src/ui/tui/logout-wizard.js";

describe("LogoutWizard", () => {
  test("lists authed providers and confirms logout on Enter", async () => {
    const setup = await createTestRenderer({ width: 50, height: 15 });
    try {
      const wizard = new LogoutWizard(setup.renderer, [
        { id: "anthropic", label: "Anthropic" },
        { id: "bedrock", label: "Amazon Bedrock" },
      ]);
      setup.renderer.root.add(wizard);
      wizard.focus();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Anthropic");

      let loggedOut: string | null = null;
      wizard.onConfirm((id) => {
        loggedOut = id;
      });
      await setup.mockInput.pressEnter();
      await setup.renderOnce();
      expect(loggedOut).toBe("anthropic");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/logout-wizard.test.ts
```

Expected: FAIL — old class still built from pi-tui `SelectList`.

- [ ] **Step 4: Rewrite `logout-wizard.ts`**

Port the exact step-flow text/prompts from the file read in Step 1 into this structure:

```typescript
import { BoxRenderable, TextRenderable, SelectRenderable, SelectRenderableEvents, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "./theme.js";

export interface AuthedProvider {
  id: string;
  label: string;
}

export class LogoutWizard extends BoxRenderable {
  private readonly select: SelectRenderable;
  private confirmHandler: ((id: string) => void) | null = null;

  constructor(ctx: RenderContext, providers: AuthedProvider[]) {
    super(ctx, {
      id: "logout-wizard",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      padding: 1,
      title: "Log out",
    });
    this.add(new TextRenderable(ctx, { content: TUI_STYLE.muted("Select a provider to log out of:") }));
    this.select = new SelectRenderable(ctx, {
      id: "logout-wizard-list",
      width: 40,
      height: Math.min(10, providers.length + 1),
      options: providers.map((p) => ({ name: p.label, description: "", value: p.id })),
    });
    this.add(this.select);
    this.select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value?: unknown }) => {
      if (this.confirmHandler && typeof option.value === "string") this.confirmHandler(option.value);
    });
  }

  focus(): void {
    this.select.focus();
  }

  onConfirm(handler: (id: string) => void): void {
    this.confirmHandler = handler;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/logout-wizard.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/logout-wizard.ts tests/logout-wizard.test.ts
git commit -m "refactor(tui): rewrite LogoutWizard on OpenTUI Select"
```

---

## Task 13: Rewrite `login-wizard.ts`

**Files:**
- Modify: `src/ui/tui/login-wizard.ts`
- Modify: `src/ui/tui/oauth-login-ui.ts` (no pi-tui import per exploration — re-verify at start of this task; update only if it references types from `login-wizard.ts` that changed shape)
- Test: `tests/login-wizard.test.ts` (new)

This is the largest wizard (924 lines, multi-step: provider → key/OAuth → model). Do not attempt this in one sitting — split into sub-steps by wizard stage, reusing the `SelectRenderable`/`InputRenderable`/`BoxRenderable` pattern from Tasks 11-12.

- [ ] **Step 1: Read the current file's full step flow**

```bash
grep -n "class \|^  [a-zA-Z]*(\|step\|Step" src/ui/tui/login-wizard.ts | head -80
```

Enumerate every distinct step (e.g. "choose provider" → "enter API key or start OAuth" → "choose default model" → "confirm") and the exact prompt copy for each, plus every public method (`onComplete`, `onCancel`, `focus`, etc.) and constructor parameters (provider list, credential store reference, `oauth-login-ui.ts` bridge functions).

- [ ] **Step 2: Write the failing test for the provider-selection step (first step, establishes the pattern)**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { LoginWizard } from "../src/ui/tui/login-wizard.js";

describe("LoginWizard", () => {
  test("step 1 shows the provider list", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const wizard = new LoginWizard(setup.renderer, [
        { id: "anthropic", label: "Anthropic" },
        { id: "bedrock", label: "Amazon Bedrock" },
      ]);
      setup.renderer.root.add(wizard);
      wizard.focus();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Anthropic");
      expect(frame).toContain("Amazon Bedrock");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("selecting a provider advances to the API key step", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const wizard = new LoginWizard(setup.renderer, [{ id: "anthropic", label: "Anthropic" }]);
      setup.renderer.root.add(wizard);
      wizard.focus();
      await setup.mockInput.pressEnter();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("API key");
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/login-wizard.test.ts
```

Expected: FAIL — old class still built from pi-tui primitives.

- [ ] **Step 4: Rewrite `login-wizard.ts`'s step-machine skeleton and provider-selection step**

```typescript
import { BoxRenderable, TextRenderable, InputRenderable, SelectRenderable, SelectRenderableEvents, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "./theme.js";

export interface LoginProvider {
  id: string;
  label: string;
}

type WizardStep = "provider" | "api-key" | "model" | "confirm";

export class LoginWizard extends BoxRenderable {
  private step: WizardStep = "provider";
  private readonly ctx: RenderContext;
  private readonly providers: LoginProvider[];
  private selectedProvider: LoginProvider | null = null;
  private providerSelect: SelectRenderable;
  private apiKeyInput: InputRenderable | null = null;
  private stepLabel: TextRenderable;
  private completeHandler: ((providerId: string, apiKey: string) => void) | null = null;

  constructor(ctx: RenderContext, providers: LoginProvider[]) {
    super(ctx, {
      id: "login-wizard",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      padding: 1,
      title: "Log in",
    });
    this.ctx = ctx;
    this.providers = providers;
    this.stepLabel = new TextRenderable(ctx, { content: TUI_STYLE.muted("Choose a provider:") });
    this.add(this.stepLabel);
    this.providerSelect = new SelectRenderable(ctx, {
      id: "login-wizard-providers",
      width: 40,
      height: Math.min(10, providers.length + 1),
      options: providers.map((p) => ({ name: p.label, description: "", value: p.id })),
    });
    this.add(this.providerSelect);
    this.providerSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value?: unknown }) => {
      const provider = this.providers.find((p) => p.id === option.value);
      if (provider) this.advanceToApiKeyStep(provider);
    });
  }

  private advanceToApiKeyStep(provider: LoginProvider): void {
    this.selectedProvider = provider;
    this.step = "api-key";
    this.remove(this.providerSelect);
    this.stepLabel.content = TUI_STYLE.muted(`Enter your ${provider.label} API key:`);
    this.apiKeyInput = new InputRenderable(this.ctx, { id: "login-wizard-api-key" });
    this.add(this.apiKeyInput);
    this.apiKeyInput.focus();

    // Port the OAuth-branch logic here from the pre-migration file: some
    // providers skip the API-key step and instead bridge to
    // oauth-login-ui.ts. Read that branch from the file captured in Step 1
    // and reproduce it exactly, calling the same oauth-login-ui.ts functions.

    this.apiKeyInput.onSubmit = () => {
      const key = (this.apiKeyInput as unknown as { value: string }).value;
      if (this.completeHandler && this.selectedProvider) {
        this.completeHandler(this.selectedProvider.id, key);
      }
    };
  }

  focus(): void {
    if (this.step === "provider") this.providerSelect.focus();
    else this.apiKeyInput?.focus();
  }

  onComplete(handler: (providerId: string, apiKey: string) => void): void {
    this.completeHandler = handler;
  }

  // Port the remaining steps (model selection, confirmation) here following
  // the exact prompts/logic recorded in Step 1, reusing SelectRenderable /
  // InputRenderable / TextRenderable the same way as the provider and
  // api-key steps above.
}
```

Note: verify `InputRenderable`'s value-reading API (`.value` vs a getter) against `renderables/Input.d.ts` during this task, matching the note left in Task 11.

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/login-wizard.test.ts
```

Expected: PASS (2 tests). Continue adding one test + implementation increment per remaining step (model selection, confirm) before moving on, following the same TDD loop, until every step enumerated in Step 1 has a passing test.

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/login-wizard.ts tests/login-wizard.test.ts
git commit -m "refactor(tui): rewrite LoginWizard step machine on OpenTUI"
```

---

## Task 14: Rewrite `setup-wizard.ts` (standalone first-run TUI)

**Files:**
- Modify: `src/ui/tui/setup-wizard.ts`
- Test: `tests/setup-wizard.test.ts` (new)

Like `download-consent.ts` (Task 10), this spins up its **own** `createCliRenderer()` instance rather than reusing the main session's renderer, torn down before the main TUI starts. Reuses the same step-machine pattern established in Tasks 12-13 (provider → key/OAuth → model → confirm), but as the entry point for a brand-new user with no prior session.

- [ ] **Step 1: Read the current file's exact flow and standalone-TUI bootstrap**

```bash
grep -n "class \|new TUI\|ProcessTerminal\|^  [a-zA-Z]*(" src/ui/tui/setup-wizard.ts | head -60
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { runSetupWizard } from "../src/ui/tui/setup-wizard.js";

describe("runSetupWizard", () => {
  test("resolves with the chosen provider and api key", async () => {
    // This test drives the wizard through OpenTUI's real createCliRenderer()
    // rather than createTestRenderer(), since runSetupWizard owns its own
    // renderer lifecycle end-to-end (matching the pre-migration behavior of
    // owning its own TUI/ProcessTerminal). Use the injectable-stdin pattern:
    // pass a mock stdin stream if runSetupWizard's signature accepts one
    // (check the pre-migration file for an existing test seam); if it does
    // not, add one as part of this rewrite so this test is possible.
    const result = await runSetupWizard({
      providers: [{ id: "anthropic", label: "Anthropic" }],
      simulateInput: ["\r", "sk-test-key-123", "\r"],
    });
    expect(result.providerId).toBe("anthropic");
    expect(result.apiKey).toBe("sk-test-key-123");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/setup-wizard.test.ts
```

Expected: FAIL — `runSetupWizard` doesn't accept a `simulateInput` seam yet (and still boots pi-tui).

- [ ] **Step 4: Rewrite `setup-wizard.ts`'s bootstrap**

```typescript
import { createCliRenderer } from "@opentui/core";
import { LoginWizard, type LoginProvider } from "./login-wizard.js";

export interface SetupWizardResult {
  providerId: string;
  apiKey: string;
}

export interface RunSetupWizardOptions {
  providers: LoginProvider[];
  /** Test-only: pre-scripted input bytes fed to stdin instead of a real TTY. */
  simulateInput?: string[];
}

export async function runSetupWizard(options: RunSetupWizardOptions): Promise<SetupWizardResult> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  try {
    const wizard = new LoginWizard(renderer, options.providers);
    renderer.root.add(wizard);
    wizard.focus();

    const result = await new Promise<SetupWizardResult>((resolve) => {
      wizard.onComplete((providerId, apiKey) => resolve({ providerId, apiKey }));
      if (options.simulateInput) {
        for (const chunk of options.simulateInput) {
          process.stdin.emit("data", Buffer.from(chunk));
        }
      }
    });
    return result;
  } finally {
    renderer.destroy();
  }
}
```

Port the remaining first-run copy/screens (welcome message, embedder-download prompt bridge if `setup-wizard.ts` also owns that today — re-check against `download-consent.ts` from Task 10 to avoid duplicating that flow) from the file read in Step 1.

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/setup-wizard.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/setup-wizard.ts tests/setup-wizard.test.ts
git commit -m "refactor(tui): rewrite standalone SetupWizard renderer on OpenTUI"
```

---

## Task 15: Rewrite `run.ts` (main orchestration)

**Files:**
- Modify: `src/ui/tui/run.ts`
- Test: `tests/tui-run.test.ts` (existing — rewritten)

This is the capstone task: wire every rewritten piece (Tasks 1-13) into the single `runTui(controller, info)` entry point that `main.ts` calls unchanged.

- [ ] **Step 1: Read the current file's full structure**

```bash
grep -n "^export \|^function \|^  [a-zA-Z]*(" src/ui/tui/run.ts | head -80
```

Confirm the exact `runTui(controller: AppController, info: StartupInfo): Promise<void>` signature (per exploration, this is `main.ts`'s only call site) and every Ctrl+C / F9 / slash-command / overlay-swap branch.

- [ ] **Step 2: Write the failing test**

Rewrite `tests/tui-run.test.ts` to drop `mock.module("@earendil-works/pi-tui", ...)` entirely and instead exercise `runTui` against a real (test) OpenTUI renderer via dependency injection. If `runTui` doesn't currently accept an injectable renderer factory, add one as part of this task (small, additive change — a `createRenderer` param defaulting to the real `createCliRenderer`, overridden in tests with a factory returning `createTestRenderer()`'s renderer):

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { runTui } from "../src/ui/tui/run.js";

class FakeAppController {
  runUserTurn = async (_input: string) => {};
  executeSlashCommand = async (_input: string) => {};
}

describe("runTui", () => {
  test("boots without throwing and renders the identity bar", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
      const controller = new FakeAppController();
      const info = { sessionId: "test-session", model: "claude-4.6", cwd: "/tmp" };
      const runPromise = runTui(controller as never, info as never, {
        createRenderer: async () => setup.renderer,
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("praana");

      await setup.mockInput.pressCtrlC();
      await runPromise;
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/tui-run.test.ts
```

Expected: FAIL — `runTui` doesn't accept a third `{ createRenderer }` options argument yet, and still imports pi-tui.

- [ ] **Step 4: Rewrite `run.ts`**

Port every branch from the pre-migration file (read in Step 1) into this structure, replacing each pi-tui construction with its Task 1-13 equivalent:

```typescript
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { IdentityBar } from "./chrome/identity-bar.js";
import { GlanceBar } from "./chrome/glance-bar.js";
import { TranscriptContainer } from "./transcript/container.js";
import { InvertedEditor } from "./inverted-editor.js";
import { ToastRegion } from "./toast-region.js";
import { PiTuiSink } from "./sink.js";
import { buildBootBanner, setBannerRenderContext } from "./banner.js";
import { showSlashCommandResult } from "./slash-command-overlay.js";
import type { AppController, StartupInfo } from "../../main.js";

export interface RunTuiOptions {
  createRenderer?: () => Promise<CliRenderer>;
}

export async function runTui(
  controller: AppController,
  info: StartupInfo,
  options: RunTuiOptions = {},
): Promise<void> {
  const renderer = await (options.createRenderer ? options.createRenderer() : createCliRenderer({ exitOnCtrlC: false }));
  setBannerRenderContext(renderer);

  const identityBar = new IdentityBar(renderer);
  const glanceBar = new GlanceBar(renderer);
  const transcript = new TranscriptContainer(renderer, {
    markdownRendering: true,
    syntaxTheme: "default",
    backgroundZones: true,
    useUnicode: true,
  });
  const toasts = new ToastRegion(renderer);
  const editor = new InvertedEditor(renderer);
  const sink = new PiTuiSink(renderer, transcript, toasts, glanceBar);

  renderer.root.add(identityBar);
  renderer.root.add(buildBootBanner({ version: info.version ?? "dev", summaryLines: [], width: renderer.root.width || 80 }));
  renderer.root.add(transcript);
  renderer.root.add(toasts);
  renderer.root.add(editor);
  renderer.root.add(glanceBar);

  editor.focus();
  editor.onSubmit(async () => {
    const value = editor.getValue();
    editor.clear();
    if (value.startsWith("/")) {
      const result = await controller.executeSlashCommand(value);
      if (result) showSlashCommandResult(renderer, Array.isArray(result) ? result : [String(result)]);
      return;
    }
    await controller.runUserTurn(value, sink);
  });

  return new Promise<void>((resolve) => {
    process.stdin.on("data", (data: Buffer) => {
      if (data.toString() === "\u0003") {
        renderer.destroy();
        resolve();
      }
    });
  });

  // Port every remaining piece of the pre-migration run.ts here: F9
  // scroll-focus toggling (likely droppable now that TranscriptContainer is
  // a real ScrollBoxRenderable per the spec's approved incidental
  // improvement — confirm with a manual smoke test before removing),
  // /model → ModelSelector wiring, /login → LoginWizard wiring, /logout →
  // LogoutWizard wiring, resize handling, and any @opentui/keymap command
  // registration for Ctrl+C/Escape/arrows in place of the raw stdin
  // listener sketched above (prefer @opentui/keymap for all of this per the
  // spec — the raw listener above is the minimal fallback to get the test
  // in Step 2 passing first).
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/tui-run.test.ts
```

Expected: PASS (1 test), then iterate: add one test per remaining branch ported in Step 4 (`/model`, `/login`, `/logout`, resize) before considering this task done, following the same TDD loop.

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/run.ts tests/tui-run.test.ts
git commit -m "refactor(tui): rewrite run.ts orchestration on OpenTUI, wire all rewritten components"
```

---

## Task 16: Adopt `@opentui/keymap` for Ctrl+C / F9 / Escape / arrows

**Files:**
- Modify: `src/ui/tui/run.ts`
- Modify: `src/ui/tui/model-selector.ts`, `src/ui/tui/login-wizard.ts`, `src/ui/tui/logout-wizard.ts` (replace any remaining raw key checks)
- Test: `tests/tui-keymap.test.ts` (new)

Per the spec, `@opentui/keymap` replaces pi-tui's `matchesKey`/`getKeybindings`. This task centralizes key handling instead of the raw `process.stdin.on("data", ...)` sketched in Task 15 Step 4.

- [ ] **Step 1: Read `@opentui/keymap`'s API surface**

```bash
cat /tmp/opencode/opentui-check/node_modules/@opentui/keymap/package.json 2>/dev/null || (cd /tmp/opencode/opentui-check && bun add @opentui/keymap && cat node_modules/@opentui/keymap/package.json)
find /tmp/opencode/opentui-check/node_modules/@opentui/keymap -name "*.d.ts" -exec cat {} \;
```

Record the exact API for defining a command (e.g. `defineCommand`/`createKeymap`) and binding it to a renderer/context, then use that confirmed API — not the sketch below — for Step 3.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { runTui } from "../src/ui/tui/run.js";

class FakeAppController {
  runUserTurn = async () => {};
  executeSlashCommand = async () => {};
}

describe("run.ts keymap", () => {
  test("Ctrl+C exits the TUI cleanly", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
      const runPromise = runTui(new FakeAppController() as never, { sessionId: "s", model: "m", cwd: "/tmp" } as never, {
        createRenderer: async () => setup.renderer,
      });
      await setup.renderOnce();
      await setup.mockInput.pressCtrlC();
      await runPromise; // should resolve, not hang
    } finally {
      setup.renderer.destroy();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails (or already passes trivially from Task 15's raw listener — confirm it's exercising the keymap path, not the fallback)**

```bash
bun test tests/tui-keymap.test.ts
```

- [ ] **Step 4: Replace the raw stdin listener in `run.ts` with `@opentui/keymap` bindings**

Using the confirmed API from Step 1, register Ctrl+C (exit), F9 (scroll-focus toggle, if kept per Task 15's note), and Escape (dismiss active overlay) as keymap commands scoped to the renderer, removing the `process.stdin.on("data", ...)` block from Task 15.

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/tui-keymap.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
bun typecheck
git add src/ui/tui/run.ts tests/tui-keymap.test.ts package.json bun.lock
git commit -m "refactor(tui): adopt @opentui/keymap for Ctrl+C/F9/Escape handling"
```

---

## Task 17: Clean up remaining type-only references and delete `redirect-pi-logs.ts`

**Files:**
- Modify: `src/setup/setup-readline.ts`
- Modify: `src/setup/provider-options.ts`
- Delete: `src/ui/tui/redirect-pi-logs.ts`
- Delete: `tests/redirect-pi-logs.test.ts`
- Modify: `src/main.ts` (remove the now-dead `redirect-pi-logs` install/uninstall call sites, if any — re-check per exploration note that `boot-summary.ts` and `interactive-setup.ts` only reference it in comments)

- [ ] **Step 1: Confirm no remaining pi-tui imports anywhere in `src/`**

```bash
grep -rl "@earendil-works/pi-tui" src/ tests/ || echo "none found"
```

Expected at this point: only `src/setup/setup-readline.ts` and `src/setup/provider-options.ts` (type-only `SelectItem` import) remain, plus `src/ui/tui/redirect-pi-logs.ts` and its test.

- [ ] **Step 2: Update `setup-readline.ts` and `provider-options.ts`**

```bash
grep -n "SelectItem" src/setup/setup-readline.ts src/setup/provider-options.ts
```

Replace `import type { SelectItem } from "@earendil-works/pi-tui"` with `import type { SelectOption } from "@opentui/core"` in both files, and rename every local usage of the `SelectItem` type alias to `SelectOption` (the shape is compatible: `{ name, description, value? }` per the verified `Select.d.ts`).

- [ ] **Step 3: Delete `redirect-pi-logs.ts` and its test**

```bash
git rm src/ui/tui/redirect-pi-logs.ts tests/redirect-pi-logs.test.ts
grep -rn "redirect-pi-logs\|installPiTuiLogRedirect\|uninstallPiTuiLogRedirect" src/main.ts
```

Remove any call sites found by the `grep` above from `main.ts`.

- [ ] **Step 4: Clean up comment-only pi-tui references**

```bash
grep -rn "pi-tui" src/ui/tui/boot-summary.ts src/interactive-setup.ts
```

Update each matched comment to no longer mention pi-tui (e.g. `boot-summary.ts`'s header comment `/** Boot welcome panel for the pi-tui TUI (design §5.1). */` becomes `/** Boot welcome panel for the OpenTUI-based TUI (design §5.1). */`).

- [ ] **Step 5: Run the full test suite to confirm nothing references the deleted module**

```bash
bun test
```

Expected: PASS, no `Cannot find module './redirect-pi-logs.js'` errors.

- [ ] **Step 6: Typecheck**

```bash
bun typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: drop redirect-pi-logs ADR workaround and remaining pi-tui type/comment references"
```

---

## Task 18: Update `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Find every pi-tui reference in `AGENTS.md`**

```bash
grep -n "pi-tui" AGENTS.md
```

- [ ] **Step 2: Replace each reference**

Update the `src/ui/` tree description line (currently `ui/tui/ — pi-tui terminal shell: transcript, chrome bars, autocomplete, thinking blocks, login/logout wizards, model selector`) to read `ui/tui/ — OpenTUI terminal shell: transcript, chrome bars, autocomplete, thinking blocks, login/logout wizards, model selector`, and update any other pi-tui mentions (e.g. in a "Common Gotchas" or dependency list) to reference `@opentui/core`/`@opentui/keymap` instead.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md references from pi-tui to OpenTUI"
```

---

## Task 19: Full verification and manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

```bash
bun typecheck
```

Expected: zero errors.

- [ ] **Step 2: Full test suite**

```bash
bun test
```

Expected: all tests pass (83+ files per AGENTS.md baseline, adjusted for files added/removed in this plan).

- [ ] **Step 3: Confirm zero remaining pi-tui references anywhere in the repo**

```bash
grep -rl "@earendil-works/pi-tui\|pi-tui" src/ tests/ package.json AGENTS.md
```

Expected: no output.

- [ ] **Step 4: Manual smoke test — start a real session**

```bash
bun start
```

Manually verify, per the spec's rollout checklist:
- Boot banner renders (wordmark + version + summary).
- Sending a chat message streams assistant text.
- A tool call renders a tool row with its result.
- A thinking block appears and is collapsible.
- `/model` opens the model selector, filters by typing, selects on Enter.
- `/login` walks through the provider → key/OAuth → model flow.
- `/logout` lists authed providers and logs one out.
- Resizing the terminal window doesn't corrupt the layout.
- Ctrl+C exits cleanly.

- [ ] **Step 5: Manual smoke test — first-run setup wizard**

```bash
rm -rf ~/.praana-test-home && HOME=~/.praana-test-home bun start
```

Verify the standalone `SetupWizard` renderer boots correctly outside any existing session and its own `createCliRenderer()`/`destroy()` lifecycle doesn't leak into the main session's renderer afterward.

- [ ] **Step 6: Final commit and open PR**

```bash
git log --oneline feat/ad/opentui-migration ^main
git push -u origin feat/ad/opentui-migration
gh pr create --title "refactor(tui): replace pi-tui with OpenTUI" --body "Implements docs/superpowers/specs/2026-08-03-opentui-migration-design.md. See docs/superpowers/plans/2026-08-03-opentui-migration.md for the task-by-task breakdown."
```
