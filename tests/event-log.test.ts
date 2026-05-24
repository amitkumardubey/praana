import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventLog } from '../src/event-log.js';
import type { Event } from '../src/types.js';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
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
