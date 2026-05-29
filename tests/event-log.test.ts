import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventLog, migrateLegacyEventLog } from '../src/event-log.js';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import type { Event } from '../src/types.js';
import { join } from 'node:path';

describe('EventLog', () => {
  const testLogDir = '/tmp/aria-test-logs';
  let eventLog: EventLog;

  beforeEach(() => {
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true });
    }
    eventLog = new EventLog('test-session-1', testLogDir);
  });

  afterEach(() => {
    eventLog.close();
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true });
    }
  });

  it('should append events', () => {
    eventLog.append({
      kind: 'user_message',
      actor: 'user',
      payload: { text: 'Hello' },
    });

    const events = eventLog.readLast(10);
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('user_message');
    expect((events[0].payload as any).text).toBe('Hello');
  });

  it('should assign event IDs', () => {
    eventLog.append({
      kind: 'user_message',
      actor: 'user',
      payload: { text: 'Test' },
    });

    const events = eventLog.readLast(10);
    expect(events[0].event_id).toBeTruthy();
    expect(events[0].session_id).toBe('test-session-1');
  });

  it('should read last N events', () => {
    for (let i = 0; i < 5; i++) {
      eventLog.append({
        kind: 'user_message',
        actor: 'user',
        payload: { text: `Message ${i}` },
      });
    }

    const last3 = eventLog.readLast(3);
    expect(last3.length).toBe(3);
    expect((last3[2].payload as any).text).toBe('Message 4');
  });

  it('should search events by query', () => {
    eventLog.append({
      kind: 'agent_message',
      actor: 'agent',
      payload: { text: 'Found 4 issues in the code review' },
    });
    eventLog.append({
      kind: 'user_message',
      actor: 'user',
      payload: { text: 'list the other issues' },
    });
    eventLog.append({
      kind: 'agent_message',
      actor: 'agent',
      payload: { text: 'Unrelated message about deployment' },
    });

    const matches = eventLog.search('issue review');
    expect(matches.length).toBe(1);
    expect(matches[0].event.kind).toBe('agent_message');
    expect(matches[0].excerpt).toContain('4 issues');
  });

  it('should support OR search with pipe', () => {
    eventLog.append({
      kind: 'agent_message',
      actor: 'agent',
      payload: { text: 'deployment complete' },
    });
    eventLog.append({
      kind: 'user_message',
      actor: 'user',
      payload: { text: 'show review findings' },
    });

    const matches = eventLog.search('issue|review');
    expect(matches.length).toBe(1);
    expect((matches[0].event.payload as { text: string }).text).toContain('review');
  });

  it('should filter search by kind', () => {
    eventLog.append({
      kind: 'user_message',
      actor: 'user',
      payload: { text: 'find the bug' },
    });
    eventLog.append({
      kind: 'tool_call',
      actor: 'tool',
      payload: { tool: 'read_file', args: { path: 'bug.ts' } },
    });

    const matches = eventLog.search('bug', { kinds: ['tool_call'] });
    expect(matches.length).toBe(1);
    expect(matches[0].event.kind).toBe('tool_call');
  });

  it('should migrate legacy events.log to events.jsonl on open', () => {
    const sessionDir = join(testLogDir, 'migrate-session');
    mkdirSync(sessionDir, { recursive: true });
    const legacyLine = JSON.stringify({
      event_id: 'legacy-1',
      session_id: 'migrate-session',
      timestamp: 1,
      kind: 'user_message',
      actor: 'user',
      payload: { text: 'from legacy log' },
    }) + '\n';
    writeFileSync(join(sessionDir, 'events.log'), legacyLine);

    const migrated = new EventLog('migrate-session', testLogDir);
    const events = migrated.readAll();
    migrated.close();

    expect(existsSync(join(sessionDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(sessionDir, 'events.log'))).toBe(false);
    expect(events.length).toBe(1);
    expect((events[0].payload as { text: string }).text).toBe('from legacy log');
  });

  it('should merge legacy events.log when events.jsonl already exists', () => {
    const sessionDir = join(testLogDir, 'merge-session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'events.jsonl'), '');
    writeFileSync(
      join(sessionDir, 'events.log'),
      JSON.stringify({
        event_id: 'legacy-2',
        session_id: 'merge-session',
        timestamp: 2,
        kind: 'user_message',
        actor: 'user',
        payload: { text: 'merged from log' },
      }) + '\n'
    );

    migrateLegacyEventLog(sessionDir);

    expect(existsSync(join(sessionDir, 'events.log'))).toBe(false);
    const content = readFileSync(join(sessionDir, 'events.jsonl'), 'utf-8');
    expect(content).toContain('merged from log');
  });

  it('should replay context actions', () => {
    eventLog.append({
      kind: 'context_action',
      actor: 'kernel',
      payload: { action: 'create', id: '123', kind: 'task' },
    });
    eventLog.append({
      kind: 'user_message',
      actor: 'user',
      payload: { text: 'Hello' },
    });

    const actions = eventLog.replayContextActions();
    expect(actions.length).toBe(1);
    expect(actions[0].payload.action).toBe('create');
  });
});
