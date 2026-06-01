import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemoryTools } from '../src/tools/memory.js';
import { createKnowledgeTools } from '../src/tools/knowledge.js';
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
    list: vi.fn(() => Array.from(store.values())),
    getActive: vi.fn(() => Array.from(store.values()).filter((o: any) => o.tier === 'active')),
    getPeripheral: vi.fn(() => Array.from(store.values()).filter((o: any) => o.tier !== 'active')),
    getById: vi.fn((id: string) => store.get(id) ?? null),
  } as unknown as StateGraph;
}

function mockMemoryStore(): MemoryStore {
  return {
    recall: vi.fn().mockResolvedValue({ entries: [] }),
    remember: vi.fn().mockResolvedValue({ id: 'mem-1' }),
    digest: vi.fn().mockResolvedValue(null),
    sessionStart: vi.fn().mockResolvedValue(undefined),
    sessionEnd: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
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

describe('Knowledge Tools (createKnowledgeTools)', () => {
  let eventLog: EventLog;
  let memoryStore: MemoryStore;
  let tools: ReturnType<typeof createKnowledgeTools>;

  beforeEach(() => {
    eventLog = mockEventLog();
    memoryStore = mockMemoryStore();
    tools = createKnowledgeTools({ eventLog, memoryStore, memoryEnabled: true, incognito: false });
  });

  describe('recall', () => {
    it('should search memory and return entries', async () => {
      const entries = [
        { id: 'm1', content: 'Test memory', kind: 'fact', confidence: 0.9, scope: ['user:a'], created: 100, updated: 100 },
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
      const toolsDisabled = createKnowledgeTools({ eventLog, memoryStore, memoryEnabled: false, incognito: false });
      const result = await toolsDisabled.recall.execute({ query: 'test' });
      expect(result).toEqual({ ok: false, error: 'Cross-session memory is not available.' });
    });

    it('should return error when memory store is null', async () => {
      const toolsNull = createKnowledgeTools({ eventLog, memoryStore: null, memoryEnabled: true, incognito: false });
      const result = await toolsNull.recall.execute({ query: 'test' });
      expect(result).toEqual({ ok: false, error: 'Cross-session memory is not available.' });
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
      const toolsDisabled = createKnowledgeTools({ eventLog, memoryStore, memoryEnabled: false, incognito: false });
      const result = await toolsDisabled.remember.execute({ content: 'test' });
      expect(result).toEqual({ ok: false, error: 'Cross-session memory is not available.' });
    });

    it('should handle remember errors gracefully', async () => {
      (memoryStore.remember as any).mockRejectedValue(new Error('Storage error'));
      const result = await tools.remember.execute({ content: 'test' });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('Storage error');
    });
  });
});

// ---------------------------------------------------------------------------
// System Tools Tests
// ---------------------------------------------------------------------------

describe('System Tools (createSystemTools)', () => {
  const testDir = '/tmp/aria-test-tools';
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
        newText: 'ARIA',
      });
      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(testDir, 'edit.txt'), 'utf-8')).toBe('Hello ARIA');
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
  });
});
