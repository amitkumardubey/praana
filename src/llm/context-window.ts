// ============================================================
// PRAANA — Model Context Window & Token Limits Lookup
// ============================================================

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

const MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; window: number }> = [
  // Gemini 1M–2M
  { pattern: /gemini-(?:1\.5|2\.0)-(?:flash|pro)/i, window: 1_048_576 },
  { pattern: /gemini/i, window: 1_048_576 },

  // Claude 200k
  { pattern: /claude-(?:3|3-5|3-7|sonnet|opus|haiku)/i, window: 200_000 },
  { pattern: /anthropic\.claude/i, window: 200_000 },

  // OpenAI 128k–200k
  { pattern: /gpt-4o(?:-mini)?/i, window: 128_000 },
  { pattern: /o(?:1|3|4)(?:-mini|-preview)?/i, window: 200_000 },
  { pattern: /gpt-4/i, window: 128_000 },

  // DeepSeek 64k–128k
  { pattern: /deepseek-(?:chat|reasoner|r1|v3)/i, window: 64_000 },
  { pattern: /deepseek/i, window: 64_000 },

  // Meta Llama 128k
  { pattern: /llama-3(?:\.[1-3])?/i, window: 128_000 },

  // Qwen 2.5 32k–128k
  { pattern: /qwen-2\.5/i, window: 128_000 },
  { pattern: /qwen/i, window: 32_768 },

  // Mistral 32k–128k
  { pattern: /mistral-(?:large|medium|small|nemo)/i, window: 128_000 },
  { pattern: /codestral/i, window: 32_768 },
];

const cachedContextWindows = new Map<string, number>();

/**
 * Resolve context window limit synchronously from internal heuristics and cache.
 */
export function resolveContextWindowSync(modelId: string, _provider?: string): number {
  if (!modelId) return DEFAULT_MODEL_CONTEXT_WINDOW;

  const cached = cachedContextWindows.get(modelId);
  if (cached) return cached;

  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (entry.pattern.test(modelId)) {
      cachedContextWindows.set(modelId, entry.window);
      return entry.window;
    }
  }

  return DEFAULT_MODEL_CONTEXT_WINDOW;
}

/**
 * Fetch and cache model context window asynchronously.
 */
export async function fetchAndCacheContextWindow(
  modelId: string,
  provider?: string,
): Promise<number> {
  return resolveContextWindowSync(modelId, provider);
}
