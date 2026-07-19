# Design: Pi-style `/model` selector

**Issue:** [#34](https://github.com/amitkumardubey/praana/issues/34)  
**Date:** 2026-07-19  
**Status:** Approved

## Summary

Bare `/model` opens a Pi-style in-place model selector (search input + filtered list). Enter switches immediately; Esc cancels. Typed `/model [provider] <id>` still works for direct switches.

## Out of scope

- Issue [#48](https://github.com/amitkumardubey/praana/issues/48) — CLI `praana models [provider]`
- Floating overlays, editor argument-autocomplete as the primary picker UX

## UX (matches pi's ModelSelectorComponent)

1. `/model` with no args → replace the prompt with the selector (not a floating overlay).
2. Search field at top; keystrokes fuzzy-filter by model id and provider.
3. List rows: `→ modelId [provider] ✓` (checkmark = current).
4. Enter applies the switch via the existing `/model provider id` path.
5. Esc restores the editor.

## Catalog loading

- Each selector open calls `listAllAvailableModels()` fresh (no session-long autocomplete cache).
- Live-catalog fetch failures propagate: if a provider yields no models at all, the error surfaces in the selector status line instead of a silent empty list.
- Providers with a usable pi-ai catalog still show those models when the live fetch fails.

## Architecture

```
/model (no args) → action open_model_selector
  → run.ts swaps promptSlot: editor → ModelSelector
  → listAllAvailableModels() (pi-ai + live catalogs, available providers)
  → onSelect → executeSlashCommand(`/model ${provider} ${modelId}`)
  → restore editor + refresh chrome
```

## Files

- [`src/ui/tui/model-selector.ts`](../../src/ui/tui/model-selector.ts)
- [`src/ui/tui/run.ts`](../../src/ui/tui/run.ts)
- [`src/model-listing.ts`](../../src/model-listing.ts)
- [`src/slash-commands.ts`](../../src/slash-commands.ts)
