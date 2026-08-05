# Slash Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline slash-command autocomplete popup with a centered, on-theme command palette overlay (list + detail pane).

**Architecture:** New `"palette"` overlay kind alongside `model`/`login`/`logout`. Prompt fires `onSlashTrigger` when the buffer becomes exactly `/`; the palette owns query/filter/selection; selection either runs the command through the existing slash dispatch (extracted as `runSlashCommand`) or seeds the prompt. Path completion keeps the inline popup.

**Tech Stack:** Bun, TypeScript strict, Solid + OpenTUI, bun:test.

**Spec:** `docs/superpowers/specs/2026-08-05-slash-command-palette-design.md`

**Branch:** all work commits to `feat/ad/opentui-solid` (user directive — no new branch).

---

### Task 1: `category` on `SlashCommandMeta`

**Files:**
- Modify: `src/slash-commands.ts:66-71` (interface) and `:72-97` (metadata entries)
- Test: `tests/palette-items.test.ts` (new — created here, extended in Task 2)

- [ ] **Step 1: Write the failing test**

Create `tests/palette-items.test.ts`:

```ts
/**
 * Slash palette pure logic: item building, fuzzy filtering, smart-run rule,
 * metadata category coverage.
 */
import { describe, expect, it } from "bun:test";
import { SLASH_COMMAND_METADATA } from "../src/slash-commands.js";

const VALID_CATEGORIES = ["Session", "Memory", "Model & Config", "Tools", "Insight"];

describe("slash metadata categories", () => {
  it("every command has a valid category", () => {
    for (const meta of SLASH_COMMAND_METADATA) {
      expect(VALID_CATEGORIES).toContain(meta.category);
    }
  });

  it("every category is non-empty", () => {
    const used = new Set(SLASH_COMMAND_METADATA.map((m) => m.category));
    for (const c of VALID_CATEGORIES) expect(used.has(c as never)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/palette-items.test.ts`
Expected: FAIL — TypeScript error / `meta.category` undefined (`toContain(undefined)` fails).

- [ ] **Step 3: Add `category` to the interface and all 24 entries**

In `src/slash-commands.ts`, change the interface (line 66-71):

```ts
export type SlashCommandCategory =
  | "Session"
  | "Memory"
  | "Model & Config"
  | "Tools"
  | "Insight";

export interface SlashCommandMeta {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  category: SlashCommandCategory;
}
```

Add `category` to every entry in `SLASH_COMMAND_METADATA` per this mapping:

- `Session`: `/exit`, `/new`, `/clear`, `/sessions`
- `Memory`: `/recall`, `/digest`, `/memory`, `/incognito`
- `Model & Config`: `/model`, `/reasoning`, `/thinking`, `/settings`, `/setup`, `/login`, `/logout`
- `Tools`: `/shell`, `/plan`, `/debug`
- `Insight`: `/state`, `/stats`, `/scorecard`, `/events`, `/why`, `/help`

Example entry: `{ name: "/exit", description: "End session", aliases: ["/quit"], category: "Session" },`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/palette-items.test.ts && bun typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/slash-commands.ts tests/palette-items.test.ts
git commit -m "feat: add category to slash command metadata"
```

---

### Task 2: `palette-items.ts` pure logic

**Files:**
- Create: `src/ui/tui/overlays/palette-items.ts`
- Test: `tests/palette-items.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `tests/palette-items.test.ts`:

```ts
import {
  buildPaletteItems,
  commandNeedsArgument,
  filterPaletteItems,
} from "../src/ui/tui/overlays/palette-items.js";

describe("palette-items", () => {
  const items = buildPaletteItems(SLASH_COMMAND_METADATA);

  it("builds one item per canonical command (aliases folded in)", () => {
    expect(items.length).toBe(SLASH_COMMAND_METADATA.length);
    const exit = items.find((i) => i.name === "/exit");
    expect(exit?.aliases).toEqual(["/quit"]);
    expect(items.some((i) => i.name === "/quit")).toBe(false);
  });

  it("bare query returns curated metadata order", () => {
    const all = filterPaletteItems(items, "");
    expect(all.map((i) => i.name)).toEqual(items.map((i) => i.name));
  });

  it("fuzzy-matches on name", () => {
    const r = filterPaletteItems(items, "rec");
    expect(r[0]?.name).toBe("/recall");
  });

  it("matches via alias", () => {
    const r = filterPaletteItems(items, "qui");
    expect(r.some((i) => i.name === "/exit")).toBe(true);
  });

  it("no match returns empty", () => {
    expect(filterPaletteItems(items, "zzzzzz")).toEqual([]);
  });

  it("commandNeedsArgument: only required `<...>` hints", () => {
    const byName = (n: string) => items.find((i) => i.name === n)!;
    expect(commandNeedsArgument(byName("/recall"))).toBe(true);   // <query>
    expect(commandNeedsArgument(byName("/shell"))).toBe(true);    // <command>
    expect(commandNeedsArgument(byName("/why"))).toBe(true);      // <unit-id>
    expect(commandNeedsArgument(byName("/model"))).toBe(false);   // [provider] <id>
    expect(commandNeedsArgument(byName("/thinking"))).toBe(false); // on|off
    expect(commandNeedsArgument(byName("/help"))).toBe(false);    // no hint
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/palette-items.test.ts`
Expected: FAIL — module `palette-items.js` not found.

- [ ] **Step 3: Implement `palette-items.ts`**

Create `src/ui/tui/overlays/palette-items.ts`:

```ts
/**
 * Pure logic for the slash command palette: item building, fuzzy filtering,
 * and the smart-run rule. No Solid/OpenTUI imports — unit-testable.
 */
import { fuzzyFilter } from "../../../model-listing.js";
import type { SlashCommandMeta } from "../../../slash-commands.js";

export interface PaletteItem {
  name: string;
  description: string;
  argumentHint?: string;
  aliases: string[];
  category: string;
}

/** One palette item per canonical command; aliases are folded into the item. */
export function buildPaletteItems(
  metadata: readonly SlashCommandMeta[],
): PaletteItem[] {
  return metadata.map((m) => ({
    name: m.name,
    description: m.description,
    argumentHint: m.argumentHint,
    aliases: m.aliases ?? [],
    category: m.category,
  }));
}

/** Bare query preserves curated metadata order; otherwise fuzzy over name + aliases. */
export function filterPaletteItems(
  items: PaletteItem[],
  query: string,
): PaletteItem[] {
  const q = query.trim();
  if (!q) return items;
  return fuzzyFilter(items, q, (i) => `${i.name} ${i.aliases.join(" ")}`);
}

/** Smart-run rule: only commands with a required `<...>` argument insert into the prompt. */
export function commandNeedsArgument(item: PaletteItem): boolean {
  return item.argumentHint?.startsWith("<") ?? false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/palette-items.test.ts && bun typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/overlays/palette-items.ts tests/palette-items.test.ts
git commit -m "feat: palette item building, fuzzy filter, smart-run rule"
```

---

### Task 3: Overlay state — `"palette"` kind

**Files:**
- Modify: `src/ui/tui/overlays/state.ts`
- Test: `tests/overlay-state.test.ts`

- [ ] **Step 1: Extend the failing test first**

In `tests/overlay-state.test.ts`, inside the existing `it("cycles ...")`, after the `showLogout` assertion add:

```ts
    ui.showPalette();
    expect(ui.kind()).toBe("palette");
```

(The `dismiss()` assertions after it already cover dismissal.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/overlay-state.test.ts`
Expected: FAIL — `ui.showPalette is not a function`.

- [ ] **Step 3: Implement**

In `src/ui/tui/overlays/state.ts`:
- Line 6: `export type OverlayKind = "none" | "slash" | "model" | "login" | "logout" | "palette";`
- `OverlayUi` interface: add `showPalette(): void;` (after `showLogout`).
- Implementation, after `showLogout()`:

```ts
      showPalette() {
        setKind("palette");
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/overlay-state.test.ts && bun typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/overlays/state.ts tests/overlay-state.test.ts
git commit -m "feat: add palette overlay kind"
```

---

### Task 4: `OverlayFrame` theme props

**Files:**
- Modify: `src/ui/tui/overlays/frame.tsx`

The palette needs on-palette surfaces; the frame currently hardcodes `#1a1a1a`/`#888888`. Add optional props with today's values as defaults (model/login/logout unchanged).

- [ ] **Step 1: Implement (no behavior change — typecheck gate)**

In `frame.tsx`, widen props and use them:

```ts
export function OverlayFrame(props: {
  children: JSX.Element;
  width?: number;
  maxHeight?: number;
  backgroundColor?: string;
  borderColor?: string;
}) {
```

In the returned `<box>`, replace `borderColor="#888888"` with `borderColor={props.borderColor ?? "#888888"}` and `backgroundColor="#1a1a1a"` with `backgroundColor={props.backgroundColor ?? "#1a1a1a"}`.

- [ ] **Step 2: Verify**

Run: `bun typecheck && bun test`
Expected: clean; suite green (no visual change for existing overlays).

- [ ] **Step 3: Commit**

```bash
git add src/ui/tui/overlays/frame.tsx
git commit -m "feat: allow OverlayFrame surface/border color overrides"
```

---

### Task 5: `PaletteOverlay` component

**Files:**
- Create: `src/ui/tui/overlays/palette.tsx`

No TUI render-test infra exists in this repo — gates are `bun typecheck` plus manual verification in Task 8.

- [ ] **Step 1: Implement the component**

Create `src/ui/tui/overlays/palette.tsx`:

```tsx
/**
 * Slash command palette — centered list + detail-pane picker.
 * Opens when the prompt buffer becomes exactly "/"; the palette owns the
 * query from then on (the prompt keeps just the "/").
 */
import { createMemo, createSignal, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useBindings } from "@opentui/keymap/solid";
import type { InputRenderable } from "@opentui/core";
import { SLASH_COMMAND_METADATA } from "../../../slash-commands.js";
import { TUI_PALETTE, TUI_STYLE, truncatePlainText } from "../theme.js";
import { OverlayFrame } from "./frame.js";
import {
  buildPaletteItems,
  commandNeedsArgument,
  filterPaletteItems,
  type PaletteItem,
} from "./palette-items.js";

const LIST_WIDTH = 22;
const MAX_VISIBLE = 12;
const DETAIL_MIN_COLS = 64;
const SELECTED_BG = "#3a3e4b";

export interface PaletteOverlayProps {
  /** Run a no-argument command through the normal slash dispatch. */
  onRun: (command: string) => void;
  /** Seed the prompt with `"/name "` for argument-taking commands (also Tab). */
  onInsert: (text: string) => void;
  /** Query contains "/" — hand the text back to the prompt for path completion. */
  onHandoff: (text: string) => void;
  onCancel: () => void;
}

export function PaletteOverlay(props: PaletteOverlayProps) {
  const dimensions = useTerminalDimensions();
  let input: InputRenderable | undefined;
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const items = createMemo(() => buildPaletteItems(SLASH_COMMAND_METADATA));
  const filtered = createMemo(() => filterPaletteItems(items(), query()));
  const selected = createMemo<PaletteItem | undefined>(
    () => filtered()[selectedIndex()],
  );
  const showDetail = createMemo(
    () => (dimensions().width || 80) >= DETAIL_MIN_COLS,
  );
  const frameWidth = createMemo(() =>
    Math.min(showDetail() ? 78 : 40, (dimensions().width || 80) - 8),
  );

  const scrollStart = createMemo(() => {
    const total = filtered().length;
    const visible = Math.min(MAX_VISIBLE, total);
    return Math.min(
      Math.max(0, selectedIndex() - visible + 1),
      Math.max(0, total - visible),
    );
  });
  const visibleItems = createMemo(() =>
    filtered().slice(scrollStart(), scrollStart() + MAX_VISIBLE),
  );

  const insert = (item: PaletteItem) => props.onInsert(`${item.name} `);
  const smartSelect = (item: PaletteItem) => {
    if (commandNeedsArgument(item)) insert(item);
    else props.onRun(item.name);
  };

  useBindings(() => ({
    target: () => input,
    targetMode: "focus",
    bindings: [
      {
        key: "up",
        cmd: () => setSelectedIndex((i) => Math.max(0, i - 1)),
      },
      {
        key: "down",
        cmd: () =>
          setSelectedIndex((i) => Math.min(filtered().length - 1, i + 1)),
      },
      {
        key: "tab",
        cmd: () => {
          const item = selected();
          if (item) insert(item);
        },
      },
    ],
  }));

  return (
    <OverlayFrame
      width={frameWidth()}
      backgroundColor="#2a2d37"
      borderColor="#3d414d"
    >
      <input
        ref={(el: InputRenderable) => {
          input = el;
        }}
        focused
        placeholder="type to filter commands…"
        onInput={(v: string) => {
          if (v.includes("/")) {
            props.onHandoff(`/${v}`);
            return;
          }
          setQuery(v);
          setSelectedIndex(0);
        }}
        onSubmit={() => {
          const item = selected();
          if (item) smartSelect(item);
        }}
      />
      <box flexDirection="row" flexGrow={1} minHeight={1}>
        <box flexDirection="column" width={LIST_WIDTH} flexShrink={0}>
          <For each={visibleItems()}>
            {(item, i) => {
              const isSelected = () => scrollStart() + i() === selectedIndex();
              return (
                <box
                  flexDirection="row"
                  backgroundColor={isSelected() ? SELECTED_BG : undefined}
                >
                  <text fg={TUI_PALETTE.coral}>{isSelected() ? "▌" : " "}</text>
                  <text fg={TUI_PALETTE.brand}>
                    {truncatePlainText(item.name, LIST_WIDTH - 2)}
                  </text>
                </box>
              );
            }}
          </For>
          <Show when={filtered().length === 0}>
            <text>
              <span style={TUI_STYLE.muted}>
                no matches — "/" hands off to path mode
              </span>
            </text>
          </Show>
        </box>
        <Show when={showDetail() && selected()}>
          {(item) => (
            <box flexDirection="column" flexGrow={1} paddingLeft={2}>
              <text>
                <span style={TUI_STYLE.brand}>{item().name}</span>
                <Show when={item().argumentHint}>
                  {(hint) => <span style={TUI_STYLE.accent}> {hint()}</span>}
                </Show>
              </text>
              <text>
                <span style={TUI_STYLE.chromeMuted}>{item().description}</span>
              </text>
              <text>
                <span style={TUI_STYLE.chromeMuted}>
                  aliases:{" "}
                  {item().aliases.length > 0 ? item().aliases.join(", ") : "—"}
                </span>
              </text>
              <text>
                <span style={TUI_STYLE.chromeMuted}>
                  category: {item().category}
                </span>
              </text>
            </box>
          )}
        </Show>
      </box>
      <text>
        <span style={TUI_STYLE.muted}>
          ↑↓ navigate · ↵ run/insert · tab insert · esc close ·{" "}
          {filtered().length} shown
        </span>
      </text>
    </OverlayFrame>
  );
}
```

Note: no divider rule between panes (spacing instead) — minor simplification from the approved mockup.

- [ ] **Step 2: Verify**

Run: `bun typecheck`
Expected: clean. (Component not yet wired — that's Task 6.)

- [ ] **Step 3: Commit**

```bash
git add src/ui/tui/overlays/palette.tsx
git commit -m "feat: slash palette overlay component (list + detail pane)"
```

---

### Task 6: Host wiring — render palette, dismiss keys

**Files:**
- Modify: `src/ui/tui/overlays/host.tsx`

- [ ] **Step 1: Implement**

In `host.tsx`:
1. Extend `OverlayHostProps` with:

```ts
  onPaletteRun: (command: string) => void;
  onPaletteInsert: (text: string) => void;
  onPaletteHandoff: (text: string) => void;
```

2. Import: `import { PaletteOverlay } from "./palette.js";`

3. In the `useBindings` block, change the condition to include palette and give palette a Ctrl+C dismiss too:

```ts
    if (k === "model" || k === "login" || k === "logout") {
      return { bindings: [{ key: "escape", cmd: () => props.onDismiss() }] };
    }
    if (k === "palette") {
      return {
        bindings: [
          { key: "escape", cmd: () => props.onDismiss() },
          { key: "ctrl+c", cmd: () => props.onDismiss() },
        ],
      };
    }
```

(If Ctrl+C proves to be swallowed by the global handler first, the worst case is the global `clear_input` clears the underlying `/` while the palette stays open — harmless; verify in Task 8.)

4. Add to the JSX inside `overlay-host`, after the `logout` `<Show>`:

```tsx
        <Show when={kind() === "palette"}>
          <PaletteOverlay
            onRun={props.onPaletteRun}
            onInsert={props.onPaletteInsert}
            onHandoff={props.onPaletteHandoff}
            onCancel={props.onDismiss}
          />
        </Show>
```

- [ ] **Step 2: Verify**

Run: `bun typecheck` — expected: fails only on `App` not passing the new host props (fixed next task). If it fails elsewhere, fix.

- [ ] **Step 3: Commit (with Task 7's app/run wiring — host alone leaves the tree red)**

Do not commit yet; commit together with Task 7.

---

### Task 7: Prompt slim-down + app/run wiring

**Files:**
- Modify: `src/ui/tui/prompt/autocomplete.ts`
- Modify: `src/ui/tui/prompt/index.tsx`
- Modify: `src/ui/tui/app.tsx`
- Modify: `src/ui/tui/run.tsx`
- Test: `tests/prompt-helpers.test.ts`

- [ ] **Step 1: Update failing tests first**

In `tests/prompt-helpers.test.ts`:
- Delete the test `it("finds slash commands", ...)` (lines 60-64).
- Replace `it("applies slash completion with trailing space", ...)` with:

```ts
  it("applies path completion without adding a space", () => {
    const { text, caret } = applyAutocomplete("cat ./RE", 4, 8, {
      label: "README.md",
      value: "./README.md",
    });
    expect(text).toBe("cat ./README.md");
    expect(caret).toBe("cat ./README.md".length);
  });
```

- Add:

```ts
  it("lone slash returns no autocomplete (palette owns slash)", async () => {
    expect(await getAutocomplete("/", 1, process.cwd())).toBeNull();
  });
```

Run: `bun test tests/prompt-helpers.test.ts` — expected: FAIL (slash completions still present / lone-slash returns root entries).

- [ ] **Step 2: Slim `autocomplete.ts`**

In `src/ui/tui/prompt/autocomplete.ts`:
- Remove the `SLASH_COMMAND_METADATA` import and the entire `filterSlash` function.
- In `getAutocomplete`, remove the slash branch and guard the lone slash:

```ts
export async function getAutocomplete(
  text: string,
  caret: number,
  cwd: string,
): Promise<AutocompleteResult | null> {
  const { token, start, end } = tokenAtCaret(text, caret);
  if (!token || token === "/") return null;

  const items = await filterPaths(cwd, token);
  if (items.length === 0) return null;
  return { items, prefix: token, start, end };
}
```

(`filterPaths` already handles `/`-prefixed tokens as absolute paths — this also fixes absolute-path completion, which the old slash branch shadowed.)

- Simplify `applyAutocomplete` — slash commands no longer flow through it:

```ts
/** Apply a completion by replacing [start, end) with item.value. */
export function applyAutocomplete(
  text: string,
  start: number,
  end: number,
  item: AutocompleteItem,
): { text: string; caret: number } {
  const next = text.slice(0, start) + item.value + text.slice(end);
  return { text: next, caret: start + item.value.length };
}
```

- [ ] **Step 3: Prompt — `onSlashTrigger`, popup colors, caret-at-end `setText`**

In `src/ui/tui/prompt/index.tsx`:

1. Add to `PromptProps`: `onSlashTrigger?: () => void;`
2. Track transitions to a lone `/`. Add near the other `let` declarations: `let prevText = "";` and in the textarea's `onContentChange`, before the existing body:

```tsx
            onContentChange={() => {
              const value = textarea?.plainText ?? "";
              if (value === "/" && prevText !== "/") props.onSlashTrigger?.();
              prevText = value;
              prunePasteStore(value, pasteStore);
              syncHeight(value);
              void refreshAutocomplete();
            }}
```

(Also update `prevText` inside `api.clear()`/`api.setText()` — set `prevText = ""` in `clear()` and `prevText = text` in `setText` — so programmatic changes don't spuriously fire or suppress the trigger. `api.setText` is only called by the palette insert/handoff paths, which dismiss the palette; setting `prevText` there keeps a later manual `/` re-trigger working.)

3. In `api.setText`, move the caret to the end so palette inserts land ready for typing:

```ts
    setText(text: string) {
      textarea?.setText(text);
      if (textarea) textarea.cursorOffset = text.length;
      prevText = text;
      syncHeight(text);
    },
```

4. Update the file header comment line 4: `Features: auto-grow, prompt history, large-paste collapse, path autocomplete, slash palette trigger.`
5. Re-color the completion popup (path completion) to theme tokens — replace `backgroundColor="#1a1a1a"` with `backgroundColor={TUI_PALETTE.inset}` and `selectedBackgroundColor="#334455"` with `selectedBackgroundColor="#3a3e4b"`.

- [ ] **Step 4: App + run wiring**

In `src/ui/tui/app.tsx`:
- `AppProps` gains:

```ts
  onSlashTrigger: () => void;
  onPaletteRun: (command: string) => void;
  onPaletteInsert: (text: string) => void;
  onPaletteHandoff: (text: string) => void;
```

- `<Prompt ... onSlashTrigger={props.onSlashTrigger} />`
- `<OverlayHost ... onPaletteRun={props.onPaletteRun} onPaletteInsert={props.onPaletteInsert} onPaletteHandoff={props.onPaletteHandoff} />`

In `src/ui/tui/run.tsx`:
1. Extract the slash branch of `handleSubmit` into a standalone function. The new function wraps the **existing block currently at lines 286-366** (`if (input.startsWith("/")) { ... }`), moved unchanged:

```ts
  const runSlashCommand = async (input: string) => {
    ui.spinner.start("running command…");
    let result: import("../../slash-commands.js").SlashCommandResult;
    try {
      result = await controller.executeSlashCommand(input);
    } finally {
      ui.spinner.stop();
    }
    // ... rest of the existing slash-result handling, verbatim ...
  };
```

Then `handleSubmit`'s slash branch becomes:

```ts
    if (input.startsWith("/")) {
      await runSlashCommand(input);
      return;
    }
```

(The `!` → `/shell` rewrite stays in `handleSubmit` before this check.)

2. Add the four handlers near `dismissOverlay`:

```ts
  const handleSlashTrigger = () => {
    overlay.showPalette();
    renderer.requestRender();
  };

  const handlePaletteRun = (command: string) => {
    prompt?.clear();
    dismissOverlay();
    void runSlashCommand(command);
  };

  const handlePaletteInsert = (text: string) => {
    dismissOverlay();
    prompt?.setText(text);
  };

  const handlePaletteHandoff = (text: string) => {
    dismissOverlay();
    prompt?.setText(text);
  };
```

(`dismissOverlay()` already calls `prompt?.focus()` via `focusPrompt`.)

3. Pass all four into `<App ...>`.

- [ ] **Step 5: Verify**

Run: `bun typecheck && bun test`
Expected: clean; full suite green.

- [ ] **Step 6: Commit (Tasks 6+7 together)**

```bash
git add src/ui/tui/overlays/host.tsx src/ui/tui/prompt/autocomplete.ts src/ui/tui/prompt/index.tsx src/ui/tui/app.tsx src/ui/tui/run.tsx tests/prompt-helpers.test.ts
git commit -m "feat: wire slash palette — trigger, dispatch split, prompt slim-down"
```

---

### Task 8: Docs + manual verification

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Update docs**

In `AGENTS.md`, under the Slash Commands table intro line (`| Command | Function |` section), add one line after the table:

```markdown
Typing `/` in the TUI opens the slash command palette (centered list + detail pane; fuzzy filter; Enter runs no-arg commands, Tab/Enter inserts arg-taking ones). Path completion stays inline.
```

- [ ] **Step 2: Full gate**

Run: `bun typecheck && bun test`
Expected: clean, all tests pass.

- [ ] **Step 3: Manual TTY walkthrough**

Run: `bun dev`, then verify:
1. Type `/` → palette opens, all 24 commands, prompt holds `/`.
2. Type `rec` → `/recall` first; detail pane shows `<query>` in coral, category `Memory`.
3. Enter on `/recall` → palette closes, prompt has `/recall ` with caret after the space.
4. `/` again, Enter on `/help` → help renders (no prompt seeding).
5. `/` again, type `qui` → `/exit` matches via alias; detail shows `aliases: /quit`.
6. `/` then type `home/` → palette hands off, prompt has `/home/` and path popup lists entries.
7. `/` then Esc → palette closes, prompt empty.
8. `/` then Ctrl+C → palette closes (or at minimum the `/` clears and palette remains usable — see Task 6 note).
9. Tab on `/plan` → inserted as `/plan `, not executed.
10. Narrow terminal (<64 cols) → detail pane hidden, list still usable.
11. `./src/` path completion still works; popup uses new theme colors.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: note slash command palette in AGENTS.md"
```

---

## Self-Review Notes

- **Spec coverage:** trigger (Task 7), smart select + bare-run safety (Tasks 2/5), handoff (5/7), grouping→category in detail pane (1/5), fuzzy + alias (2), responsive <64 cols (5), path popup re-color (7), docs (8). Coral caret: Task 5. All spec sections map to a task.
- **Placeholders:** none; all code steps contain complete code.
- **Type consistency:** `PaletteItem`/`commandNeedsArgument`/`filterPaletteItems` same names in Tasks 2, 5, and tests; `showPalette` consistent Tasks 3/7; `onPaletteRun|Insert|Handoff` consistent Tasks 6/7.
