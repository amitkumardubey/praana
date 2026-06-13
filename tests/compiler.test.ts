import { describe, it, expect } from 'vitest';
import { compile, compileWithMetrics } from '../src/compiler.js';
import type { StateObject, Event } from '../src/types.js';

describe('Compiler', () => {
  it('should compile prompt with empty state', () => {
    const prompt = compile({
      stateGraph: {
        list: () => [],
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: null,
      recentEvents: [],
      toolSchemas: [],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 4000,
    });

    expect(prompt).toContain('PRAANA');
    expect(prompt).toContain('coding agent');
    expect(prompt).toContain('tools');
  });

  it('should include state objects in prompt', () => {
    const stateObjects: StateObject[] = [
      {
        id: '01TEST123',
        kind: 'task',
        tier: 'active',
        payload: { title: 'Test task', description: 'Do something', status: 'todo' },
        created: Date.now(),
        updated: Date.now(),
        lastTouched: Date.now(),
      } as any,
    ];

    const prompt = compile({
      stateGraph: {
        list: () => stateObjects.map(o => ({
          id: o.id,
          kind: o.kind,
          tier: o.tier,
          summary: 'Test task',
        })),
        getActive: () => stateObjects,
        getPeripheral: () => [],
      } as any,
      memoryDigest: null,
      recentEvents: [],
      toolSchemas: ['create_task(title) — Create a task'],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 4000,
    });

    expect(prompt).toContain('Test task');
    expect(prompt).toContain('# Active State');
  });

  it('should include memory digest when available', () => {
    const prompt = compile({
      stateGraph: {
        list: () => [],
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: '## User Preferences\n- Prefers 2-space indentation',
      recentEvents: [],
      toolSchemas: [],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 4000,
    });

    expect(prompt).toContain('# Cross-Session Memory');
    expect(prompt).toContain('2-space indentation');
  });

  it('should truncate recent turns based on token budget', () => {
    // Create events that exceed the token budget for Recent Turns
    const events: Event[] = [];
    const longText = 'A'.repeat(1000); // 1000 chars ≈ 250 tokens

    // Add multiple events to exceed the budget
    for (let i = 0; i < 10; i++) {
      events.push({
        event_id: `evt-${i}`,
        session_id: 'test',
        timestamp: Date.now(),
        kind: 'user_message',
        actor: 'user',
        payload: { text: `Message ${i}: ${longText}` },
      });
    }

    const prompt = compile({
      stateGraph: {
        list: () => [],
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: null,
      recentEvents: events,
      toolSchemas: [],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 4000,
      recentTurnsTokenBudget: 100, // Very small budget to trigger truncation
    });

    expect(prompt).toContain('# Recent Turns');
    expect(prompt).toContain('(truncated due to token budget)');
  });

  it('should apply different truncation limits for different tools', () => {
    const events: Event[] = [
      {
        event_id: 'evt-1',
        session_id: 'test',
        timestamp: Date.now(),
        kind: 'tool_result',
        actor: 'tool',
        payload: {
          tool: 'shell',
          result: 'S'.repeat(600), // 600 chars - should be truncated to 500
        },
      },
      {
        event_id: 'evt-2',
        session_id: 'test',
        timestamp: Date.now(),
        kind: 'tool_result',
        actor: 'tool',
        payload: {
          tool: 'write_file',
          result: 'W'.repeat(300), // 300 chars - should be truncated to 200
        },
      },
    ];

    const prompt = compile({
      stateGraph: {
        list: () => [],
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: null,
      recentEvents: events,
      toolSchemas: [],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 4000,
    });

    // Check that shell result is truncated to 500 chars
    expect(prompt).toContain('Result: ' + 'S'.repeat(500) + '...');
    // Check that write_file result is truncated to 200 chars
    expect(prompt).toContain('Result: ' + 'W'.repeat(200) + '...');
  });

  it('should include evidence-first assertion checklist in system frame', () => {
    const prompt = compile({
      stateGraph: {
        list: () => [],
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: null,
      recentEvents: [],
      toolSchemas: [],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 4000,
    });

    expect(prompt).toContain('## Evidence-First Assertions');
    expect(prompt).toContain('search_session_log or re-read the source');
    expect(prompt).toContain('negative claims like "X is not implemented"');
  });

  it('should include claim-verification guardrails in system frame', () => {
    const prompt = compile({
      stateGraph: {
        list: () => [],
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: null,
      recentEvents: [],
      toolSchemas: [],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 4000,
    });

    expect(prompt).toContain('search_session_log');
  });

  it('should include Tool Safety RULE in system frame', () => {
    const prompt = compile({
      stateGraph: {
        list: () => [],
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: null,
      recentEvents: [],
      toolSchemas: [],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 4000,
    });

    expect(prompt).toContain('## Tool Safety');
    expect(prompt).toContain('RULE: Never call write_file, edit_file');
    expect(prompt).toContain('shell commands with file write side-effects');
    expect(prompt).toContain('If unsure, ask first.');
  });

  it('should enforce per-section memory token ceiling in compileWithMetrics', () => {
    const hugeDigest = ['## Facts', ...Array.from({ length: 200 }, (_, i) => `- Memory item ${i} ${'x'.repeat(80)}`)].join('\n');
    const { prompt, metrics } = compileWithMetrics({
      stateGraph: {
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: hugeDigest,
      recentEvents: [],
      toolSchemas: [],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 10_000,
      memoriesBudgetRatio: 0.05,
      agentsBudgetRatio: 0.3,
    });

    expect(metrics.memoryTruncated).toBe(true);
    expect(prompt).toContain('memory section truncated');
    expect(metrics.crossSessionTokens).toBeLessThanOrEqual(Math.floor(10_000 * 0.05) + 5);
  });
});
