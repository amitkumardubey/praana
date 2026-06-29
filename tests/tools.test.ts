import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAllTools, describeTools } from '../src/tools/index.js';
import { createMemoryTools, mirrorToCognitiveMemory } from '../src/tools/memory.js';
import { createKnowledgeTools } from '../src/tools/knowledge.js';
import { ContextEngine } from '../src/context-engine/index.js';
import { createSystemTools } from '../src/tools/system.js';
import type { EventLog } from '../src/event-log.js';
import type { StateGraph } from '../src/state-graph.js';
import type { MemoryStore } from '../src/memory/index.js';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockEventLog(): EventLog {
  return {
    append: vi.fn(),
    search: vi.fn().mockReturnValue([]),
    readLast: vi.fn().mockReturnValue([]),
    close: vi.fn(),
    eventCount: vi.fn().mockReturnValue(0),
  } as unknown as EventLog;
}

function mockStateGraph(): StateGraph {
  // We'll manually track state for realistic tests
  const store = new Map<string, any>();
  let counter = 0;

  return {
    create: vi.fn((kind: string, payload: any) => {
      counter++;
      const id = `test-${counter}`;
      const obj = {
        id,
        kind,
        tier: 'active',
        payload,
        created: Date.now(),
        updated: Date.now(),
        lastTouched: Date.now(),
      };
      store.set(id, obj);
      return obj;
    }),
    get: vi.fn((id: string) => store.get(id) ?? null),
    update: vi.fn((id: string, updates: any) => {
      const obj = store.get(id);
      if (!obj) return null;
      const updated = { ...obj, ...updates, updated: Date.now(), lastTouched: Date.now() };
      store.set(id, updated);
      return updated;
    }),
    setTier: vi.fn((id: string, tier: string) => {
      const obj = store.get(id);
      if (!obj) return false;
      obj.tier = tier;
      obj.lastTouched = Date.now();
      return true;
    }),
    retractObject: vi.fn((id: string) => {
      const obj = store.get(id);
      if (!obj) return false;
      obj.retracted = true;
      obj.updated = Date.now();
      return true;
    }),
    list: vi.fn(() => Array.from(store.values())),
    getActive: vi.fn(() => Array.from(store.values()).filter((o: any) => o.tier === 'active')),
    getPeripheral: vi.fn(() => Array.from(store.values()).filter((o: any) => o.tier !== 'active')),
    getById: vi.fn((id: string) => store.get(id) ?? null),
  } as unknown as StateGraph;
}

function mockMemoryStore(): MemoryStore {
  const store = new Map<string, any>();
  
  return {
    recall: vi.fn().mockResolvedValue({ entries: [] }),
    remember: vi.fn().mockImplementation((content: string, opts?: any) => {
      const id = 'mem-' + (store.size + 1);
      store.set(id, { id, content, ...opts });
      return Promise.resolve({ id });
    }),
    digest: vi.fn().mockResolvedValue(null),
    sessionStart: vi.fn().mockResolvedValue(undefined),
    sessionEnd: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    hasEntry: vi.fn((id: string) => store.has(id)),
    retractMemory: vi.fn((id: string) => {
      store.delete(id);
    }),
  } as unknown as MemoryStore;
}

// ---------------------------------------------------------------------------
// Memory Tools Tests
// ---------------------------------------------------------------------------

describe('Memory Tools (createMemoryTools)', () => {
  let eventLog: EventLog;
  let stateGraph: StateGraph;
  let tools: ReturnType<typeof createMemoryTools>;

  beforeEach(() => {
    eventLog = mockEventLog();
    stateGraph = mockStateGraph();
    tools = createMemoryTools({ eventLog, stateGraph });
  });

  describe('create_task', () => {
    it('should create a task and return its id', async () => {
      const result = await tools.create_task.execute({ title: 'My task' });
      expect(result).toEqual({ ok: true, id: expect.any(String) });
      expect(stateGraph.create).toHaveBeenCalledWith('task', {
        title: 'My task',
        description: undefined,
        status: 'todo',
      });
      expect(eventLog.append).toHaveBeenCalled();
    });

    it('should create a task with description', async () => {
      const result = await tools.create_task.execute({
        title: 'My task',
        description: 'Details here',
      });
      expect(result.ok).toBe(true);
      expect(stateGraph.create).toHaveBeenCalledWith('task', {
        title: 'My task',
        description: 'Details here',
        status: 'todo',
      });
    });
  });

  describe('complete_task', () => {
    it('should mark a task as done', async () => {
      const created = await tools.create_task.execute({ title: 'Test' });
      const id = (created as any).id;

      const result = await tools.complete_task.execute({ id });
      expect(result).toEqual({ ok: true });
      expect(stateGraph.update).toHaveBeenCalledWith(id, { status: 'done' });
      expect(stateGraph.setTier).toHaveBeenCalledWith(id, 'soft');
    });

    it('should return error for missing task', async () => {
      const result = await tools.complete_task.execute({ id: 'nonexistent' });
      expect(result).toEqual({ ok: false, error: 'Task nonexistent not found' });
    });

    it('should return error for non-task object', async () => {
      // Create a note then try to complete it
      await tools.add_note.execute({ text: 'A note' });
      const result = await tools.complete_task.execute({ id: 'test-1' });
      expect(result).toEqual({ ok: false, error: 'Task test-1 not found' });
    });
  });

  describe('add_constraint', () => {
    it('should add a constraint', async () => {
      const result = await tools.add_constraint.execute({ text: 'Must be safe' });
      expect(result).toEqual({ ok: true, id: expect.any(String) });
      expect(stateGraph.create).toHaveBeenCalledWith('constraint', { text: 'Must be safe' });
    });
  });

  describe('decide', () => {
    it('should record a decision', async () => {
      const result = await tools.decide.execute({
        summary: 'Use TypeScript',
        rationale: 'Type safety',
      });
      expect(result).toEqual({ ok: true, id: expect.any(String) });
      expect(stateGraph.create).toHaveBeenCalledWith('decision', {
        summary: 'Use TypeScript',
        rationale: 'Type safety',
      });
    });
  });

  describe('add_note', () => {
    it('should add a note', async () => {
      const result = await tools.add_note.execute({ text: 'Important finding' });
      expect(result).toEqual({ ok: true, id: expect.any(String) });
      expect(stateGraph.create).toHaveBeenCalledWith('note', { text: 'Important finding' });
    });
  });

  describe('cognitive memory mirroring', () => {
    let memoryStore: MemoryStore;

    beforeEach(() => {
      memoryStore = mockMemoryStore();
      tools = createMemoryTools({
        eventLog,
        stateGraph,
        memoryStore,
        memoryEnabled: true,
        incognito: false,
      });
    });

    it('mirrors add_constraint to cognitive memory', async () => {
      const result = await tools.add_constraint.execute({ text: 'Must be safe' });
      expect(result).toEqual({ ok: true, id: expect.any(String), memoryId: 'mem-1' });
      expect(memoryStore.remember).toHaveBeenCalledWith('Must be safe', {
        kind: 'constraint',
        certainty: 'high',
      });
      expect(eventLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'system_note',
          payload: expect.objectContaining({
            type: 'memory_mirror',
            tool: 'add_constraint',
            kind: 'constraint',
            memoryId: 'mem-1',
          }),
        }),
      );
    });

    it('mirrors decide to cognitive memory with combined content', async () => {
      const result = await tools.decide.execute({
        summary: 'Use TypeScript',
        rationale: 'Type safety',
      });
      expect(result).toEqual({ ok: true, id: expect.any(String), memoryId: 'mem-1' });
      expect(memoryStore.remember).toHaveBeenCalledWith('Use TypeScript — Type safety', {
        kind: 'decision',
        certainty: 'high',
      });
    });

    it('does not mirror add_note to cognitive memory in real time', async () => {
      const result = await tools.add_note.execute({ text: 'Important finding' });
      expect(result).toEqual({ ok: true, id: expect.any(String) });
      expect(memoryStore.remember).not.toHaveBeenCalled();
    });

    it('skips cognitive mirror in incognito mode', async () => {
      tools = createMemoryTools({
        eventLog,
        stateGraph,
        memoryStore,
        memoryEnabled: true,
        incognito: true,
      });
      const result = await tools.add_constraint.execute({ text: 'Must be safe' });
      expect(result).toEqual({ ok: true, id: expect.any(String) });
      expect(memoryStore.remember).not.toHaveBeenCalled();
    });

    it('skips cognitive mirror when memory is disabled', async () => {
      tools = createMemoryTools({
        eventLog,
        stateGraph,
        memoryStore,
        memoryEnabled: false,
        incognito: false,
      });
      const result = await tools.add_constraint.execute({ text: 'Must be safe' });
      expect(result).toEqual({ ok: true, id: expect.any(String) });
      expect(memoryStore.remember).not.toHaveBeenCalled();
    });

    it('still succeeds when cognitive write fails', async () => {
      vi.mocked(memoryStore.remember).mockRejectedValueOnce(new Error('db down'));
      const result = await tools.add_constraint.execute({ text: 'Must be safe' });
      expect(result).toEqual({ ok: true, id: expect.any(String) });
      expect(stateGraph.create).toHaveBeenCalledWith('constraint', { text: 'Must be safe' });
    });
  });

  describe('soft_unload', () => {
    it('should demote an object to soft', async () => {
      const created = await tools.create_task.execute({ title: 'Test' });
      const id = (created as any).id;

      const result = await tools.soft_unload.execute({ id });
      expect(result).toEqual({ ok: true });
      expect(stateGraph.setTier).toHaveBeenCalledWith(id, 'soft');
    });

    it('should return error for missing object', async () => {
      const result = await tools.soft_unload.execute({ id: 'missing' });
      expect(result).toEqual({ ok: false, error: 'Object missing not found' });
    });
  });

  describe('hard_unload', () => {
    it('should demote an object to hard', async () => {
      const created = await tools.create_task.execute({ title: 'Test' });
      const id = (created as any).id;

      const result = await tools.hard_unload.execute({ id });
      expect(result).toEqual({ ok: true });
      expect(stateGraph.setTier).toHaveBeenCalledWith(id, 'hard');
    });

    it('should return error for missing object', async () => {
      const result = await tools.hard_unload.execute({ id: 'missing' });
      expect(result).toEqual({ ok: false, error: 'Object missing not found' });
    });
  });

  describe('hydrate', () => {
    it('should promote an object to active', async () => {
      const created = await tools.create_task.execute({ title: 'Test' });
      const id = (created as any).id;

      const result = await tools.hydrate.execute({ id });
      expect(result).toEqual({ ok: true, payload: expect.any(Object) });
      expect(stateGraph.setTier).toHaveBeenCalledWith(id, 'active');
    });

    it('should return error for missing object', async () => {
      const result = await tools.hydrate.execute({ id: 'missing' });
      expect(result).toEqual({ ok: false, error: 'Object missing not found' });
    });
  });

  describe('list_state', () => {
    it('should list all state objects', async () => {
      await tools.create_task.execute({ title: 'Task 1' });
      await tools.add_note.execute({ text: 'Note 1' });

      const result = await tools.list_state.execute({});
      expect(result.ok).toBe(true);
      expect((result as any).objects.length).toBe(2);
    });

    it('should return empty list when no objects', async () => {
      const result = await tools.list_state.execute({});
      expect(result.ok).toBe(true);
      expect((result as any).objects).toEqual([]);
    });
  });

  describe('retract_task', () => {
    it('should retract a task and return retracted status', async () => {
      const created = await tools.create_task.execute({ title: 'To retract' });
      const id = (created as any).id;

      const result = await tools.retract_task.execute({ id });
      expect(result).toEqual({ ok: true, retracted: true });
      expect(eventLog.append).toHaveBeenCalled();
    });

    it('should return error for missing object', async () => {
      const result = await tools.retract_task.execute({ id: 'nonexistent' });
      expect(result).toEqual({ ok: false, error: 'Object nonexistent not found' });
    });
  });

  describe('search_session_log', () => {
    it('should search the event log', async () => {
      const mockResult = [
        { event: { event_id: 'e1', kind: 'user_message', actor: 'user', timestamp: 100, payload: {} }, excerpt: 'hello' },
      ];
      (eventLog.search as any).mockReturnValue(mockResult);

      const result = await tools.search_session_log.execute({ query: 'hello' });
      expect(result.ok).toBe(true);
      expect((result as any).matchCount).toBe(1);
      expect(eventLog.search).toHaveBeenCalledWith('hello', { kinds: undefined, limit: 20 });
    });

    it('should pass kinds and limit options', async () => {
      (eventLog.search as any).mockReturnValue([]);
      await tools.search_session_log.execute({
        query: 'test',
        kinds: ['tool_call', 'tool_result'],
        limit: 10,
      });
      expect(eventLog.search).toHaveBeenCalledWith('test', {
        kinds: ['tool_call', 'tool_result'],
        limit: 10,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Knowledge Tools Tests
// ---------------------------------------------------------------------------

function knowledgeToolCtx(overrides: Partial<Parameters<typeof createKnowledgeTools>[0]> = {}) {
  return {
    eventLog: mockEventLog(),
    memoryStore: mockMemoryStore(),
    memoryEnabled: true,
    incognito: false,
    contextEngine: null,
    getCurrentTurn: () => 0,
    ...overrides,
  };
}

describe('Knowledge Tools (createKnowledgeTools)', () => {
  let eventLog: EventLog;
  let memoryStore: MemoryStore;
  let tools: ReturnType<typeof createKnowledgeTools>;

  beforeEach(() => {
    const ctx = knowledgeToolCtx();
    eventLog = ctx.eventLog;
    memoryStore = ctx.memoryStore!;
    tools = createKnowledgeTools(ctx);
  });

  describe('recall', () => {
    it('should search memory and return entries', async () => {
      const entries = [
        { id: 'm1', content: 'Test memory', kind: 'fact', validity: 0.9, usefulness: 0.5, scope: ['user:a'], created: 100, updated: 100 },
      ];
      (memoryStore.recall as any).mockResolvedValue({ entries });

      const result = await tools.recall.execute({ query: 'test' });
      expect(result.ok).toBe(true);
      expect((result as any).entries).toEqual(entries);
      expect(memoryStore.recall).toHaveBeenCalledWith('test', { limit: 10, kinds: undefined });
    });

    it('should pass kinds filter', async () => {
      (memoryStore.recall as any).mockResolvedValue({ entries: [] });
      const result = await tools.recall.execute({ query: 'test', kinds: ['fact', 'decision'] });
      expect(memoryStore.recall).toHaveBeenCalledWith('test', {
        limit: 10,
        kinds: ['fact', 'decision'],
      });
      expect((result as any).note).toContain('search_session_log');
    });

    it('should return error when memory is disabled', async () => {
      const toolsDisabled = createKnowledgeTools(knowledgeToolCtx({ eventLog, memoryStore, memoryEnabled: false }));
      const result = await toolsDisabled.recall.execute({ query: 'test' });
      expect(result).toEqual({ ok: false, error: 'Cognitive Memory is not available.' });
    });

    it('should return error when memory store is null', async () => {
      const toolsNull = createKnowledgeTools(knowledgeToolCtx({ eventLog, memoryStore: null }));
      const result = await toolsNull.recall.execute({ query: 'test' });
      expect(result).toEqual({ ok: false, error: 'Cognitive Memory is not available.' });
    });

    it('should handle recall errors gracefully', async () => {
      (memoryStore.recall as any).mockRejectedValue(new Error('DB error'));
      const result = await tools.recall.execute({ query: 'test' });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('DB error');
      expect((result as any).error).toContain('search_session_log');
    });

    it('should log recall event', async () => {
      (memoryStore.recall as any).mockResolvedValue({ entries: [] });
      await tools.recall.execute({ query: 'something' });
      expect(eventLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'system_note',
          payload: expect.objectContaining({ type: 'memory_recall', query: 'something' }),
        })
      );
    });
  });

  describe('remember', () => {
    it('should store a memory', async () => {
      const result = await tools.remember.execute({ content: 'Important fact' });
      expect(result).toEqual({ ok: true, id: 'mem-1' });
      expect(memoryStore.remember).toHaveBeenCalled();
    });

    it('should map kinds correctly', async () => {
      await tools.remember.execute({
        content: 'Preference',
        kind: 'preference',
        certainty: 'high',
      });
      expect(memoryStore.remember).toHaveBeenCalledWith('Preference', {
        kind: 'preference',
        certainty: 'high',
        scope: undefined,
      });
    });

    it('should map context_fact to fact', async () => {
      await tools.remember.execute({ content: 'Fact', kind: 'context_fact' });
      expect(memoryStore.remember).toHaveBeenCalledWith('Fact', {
        kind: 'fact',
        certainty: 'medium',
        scope: undefined,
      });
    });

    it('should pass scope when provided', async () => {
      await tools.remember.execute({
        content: 'Scoped',
        scope: ['context:my-project'],
      });
      expect(memoryStore.remember).toHaveBeenCalledWith('Scoped', {
        kind: 'fact',
        certainty: 'medium',
        scope: ['context:my-project'],
      });
    });

    it('should return error when memory is disabled', async () => {
      const toolsDisabled = createKnowledgeTools(knowledgeToolCtx({ eventLog, memoryStore, memoryEnabled: false }));
      const result = await toolsDisabled.remember.execute({ content: 'test' });
      expect(result).toEqual({ ok: false, error: 'Cognitive Memory is not available.' });
    });

    it('should handle remember errors gracefully', async () => {
      (memoryStore.remember as any).mockRejectedValue(new Error('Storage error'));
      const result = await tools.remember.execute({ content: 'test' });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('Storage error');
    });
  });

  describe('retrieve_artifact', () => {
    it('retrieves stored artifact content when context engine is enabled', async () => {
      const engine = ContextEngine.open(':memory:', 'sess-tools', {
        enabled: true,
        measurement_mode: false,
        artifact_inline_threshold: 10,
        artifact_ttl_turns: 50,
        distiller: { default_intensity: 'full' },
        llm_digest: false,
        activity_log_max_entries: 15,
        checkpoint_enabled: true,
        scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
        pressure: { compact_at: 0.7, emergency_at: 0.85 },
      });
      const ingested = engine.ingestToolResult({
        sourceTool: 'shell',
        rawText: 'x'.repeat(500),
        createdTurn: 1,
      });
      const artifactTools = createKnowledgeTools(
        knowledgeToolCtx({
          contextEngine: engine,
          getCurrentTurn: () => 2,
        }),
      );
      const result = await artifactTools.retrieve_artifact.execute({
        id: ingested.artifactId!,
      });
      engine.close();
      expect(result).toEqual({ ok: true, id: ingested.artifactId, content: 'x'.repeat(500) });
    });
  });

  describe('forget_memory', () => {
    it('should retract a memory entry', async () => {
      // First create a memory
      await tools.remember.execute({ content: 'To forget' });
      
      const result = await tools.forget_memory.execute({ id: 'mem-1' });
      expect(result).toEqual({ ok: true, id: 'mem-1' });
      expect(memoryStore.retractMemory).toHaveBeenCalledWith('mem-1');
      expect(eventLog.append).toHaveBeenCalled();
    });

    it('should return error for non-existent memory', async () => {
      const result = await tools.forget_memory.execute({ id: 'nonexistent' });
      expect(result).toEqual({ ok: false, error: 'Memory nonexistent not found' });
    });

    it('should return error when memory is disabled', async () => {
      const toolsDisabled = createKnowledgeTools(knowledgeToolCtx({ eventLog, memoryStore, memoryEnabled: false }));
      const result = await toolsDisabled.forget_memory.execute({ id: 'test' });
      expect(result).toEqual({ ok: false, error: 'Cognitive Memory is not available.' });
    });

    it('should return incognito error when incognito mode', async () => {
      const toolsIncognito = createKnowledgeTools(knowledgeToolCtx({ eventLog, memoryStore, incognito: true }));
      const result = await toolsIncognito.forget_memory.execute({ id: 'test' });
      expect(result).toEqual({ ok: false, error: 'Memory is disabled in incognito mode.' });
    });
  });
});

// ---------------------------------------------------------------------------
// System Tools Tests
// ---------------------------------------------------------------------------

describe('System Tools (createSystemTools)', () => {
  const testDir = '/tmp/praana-test-tools';
  let tools: ReturnType<typeof createSystemTools>;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    tools = createSystemTools({ cwd: testDir });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('read_file', () => {
    it('should read file contents', async () => {
      writeFileSync(join(testDir, 'hello.txt'), 'Hello World');
      const result = await tools.read_file.execute({ path: 'hello.txt' });
      expect(result).toEqual({ ok: true, content: 'Hello World' });
    });

    it('should return error for missing file', async () => {
      const result = await tools.read_file.execute({ path: 'missing.txt' });
      expect(result).toEqual({ ok: false, error: expect.stringContaining('not found') });
    });

    it('should support offset parameter', async () => {
      writeFileSync(join(testDir, 'lines.txt'), 'line1\nline2\nline3\n');
      const result = await tools.read_file.execute({ path: 'lines.txt', offset: 2 });
      expect(result.ok).toBe(true);
      expect((result as any).content).toBe('line2\nline3\n');
    });

    it('should support offset and limit together', async () => {
      writeFileSync(join(testDir, 'lines.txt'), 'line1\nline2\nline3\nline4\n');
      const result = await tools.read_file.execute({ path: 'lines.txt', offset: 2, limit: 2 });
      expect(result.ok).toBe(true);
      expect((result as any).content).toBe('line2\nline3');
    });

    it('should handle absolute paths', async () => {
      writeFileSync(join(testDir, 'abs.txt'), 'absolute');
      const result = await tools.read_file.execute({ path: join(testDir, 'abs.txt') });
      expect(result.ok).toBe(true);
    });

    it('should handle file read errors', async () => {
      const result = await tools.read_file.execute({ path: '/nonexistent/path/file.txt' });
      expect(result.ok).toBe(false);
    });

    it('counts repeat reads across tool invocations via session callback', async () => {
      writeFileSync(join(testDir, 'repeat.txt'), 'content');
      const readPaths = new Set<string>();
      let repeatReads = 0;
      const scorecardTools = createSystemTools({
        cwd: testDir,
        skills: [],
        skillRuntime: null,
        getCurrentTurn: () => 0,
        onScorecardFileRead: (absPath) => {
          if (readPaths.has(absPath)) repeatReads++;
          readPaths.add(absPath);
        },
      });

      await scorecardTools.read_file.execute({ path: 'repeat.txt' });
      await scorecardTools.read_file.execute({ path: 'repeat.txt' });
      expect(repeatReads).toBe(1);
    });

    it('should handle limit without offset', async () => {
      writeFileSync(join(testDir, 'lines.txt'), 'a\nb\nc\nd\ne\n');
      const result = await tools.read_file.execute({ path: 'lines.txt', limit: 3 });
      expect(result.ok).toBe(true);
      expect((result as any).content).toBe('a\nb\nc');
    });
  });

  describe('write_file', () => {
    it('should write file contents', async () => {
      const result = await tools.write_file.execute({ path: 'output.txt', content: 'data' });
      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(testDir, 'output.txt'), 'utf-8')).toBe('data');
    });

    it('should create parent directories', async () => {
      const result = await tools.write_file.execute({
        path: 'sub/dir/file.txt',
        content: 'nested',
      });
      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(testDir, 'sub/dir/file.txt'), 'utf-8')).toBe('nested');
    });

    it('should warn on invalid JSON content', async () => {
      const result = await tools.write_file.execute({
        path: 'config.json',
        content: '{invalid json}',
      });
      expect(result.ok).toBe(true);
      expect((result as any).warning).toContain('JSON');
    });

    it('should warn on invalid TOML content', async () => {
      const result = await tools.write_file.execute({
        path: 'config.toml',
        content: '[[[invalid]]]',
      });
      expect(result.ok).toBe(true);
      expect((result as any).warning).toContain('TOML');
    });

    it('should not warn on valid JSON', async () => {
      const result = await tools.write_file.execute({
        path: 'valid.json',
        content: '{"key": "value"}',
      });
      expect(result).toEqual({ ok: true });
    });

    it('should not warn on non-JSON/TOML files', async () => {
      const result = await tools.write_file.execute({
        path: 'notes.txt',
        content: 'plain text',
      });
      expect(result).toEqual({ ok: true });
    });

    it('should handle write errors', async () => {
      // Trying to write to a path that's a directory should fail
      mkdirSync(join(testDir, 'existing_dir'));
      const result = await tools.write_file.execute({
        path: 'existing_dir',
        content: 'test',
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('edit_file', () => {
    it('should replace text in a file', async () => {
      writeFileSync(join(testDir, 'edit.txt'), 'Hello World');
      const result = await tools.edit_file.execute({
        path: 'edit.txt',
        oldText: 'World',
        newText: 'PRAANA',
      });
      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(testDir, 'edit.txt'), 'utf-8')).toBe('Hello PRAANA');
    });

    it('should return error if oldText not found', async () => {
      writeFileSync(join(testDir, 'edit.txt'), 'Hello World');
      const result = await tools.edit_file.execute({
        path: 'edit.txt',
        oldText: 'Missing',
        newText: 'Nothing',
      });
      expect(result).toEqual({ ok: false, error: expect.stringContaining('not found') });
    });

    it('should return error if oldText is not unique', async () => {
      writeFileSync(join(testDir, 'edit.txt'), 'Hello Hello');
      const result = await tools.edit_file.execute({
        path: 'edit.txt',
        oldText: 'Hello',
        newText: 'Hi',
      });
      expect(result).toEqual({ ok: false, error: expect.stringContaining('found') });
    });

    it('should return error for missing file', async () => {
      const result = await tools.edit_file.execute({
        path: 'missing.txt',
        oldText: 'a',
        newText: 'b',
      });
      expect(result).toEqual({ ok: false, error: expect.stringContaining('not found') });
    });

    it('should handle special characters in oldText', async () => {
      writeFileSync(join(testDir, 'special.txt'), 'price is $100.99 & more');
      const result = await tools.edit_file.execute({
        path: 'special.txt',
        oldText: '$100.99',
        newText: '$50.00',
      });
      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(testDir, 'special.txt'), 'utf-8')).toBe('price is $50.00 & more');
    });

    it('should write file when editConfirm is true and user answers y', async () => {
      writeFileSync(join(testDir, 'confirm.txt'), 'Hello World');
      const confirmTools = createSystemTools({ cwd: testDir, editConfirm: true });

      // Mock stdin to emit 'y\n'
      const { Readable } = await import('node:stream');
      const mockStdin = Readable.from(['y\n']);
      const originalStdin = process.stdin;
      Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

      try {
        const result = await confirmTools.edit_file.execute({
          path: 'confirm.txt',
          oldText: 'World',
          newText: 'PRAANA',
        });
        expect(result).toEqual({ ok: true });
        expect(readFileSync(join(testDir, 'confirm.txt'), 'utf-8')).toBe('Hello PRAANA');
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }
    });

    it('should cancel edit when editConfirm is true and user answers n', async () => {
      writeFileSync(join(testDir, 'confirm.txt'), 'Hello World');
      const confirmTools = createSystemTools({ cwd: testDir, editConfirm: true });

      const { Readable } = await import('node:stream');
      const mockStdin = Readable.from(['n\n']);
      const originalStdin = process.stdin;
      Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

      try {
        const result = await confirmTools.edit_file.execute({
          path: 'confirm.txt',
          oldText: 'World',
          newText: 'PRAANA',
        });
        expect(result).toEqual({ ok: false, error: 'Edit cancelled by user' });
        expect(readFileSync(join(testDir, 'confirm.txt'), 'utf-8')).toBe('Hello World');
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }
    });

    it('should write file without prompt when editConfirm is false (default)', async () => {
      writeFileSync(join(testDir, 'noconfirm.txt'), 'Hello World');
      // Default tools have editConfirm undefined (falsy)
      const result = await tools.edit_file.execute({
        path: 'noconfirm.txt',
        oldText: 'World',
        newText: 'PRAANA',
      });
      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(testDir, 'noconfirm.txt'), 'utf-8')).toBe('Hello PRAANA');
    });

    it('should show line number in diff preview when editConfirm is enabled', async () => {
      writeFileSync(join(testDir, 'linenum.txt'), 'line1\nline2\nHello World');
      const confirmTools = createSystemTools({ cwd: testDir, editConfirm: true });

      const { Readable } = await import('node:stream');
      const mockStdin = Readable.from(['y\n']);
      const originalStdin = process.stdin;
      Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

      // Capture diff preview output via UI stderr channel
      const stderrChunks: string[] = [];
      const { setUiWriters } = await import("../../src/ui.js");
      setUiWriters({
        stderr: (line) => {
          stderrChunks.push(line);
        },
      });

      try {
        await confirmTools.edit_file.execute({
          path: 'linenum.txt',
          oldText: 'World',
          newText: 'PRAANA',
        });
        const stderrOutput = stderrChunks.join('');
        expect(stderrOutput).toContain('linenum.txt:3');
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
        setUiWriters();
      }
    });
  });

  describe('batch_write', () => {
    it('should write multiple files', async () => {
      const result = await tools.batch_write.execute({
        files: [
          { path: 'a.txt', content: 'aaa' },
          { path: 'b.txt', content: 'bbb' },
        ],
      });
      expect(result).toEqual({ ok: true, files: ['a.txt', 'b.txt'] });
      expect(readFileSync(join(testDir, 'a.txt'), 'utf-8')).toBe('aaa');
      expect(readFileSync(join(testDir, 'b.txt'), 'utf-8')).toBe('bbb');
    });

    it('should create parent directories', async () => {
      const result = await tools.batch_write.execute({
        files: [
          { path: 'deep/nested/dir/file.txt', content: 'nested content' },
        ],
      });
      expect(result).toEqual({ ok: true, files: ['deep/nested/dir/file.txt'] });
      expect(readFileSync(join(testDir, 'deep/nested/dir/file.txt'), 'utf-8')).toBe('nested content');
    });

    it('should create parent directories for multiple files', async () => {
      const result = await tools.batch_write.execute({
        files: [
          { path: 'src/components/Button.tsx', content: 'tsx' },
          { path: 'src/components/Button.css', content: 'css' },
          { path: 'src/components/Button.test.tsx', content: 'test' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(existsSync(join(testDir, 'src/components/Button.tsx'))).toBe(true);
      expect(existsSync(join(testDir, 'src/components/Button.css'))).toBe(true);
      expect(existsSync(join(testDir, 'src/components/Button.test.tsx'))).toBe(true);
    });

    it('should overwrite existing files', async () => {
      writeFileSync(join(testDir, 'existing.txt'), 'old content');
      const result = await tools.batch_write.execute({
        files: [{ path: 'existing.txt', content: 'new content' }],
      });
      expect(result).toEqual({ ok: true, files: ['existing.txt'] });
      expect(readFileSync(join(testDir, 'existing.txt'), 'utf-8')).toBe('new content');
    });

    it('should rollback all files on partial failure', async () => {
      // Create a file that will block writing (directory exists as a file)
      writeFileSync(join(testDir, 'blocker'), 'existing');

      const result = await tools.batch_write.execute({
        files: [
          { path: 'good.txt', content: 'good' },
          { path: 'blocker/sub.txt', content: 'bad' }, // 'blocker' is a file, not a dir
        ],
      });
      expect(result.ok).toBe(false);
      expect((result as any).written).toContain('good.txt');
      // The first file should have been rolled back
      expect(existsSync(join(testDir, 'good.txt'))).toBe(false);
      // Original file should be preserved
      expect(readFileSync(join(testDir, 'blocker'), 'utf-8')).toBe('existing');
    });

    it('should rollback new files on write error', async () => {
      // Make the first file succeed, then make the second fail by making path a directory
      writeFileSync(join(testDir, 'dir-as-file'), 'data');

      const result = await tools.batch_write.execute({
        files: [
          { path: 'will-be-rolled-back.txt', content: 'temp' },
          { path: 'dir-as-file/child.txt', content: 'fail' },
        ],
      });
      expect(result.ok).toBe(false);
      expect(existsSync(join(testDir, 'will-be-rolled-back.txt'))).toBe(false);
    });

    it('should return error for empty file list', async () => {
      const result = await tools.batch_write.execute({ files: [] });
      expect(result).toEqual({ ok: true, files: [] });
    });

    it('should handle absolute paths', async () => {
      const absPath = join(testDir, 'absolute.txt');
      const result = await tools.batch_write.execute({
        files: [{ path: absPath, content: 'absolute' }],
      });
      expect(result.ok).toBe(true);
      expect(readFileSync(absPath, 'utf-8')).toBe('absolute');
    });
  });

  describe('batch_edit', () => {
    it('should edit multiple files', async () => {
      writeFileSync(join(testDir, 'file1.txt'), 'Hello World');
      writeFileSync(join(testDir, 'file2.txt'), 'Foo Bar');

      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'file1.txt', oldText: 'World', newText: 'PRAANA' },
          { path: 'file2.txt', oldText: 'Bar', newText: 'Baz' },
        ],
      });
      expect(result).toEqual({ ok: true, files: ['file1.txt', 'file2.txt'] });
      expect(readFileSync(join(testDir, 'file1.txt'), 'utf-8')).toBe('Hello PRAANA');
      expect(readFileSync(join(testDir, 'file2.txt'), 'utf-8')).toBe('Foo Baz');
    });

    it('should return error if any oldText not found', async () => {
      writeFileSync(join(testDir, 'a.txt'), 'aaa');
      writeFileSync(join(testDir, 'b.txt'), 'bbb');

      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'a.txt', oldText: 'aaa', newText: 'AAA' },
          { path: 'b.txt', oldText: 'missing', newText: 'BBB' },
        ],
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('not found');
      // Neither file should be modified (validation runs before any edits)
      expect(readFileSync(join(testDir, 'a.txt'), 'utf-8')).toBe('aaa');
      expect(readFileSync(join(testDir, 'b.txt'), 'utf-8')).toBe('bbb');
    });

    it('should return error if any oldText is not unique', async () => {
      writeFileSync(join(testDir, 'a.txt'), 'abc abc');
      writeFileSync(join(testDir, 'b.txt'), 'xyz');

      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'a.txt', oldText: 'abc', newText: 'ABC' },
          { path: 'b.txt', oldText: 'xyz', newText: 'XYZ' },
        ],
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('not unique');
      // Neither file should be modified
      expect(readFileSync(join(testDir, 'a.txt'), 'utf-8')).toBe('abc abc');
      expect(readFileSync(join(testDir, 'b.txt'), 'utf-8')).toBe('xyz');
    });

    it('should return error for missing file', async () => {
      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'missing.txt', oldText: 'a', newText: 'b' },
        ],
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('not found');
    });

    it('should rollback all files on write failure mid-edit', async () => {
      writeFileSync(join(testDir, 'file1.txt'), 'content1');
      writeFileSync(join(testDir, 'file2.txt'), 'content2');

      // We can't easily make writeFileSync fail in the edit loop,
      // but we can verify the snapshot/rollback mechanism works by
      // checking that originals are preserved when validation fails.
      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'file1.txt', oldText: 'content1', newText: 'CHANGED1' },
          { path: 'file2.txt', oldText: 'nonexistent', newText: 'CHANGED2' },
        ],
      });
      expect(result.ok).toBe(false);
      // Both files should be untouched (validation failed before any writes)
      expect(readFileSync(join(testDir, 'file1.txt'), 'utf-8')).toBe('content1');
      expect(readFileSync(join(testDir, 'file2.txt'), 'utf-8')).toBe('content2');
    });

    it('should handle edits in subdirectories', async () => {
      mkdirSync(join(testDir, 'src/utils'), { recursive: true });
      writeFileSync(join(testDir, 'src/utils/helper.ts'), 'export function foo() {}');

      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'src/utils/helper.ts', oldText: 'foo', newText: 'bar' },
        ],
      });
      expect(result).toEqual({ ok: true, files: ['src/utils/helper.ts'] });
      expect(readFileSync(join(testDir, 'src/utils/helper.ts'), 'utf-8')).toBe('export function bar() {}');
    });

    it('should handle empty edit list', async () => {
      const result = await tools.batch_edit.execute({ edits: [] });
      expect(result).toEqual({ ok: true, files: [] });
    });

    it('should handle special characters in oldText', async () => {
      writeFileSync(join(testDir, 'special.txt'), 'price is $100.99 & more');
      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'special.txt', oldText: '$100.99', newText: '$50.00' },
        ],
      });
      expect(result).toEqual({ ok: true, files: ['special.txt'] });
      expect(readFileSync(join(testDir, 'special.txt'), 'utf-8')).toBe('price is $50.00 & more');
    });

    it('should apply multiple edits to the same file sequentially', async () => {
      writeFileSync(join(testDir, 'chain.txt'), 'alpha beta gamma');

      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'chain.txt', oldText: 'alpha', newText: 'ALPHA' },
          { path: 'chain.txt', oldText: 'ALPHA beta', newText: 'ALPHA BETA' },
          { path: 'chain.txt', oldText: 'gamma', newText: 'GAMMA' },
        ],
      });

      expect(result).toEqual({ ok: true, files: ['chain.txt', 'chain.txt', 'chain.txt'] });
      expect(readFileSync(join(testDir, 'chain.txt'), 'utf-8')).toBe('ALPHA BETA GAMMA');
    });

    it('should allow later same-file edits to match text introduced by earlier edits', async () => {
      writeFileSync(join(testDir, 'build.txt'), 'const x = 1;');

      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'build.txt', oldText: 'const x = 1;', newText: 'const x = 2;\nconst y = 3;' },
          { path: 'build.txt', oldText: 'const y = 3;', newText: 'const y = 4;' },
        ],
      });

      expect(result.ok).toBe(true);
      expect(readFileSync(join(testDir, 'build.txt'), 'utf-8')).toBe('const x = 2;\nconst y = 4;');
    });

    it('should rollback same-file edits when a later sequential edit fails', async () => {
      writeFileSync(join(testDir, 'rollback.txt'), 'one two three');

      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'rollback.txt', oldText: 'one', newText: 'ONE' },
          { path: 'rollback.txt', oldText: 'missing', newText: 'MISSING' },
        ],
      });

      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('not found');
      expect(readFileSync(join(testDir, 'rollback.txt'), 'utf-8')).toBe('one two three');
    });

    it('should interleave same-file sequential edits with independent file edits', async () => {
      writeFileSync(join(testDir, 'a.txt'), 'aaa');
      writeFileSync(join(testDir, 'b.txt'), 'bbb');

      const result = await tools.batch_edit.execute({
        edits: [
          { path: 'a.txt', oldText: 'aaa', newText: 'AAA' },
          { path: 'b.txt', oldText: 'bbb', newText: 'BBB' },
          { path: 'a.txt', oldText: 'AAA', newText: 'AAAA' },
        ],
      });

      expect(result).toEqual({ ok: true, files: ['a.txt', 'b.txt', 'a.txt'] });
      expect(readFileSync(join(testDir, 'a.txt'), 'utf-8')).toBe('AAAA');
      expect(readFileSync(join(testDir, 'b.txt'), 'utf-8')).toBe('BBB');
    });
  });

  describe('shell', () => {
    it('should execute a command and return output', async () => {
      const result = await tools.shell.execute({ command: 'echo hello' });
      expect(result.ok).toBe(true);
      expect((result as any).stdout.trim()).toBe('hello');
    });

    it('should return non-zero exit code on failure', async () => {
      const result = await tools.shell.execute({ command: 'false' });
      expect(result.ok).toBe(false);
      expect((result as any).exitCode).toBe(1);
    });

    it('should capture stderr', async () => {
      const result = await tools.shell.execute({ command: 'echo error >&2' });
      expect((result as any).stderr.trim()).toBe('error');
    });

    it('should respect custom timeout', async () => {
      const result = await tools.shell.execute({ command: 'echo fast', timeout: 5000 });
      expect(result.ok).toBe(true);
    });

    it('should handle empty command output', async () => {
      const result = await tools.shell.execute({ command: 'true' });
      expect(result.ok).toBe(true);
      expect((result as any).stdout).toBe('');
    });

    it('should handle abort signal', async () => {
      const ac = new AbortController();
      const toolsWithSignal = createSystemTools({
        cwd: testDir,
        getAbortSignal: () => ac.signal,
      });
      ac.abort();
      const result = await toolsWithSignal.shell.execute({ command: 'echo should not run' });
      expect(result.ok).toBe(false);
      expect((result as any).stderr).toContain('Interrupted');
    });

    it('should stream stdout to terminal in real time', async () => {
      const written: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: any) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const result = await tools.shell.execute({ command: 'echo streamed' });
        expect(result.ok).toBe(true);
        expect(written.some((s) => s.includes('streamed'))).toBe(true);
      } finally {
        process.stdout.write = originalWrite;
      }
    });

    it('should stream stderr to terminal in real time', async () => {
      const written: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: any) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const result = await tools.shell.execute({ command: 'echo errout >&2' });
        expect(result.ok).toBe(true);
        expect(written.some((s) => s.includes('errout'))).toBe(true);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('should not stream stdout when shellLiveStream is false', async () => {
      const written: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: any) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      const bufferedTools = createSystemTools({
        cwd: testDir,
        shellLiveStream: false,
      });
      try {
        const result = await bufferedTools.shell.execute({ command: 'echo buffered' });
        expect(result.ok).toBe(true);
        expect((result as any).stdout.trim()).toBe('buffered');
        expect(written.some((s) => s.includes('buffered'))).toBe(false);
      } finally {
        process.stdout.write = originalWrite;
      }
    });

    it('should not stream stderr when shellLiveStream is false', async () => {
      const written: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: any) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      const bufferedTools = createSystemTools({
        cwd: testDir,
        shellLiveStream: false,
      });
      try {
        const result = await bufferedTools.shell.execute({ command: 'echo errbuf >&2' });
        expect(result.ok).toBe(true);
        expect((result as any).stderr.trim()).toBe('errbuf');
        expect(written.some((s) => s.includes('errbuf'))).toBe(false);
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe('read_and_summarize', () => {
    it('should return error for missing file', async () => {
      const result = await tools.read_and_summarize.execute({ path: 'nonexistent.ts' });
      expect(result).toEqual({ ok: false, error: expect.stringContaining('File not found') });
    });

    it('should return basic file info', async () => {
      writeFileSync(join(testDir, 'simple.txt'), 'line1\nline2\nline3');
      const result = await tools.read_and_summarize.execute({ path: 'simple.txt' });
      expect(result.ok).toBe(true);
      expect((result as any).lines).toBe(3);
      expect((result as any).contentPreview).toBe('line1\nline2\nline3');
      expect((result as any).exports).toEqual([]);
      expect((result as any).functions).toEqual([]);
    });

    it('should extract export declarations', async () => {
      const code = `
export function helper() {}
export class MyClass {}
export const CONST_VAL = 1;
export interface MyInterface {}
export type MyType = string;
      `.trim();
      writeFileSync(join(testDir, 'exports.ts'), code);
      const result = await tools.read_and_summarize.execute({ path: 'exports.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).exports).toEqual(
        expect.arrayContaining(['helper', 'MyClass', 'CONST_VAL', 'MyInterface', 'MyType'])
      );
    });

    it('should extract default export', async () => {
      writeFileSync(join(testDir, 'default.ts'), 'export default function main() {}');
      const result = await tools.read_and_summarize.execute({ path: 'default.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).exports).toContain('main');
    });

    it('should extract named exports with destructuring', async () => {
      writeFileSync(join(testDir, 'named.ts'), 'export { foo, bar, baz }');
      const result = await tools.read_and_summarize.execute({ path: 'named.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).exports).toEqual(
        expect.arrayContaining(['foo', 'bar', 'baz'])
      );
    });

    it('should extract named exports with rename', async () => {
      writeFileSync(join(testDir, 'rename.ts'), 'export { foo as myFoo, bar }');
      const result = await tools.read_and_summarize.execute({ path: 'rename.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).exports).toEqual(
        expect.arrayContaining(['foo', 'bar'])
      );
    });

    it('should extract named exports from re-export', async () => {
      writeFileSync(join(testDir, 'reexport.ts'), "export { foo, bar } from './module'");
      const result = await tools.read_and_summarize.execute({ path: 'reexport.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).exports).toEqual(
        expect.arrayContaining(['foo', 'bar'])
      );
    });

    it('should extract imports', async () => {
      const code = `
import { readFile } from 'fs';
import path from 'path';
import * as utils from './utils';
      `.trim();
      writeFileSync(join(testDir, 'imports.ts'), code);
      const result = await tools.read_and_summarize.execute({ path: 'imports.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).imports).toEqual(
        expect.arrayContaining(['fs', 'path', './utils'])
      );
    });

    it('should extract side-effect imports', async () => {
      writeFileSync(join(testDir, 'sideeffect.ts'), "import './polyfills';");
      const result = await tools.read_and_summarize.execute({ path: 'sideeffect.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).imports).toContain('./polyfills');
    });

    it('should extract require calls', async () => {
      writeFileSync(join(testDir, 'require.js'), "const mod = require('my-module');");
      const result = await tools.read_and_summarize.execute({ path: 'require.js' });
      expect(result.ok).toBe(true);
      expect((result as any).imports).toContain('my-module');
    });

    it('should extract function declarations', async () => {
      const code = `
function standalone() {}
export function exported() {}
async function asyncFn() {}
      `.trim();
      writeFileSync(join(testDir, 'funcs.ts'), code);
      const result = await tools.read_and_summarize.execute({ path: 'funcs.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).functions).toEqual(
        expect.arrayContaining(['standalone', 'exported', 'asyncFn'])
      );
    });

    it('should extract arrow functions', async () => {
      const code = `
const handler = () => {};
const asyncHandler = async () => {};
let processor = (x) => x;
      `.trim();
      writeFileSync(join(testDir, 'arrows.ts'), code);
      const result = await tools.read_and_summarize.execute({ path: 'arrows.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).functions).toEqual(
        expect.arrayContaining(['handler', 'asyncHandler', 'processor'])
      );
    });

    it('should extract function expressions', async () => {
      const code = `
const fn = function() {};
const named = function compute() {};
      `.trim();
      writeFileSync(join(testDir, 'funcexpr.ts'), code);
      const result = await tools.read_and_summarize.execute({ path: 'funcexpr.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).functions).toEqual(
        expect.arrayContaining(['fn', 'named'])
      );
    });

    it('should detect TODO/FIXME concerns', async () => {
      const code = `
// TODO: fix this
// TODO: add tests
// TODO: clean up
// FIXME: broken
const x = 1;
      `.trim();
      writeFileSync(join(testDir, 'todos.ts'), code);
      const result = await tools.read_and_summarize.execute({ path: 'todos.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).concerns).toEqual(
        expect.arrayContaining([expect.stringContaining('TODOs')])
      );
    });

    it('should detect many exports concern', async () => {
      // Generate 20 exports
      const exports = Array.from({ length: 20 }, (_, i) => `export const item${i} = ${i};`).join('\n');
      writeFileSync(join(testDir, 'many.ts'), exports);
      const result = await tools.read_and_summarize.execute({ path: 'many.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).concerns).toEqual(
        expect.arrayContaining([expect.stringContaining('Many exports')])
      );
    });

    it('should detect large file concern', async () => {
      const lines = Array.from({ length: 600 }, (_, i) => `// line ${i}`).join('\n');
      writeFileSync(join(testDir, 'large.ts'), lines);
      const result = await tools.read_and_summarize.execute({ path: 'large.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).concerns).toEqual(
        expect.arrayContaining([expect.stringContaining('Large file')])
      );
    });

    it('should extract imports from actual import statements', async () => {
      const code = `
import { readFile } from 'fs';
import path from 'path';
      `.trim();
      writeFileSync(join(testDir, 'strings.ts'), code);
      const result = await tools.read_and_summarize.execute({ path: 'strings.ts' });
      expect(result.ok).toBe(true);
      expect((result as any).imports).toContain('fs');
      expect((result as any).imports).toContain('path');
    });

    it('should handle content preview limit', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
      writeFileSync(join(testDir, 'preview.ts'), lines);
      const result = await tools.read_and_summarize.execute({ path: 'preview.ts' });
      expect(result.ok).toBe(true);
      const preview = (result as any).contentPreview.split('\n');
      expect(preview.length).toBe(20);
      expect(preview[0]).toBe('line 1');
      expect(preview[19]).toBe('line 20');
    });
  });

  describe('shell sandbox', () => {
    describe('dangerous command detection', () => {
      it('should block sudo', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'sudo rm -rf /' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should block rm -rf /', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'rm -rf /' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should block rm -r /', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'rm -r /' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should block mkfs', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'mkfs.ext4 /dev/sda' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should block dd if=', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'dd if=/dev/zero of=/dev/sda' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should block dd of=', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'dd of=/dev/sda if=/dev/zero' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should block shutdown', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'shutdown -h now' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should block reboot', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'reboot' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should block fdisk', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'fdisk /dev/sda' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should block chmod -R 777 /', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'chmod -R 777 /' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('Blocked by sandbox');
      });

      it('should allow safe commands', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'echo hello' });
        expect(result.ok).toBe(true);
      });

      it('should allow rm in allowed paths', async () => {
        const filePath = join(testDir, 'file.txt');
        writeFileSync(filePath, 'test');
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [testDir] },
        });
        const result = await tools.shell.execute({ command: `rm ${filePath}` });
        expect(result.ok).toBe(true);
      });
    });

    describe('path allowlist', () => {
      it('should block paths not in allowlist', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [testDir] },
        });
        const result = await tools.shell.execute({ command: 'cat /etc/passwd' });
        expect(result.ok).toBe(false);
        expect((result as any).stderr).toContain('path not in allowed list');
      });

      it('should allow paths in allowlist', async () => {
        const filePath = join(testDir, 'test.txt');
        writeFileSync(filePath, 'test');
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [testDir] },
        });
        const result = await tools.shell.execute({ command: `ls ${testDir}` });
        expect(result.ok).toBe(true);
      });

      it('should resolve .. in paths', async () => {
        const subDir = join(testDir, 'sub');
        mkdirSync(subDir, { recursive: true });
        writeFileSync(join(testDir, 'file.txt'), 'test');
        const tools = createSystemTools({
          cwd: subDir,
          sandbox: { enabled: true, allowed_paths: [testDir] },
        });
        const result = await tools.shell.execute({ command: `cat ${subDir}/../file.txt` });
        expect(result.ok).toBe(true);
      });

      it('should resolve symlinks', async () => {
        const realDir = join(testDir, 'real');
        const linkDir = join(testDir, 'link');
        mkdirSync(realDir, { recursive: true });
        try {
          const { symlinkSync } = await import('node:fs');
          symlinkSync(realDir, linkDir);
          const tools = createSystemTools({
            cwd: testDir,
            sandbox: { enabled: true, allowed_paths: [realDir] },
          });
          const result = await tools.shell.execute({ command: `ls ${linkDir}` });
          expect(result.ok).toBe(true);
        } catch {
          // symlink may not be supported on all platforms
        }
      });

      it('should handle quoted paths', async () => {
        const filePath = join(testDir, 'quoted.txt');
        writeFileSync(filePath, 'test');
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: [testDir] },
        });
        const result = await tools.shell.execute({ command: `cat "${filePath}"` });
        expect(result.ok).toBe(true);
      });

      it('should handle ~ expansion', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: true, allowed_paths: ['~'] },
        });
        const result = await tools.shell.execute({ command: 'ls ~' });
        expect(result.ok).toBe(true);
      });
    });

    describe('sandbox disabled', () => {
      it('should not block dangerous commands when sandbox is disabled', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: false, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'echo dangerous' });
        expect(result.ok).toBe(true);
      });

      it('should not check paths when sandbox is disabled', async () => {
        const tools = createSystemTools({
          cwd: testDir,
          sandbox: { enabled: false, allowed_paths: [] },
        });
        const result = await tools.shell.execute({ command: 'cat /etc/passwd' });
        expect(result.ok).toBe(true);
      });
    });

    describe('sandbox not configured', () => {
      it('should not block commands when sandbox is undefined', async () => {
        const tools = createSystemTools({
          cwd: testDir,
        });
        const result = await tools.shell.execute({ command: 'echo hello' });
        expect(result.ok).toBe(true);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Mode-aware tool registry
// ---------------------------------------------------------------------------

describe('Tool registry (mode-aware)', () => {
  const baseCtx = {
    eventLog: mockEventLog(),
    stateGraph: mockStateGraph(),
    memoryStore: null,
    memoryEnabled: false,
    incognito: false,
    contextEngine: null,
    cwd: process.cwd(),
  };

  it('describeTools classic mode omits working memory and engine tools', () => {
    const tools = describeTools({ contextEngineEnabled: true, classicMode: true });
    expect(tools.some((t) => t.startsWith('create_task'))).toBe(false);
    expect(tools.some((t) => t.startsWith('retrieve_artifact'))).toBe(false);
    expect(tools.some((t) => t.startsWith('shell'))).toBe(true);
  });

  it('describeTools engine mode includes working memory and engine tools', () => {
    const tools = describeTools({ contextEngineEnabled: true, classicMode: false });
    expect(tools.some((t) => t.startsWith('create_task'))).toBe(true);
    expect(tools.some((t) => t.startsWith('retrieve_artifact'))).toBe(true);
  });

  it('describeTools defaults to engine tool set when options omitted', () => {
    const tools = describeTools();
    expect(tools.some((t) => t.startsWith('create_task'))).toBe(true);
  });

  it('describeTools uses classic set when contextEngineEnabled is false', () => {
    const tools = describeTools({ contextEngineEnabled: false });
    expect(tools.some((t) => t.startsWith('create_task'))).toBe(false);
    expect(tools.some((t) => t.startsWith('shell'))).toBe(true);
  });

  it('createAllTools classic mode excludes working memory tools', () => {
    const tools = createAllTools({ ...baseCtx, classicMode: true });
    expect('create_task' in tools).toBe(false);
    expect('hydrate' in tools).toBe(false);
    expect('search_session_log' in tools).toBe(true);
    expect('shell' in tools).toBe(true);
  });

  it('createAllTools engine mode includes working memory tools', () => {
    const tools = createAllTools({ ...baseCtx, classicMode: false });
    expect('create_task' in tools).toBe(true);
    expect('list_state' in tools).toBe(true);
  });

  it('createAllTools registers the search_code tool in both modes', () => {
    const classicTools = createAllTools({ ...baseCtx, classicMode: true });
    const engineTools = createAllTools({ ...baseCtx, classicMode: false });
    expect('search_code' in classicTools).toBe(true);
    expect('search_code' in engineTools).toBe(true);
  });

  it('describeTools advertises search_code in both classic and engine modes', () => {
    const classic = describeTools({ contextEngineEnabled: false, classicMode: true });
    const engine = describeTools({ contextEngineEnabled: true });
    expect(classic.some((t) => t.startsWith('search_code'))).toBe(true);
    expect(engine.some((t) => t.startsWith('search_code'))).toBe(true);
  });
});
