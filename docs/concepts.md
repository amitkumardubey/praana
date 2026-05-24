# Core Concepts in ARIA

This document explains the key terms and concepts that make ARIA a unique and powerful coding agent.

## Adaptive Context

**Adaptive Context** is ARIA's within-session working memory system. Unlike traditional coding agents that treat all context as a flat list, ARIA organizes its working memory into three tiers. This allows it to manage a large amount of state efficiently, keeping the most relevant information in full view while compressing older, less-relevant information to save tokens.

### Tiers

State objects in Adaptive Context exist in one of three tiers:

-   **`active`**: The "working set." Objects in this tier are rendered in full detail in the prompt. This tier is for information directly relevant to the current task.
-   **`soft`**: "Recent history." Objects in this tier are demoted after a period of inactivity (`idle_soft_after_turns`). They are represented as a concise one-line summary in the prompt, providing a hint of their content without consuming many tokens.
-   **`hard`**: "Long-term history." After further inactivity (`idle_hard_after_turns`), objects are demoted to this tier. They are represented by only their ID, acting as a minimal anchor.

This tiered system can save **70-88% on context tokens** for peripheral state compared to a flat context window.

### Auto-Hydration

**Auto-Hydration** is the process that automatically promotes `soft` or `hard` tier objects back to `active`. Before compiling a prompt, ARIA analyzes the user's input for keywords. It filters out common English stop words and matches the remaining keywords against the content of peripheral state objects. If a match is found, the object is immediately promoted to the `active` tier, ensuring its full content is available for the LLM.

This mechanism makes context management feel effortless. You don't need to manually tell the agent to "remember" or "hydrate" a specific piece of information; it happens automatically as you converse.

## Adaptive Memory

**Adaptive Memory** is ARIA's cross-session persistence layer. It allows ARIA to learn and carry knowledge from one session to the next, building a long-term understanding of projects, user preferences, and common patterns. It is backed by a local SQLite database.

### Scopes and Multi-Context Safety

To prevent information from one project from leaking into another, Adaptive Memory uses a strict **scoping** system. Every memory is tagged with scopes, typically including:

-   `user:<hashed_username>`
-   `agent:aria`
-   `context:<hashed_cwd_path>`

When recalling memories, ARIA enforces **AND-scoping**. This means that a memory will only be retrieved if it matches *all* of the scopes in the current query. This ensures that you only get context relevant to your current working directory.

### Memory Lifecycle

-   **Session Start**: ARIA generates a "digest"—a markdown summary of the most relevant memories for the current scope—and includes it in the prompt.
-   **Session End**: ARIA can optionally use a summarizer model to analyze the transcript of the entire session. It extracts key learnings (facts, decisions, patterns, mistakes) and stores them as new entries in its Adaptive Memory for future use.

### Embeddings and Ranking

-   **Embeddings**: To enable semantic search, ARIA uses an offline `HashEmbedder`. This creates a deterministic 384-dimension vector for each memory entry without needing an internet connection. It's fast and effective for approximate nearest-neighbor search.
-   **Ranking**: Recall results are scored based on a fusion of vector similarity, confidence (which decays over time), recency, and a bonus for "pinned" memories.

---

By combining Adaptive Context for short-term working memory and Adaptive Memory for long-term knowledge, ARIA can maintain a deep understanding of your work across multiple sessions, making it a more effective and intelligent partner.
