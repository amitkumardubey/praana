import { describe, it, expect } from 'vitest';
import { StateGraph } from '../src/state-graph.js';
import type { TaskPayload, StateObjectKind } from '../src/types.js';

describe('StateGraph', () => {
  it('should create objects', () => {
    const sg = new StateGraph();
    const task: TaskPayload = { title: 'Test task', status: 'todo' };
    const obj = sg.create('task', task);

    expect(obj.kind).toBe('task');
    expect(obj.tier).toBe('active');
    expect((obj.payload as TaskPayload).title).toBe('Test task');
    expect(obj.id).toBeTruthy();
  });

  it('should list objects', () => {
    const sg = new StateGraph();
    const task = sg.create('task', { title: 'Task 1', status: 'todo' });
    const note = sg.create('note', { text: 'Note 1' });

    const list = sg.list();
    expect(list.length).toBe(2);
    // Objects sorted by created time - find by id to be robust
    const taskItem = list.find(i => i.id === task.id);
    const noteItem = list.find(i => i.id === note.id);
    expect(taskItem?.kind).toBe('task');
    expect(noteItem?.kind).toBe('note');
  });

  it('should update objects', () => {
    const sg = new StateGraph();
    const obj = sg.create('task', { title: 'Original', status: 'todo' });

    const updated = sg.update(obj.id, { status: 'doing' });
    expect(updated).toBeTruthy();
    expect((updated!.payload as TaskPayload).status).toBe('doing');
  });

  it('should set tier', () => {
    const sg = new StateGraph();
    const obj = sg.create('task', { title: 'Test', status: 'todo' });

    const result = sg.setTier(obj.id, 'soft');
    expect(result).toBe(true);

    const retrieved = sg.get(obj.id);
    expect(retrieved?.tier).toBe('soft');
  });

  it('should get active objects', () => {
    const sg = new StateGraph();
    const obj1 = sg.create('task', { title: 'Active', status: 'todo' });
    sg.setTier(obj1.id, 'soft');

    const active = sg.getActive();
    expect(active.length).toBe(0);
  });

  it('should get peripheral objects', () => {
    const sg = new StateGraph();
    const obj1 = sg.create('task', { title: 'Soft', status: 'todo' });
    sg.setTier(obj1.id, 'soft');

    const peripheral = sg.getPeripheral();
    expect(peripheral.length).toBe(1);
    expect(peripheral[0].tier).toBe('soft');
  });

  it('should replay actions for session resume', () => {
    const sg = new StateGraph();

    sg.replayAction({
      action: 'create',
      id: 'test-id-1',
      kind: 'task',
      tier: 'active',
      statePayload: { title: 'Resumed task', status: 'todo' },
      created: Date.now(),
      updated: Date.now(),
      lastTouched: Date.now(),
    });

    const obj = sg.get('test-id-1');
    expect(obj).toBeTruthy();
    expect(obj?.kind).toBe('task');
  });
});
