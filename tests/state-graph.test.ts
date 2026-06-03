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

  it('should clear objects and reset turn state', () => {
    const sg = new StateGraph();
    // Test clear on empty
    expect(() => sg.clear()).not.toThrow();
    expect(sg.list().length).toBe(0);

    const task = sg.create('task', { title: 'Test task', status: 'todo' });
    sg.setTier(task.id, 'soft');
    const note = sg.create('note', { text: 'Test note' });
    sg.setTier(note.id, 'hard');

    sg.incrementTurn();
    sg.incrementTurn();
    expect(sg.getTurnCount()).toBe(2);

    expect(sg.list().length).toBe(2);

    sg.clear();

    expect(sg.list().length).toBe(0);
    expect(sg.getActive().length).toBe(0);
    expect(sg.getPeripheral().length).toBe(0);
    expect(sg.getTurnCount()).toBe(0);
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

  it('should auto-hydrate peripheral objects matching query keywords', () => {
    const sg = new StateGraph();

    // Create objects and demote them
    const note1 = sg.create('note', { text: 'The staging API key is STAGE_7X9K2M' });
    sg.setTier(note1.id, 'soft');

    const note2 = sg.create('note', { text: 'Production deploy checklist' });
    sg.setTier(note2.id, 'hard');

    const task = sg.create('task', { title: 'Fix login bug', status: 'todo' });
    sg.setTier(task.id, 'soft');

    // Query matching note1
    const hydrated1 = sg.autoHydrate('What is the staging API key?');
    expect(hydrated1).toContain(note1.id);
    expect(hydrated1).not.toContain(note2.id);
    expect(hydrated1).not.toContain(task.id);
    expect(sg.get(note1.id)?.tier).toBe('active');

    // Re-demote for next test
    sg.setTier(note1.id, 'soft');

    // Query matching task title
    const hydrated2 = sg.autoHydrate('Tell me about the login bug');
    expect(hydrated2).toContain(task.id);
    expect(sg.get(task.id)?.tier).toBe('active');

    // Query with no meaningful keywords should hydrate nothing
    sg.setTier(task.id, 'soft');
    const hydrated3 = sg.autoHydrate('ok');
    expect(hydrated3).toHaveLength(0);
  });

  it('should enforce at-most-one focused object and render it first in getActive', () => {
    const sg = new StateGraph();
    const first = sg.create('task', { title: 'First task', status: 'todo' });
    const second = sg.create('task', { title: 'Second task', status: 'todo' });

    expect(sg.setFocus(second.id)).toBe(true);
    expect(sg.get(first.id)?.focused).toBe(false);
    expect(sg.get(second.id)?.focused).toBe(true);

    const active = sg.getActive();
    expect(active[0].id).toBe(second.id);

    sg.setFocus(first.id);
    expect(sg.get(first.id)?.focused).toBe(true);
    expect(sg.get(second.id)?.focused).toBe(false);
    expect(sg.getActive()[0].id).toBe(first.id);
  });
});
