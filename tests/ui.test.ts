import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setUiWriters,
  printBox,
  printToolCall,
  printDebugBlock,
  printToolBlockStart,
  printToolCallDebug,
  printToolResultDebug,
  printToolBlockEnd,
  printDebug,
  printMemoryBanner,
  startSpinner,
  stopSpinner,
} from '../src/ui.js';

describe('UI', () => {
  let stderrOutput: string;
  let stdoutBreaks: number;

  beforeEach(() => {
    stderrOutput = '';
    stdoutBreaks = 0;
    setUiWriters({
      stderr: (line: string) => { stderrOutput += line; },
      breakStdout: () => { stdoutBreaks++; },
    });
  });

  afterEach(() => {
    setUiWriters(); // reset to defaults
  });

  describe('printBox', () => {
    it('should output content in a box', () => {
      printBox('Hello world');
      expect(stderrOutput).toContain('Hello world');
      expect(stderrOutput).toContain('│');
    });

    it('should do nothing for empty content', () => {
      printBox('');
      expect(stderrOutput).toBe('');
    });

    it('should render whitespace content', () => {
      printBox('  ');
      expect(stderrOutput).toContain('│');
    });

    it('should support title and border color options', () => {
      printBox('Content', { title: 'My Title', borderColor: 'red' });
      expect(stderrOutput).toContain('Content');
      expect(stderrOutput).toContain('My Title');
    });

    it('should support custom padding', () => {
      printBox('Content', { padding: 2 });
      expect(stderrOutput).toContain('Content');
      const lines = stderrOutput.split('\n');
      expect(lines.length).toBeGreaterThan(4);
    });
  });

  describe('printToolCall', () => {
    it('should print tool call with args summary', () => {
      printToolCall('read_file', { path: '/foo/bar.txt' });
      expect(stderrOutput).toContain('read_file');
      expect(stderrOutput).toContain('foo/bar');
    });

    it('should break stdout before and after', () => {
      const before = stdoutBreaks;
      printToolCall('shell', { command: 'ls' });
      expect(stdoutBreaks).toBe(before + 2);
    });

    it('should handle empty args gracefully', () => {
      printToolCall('list_state', {});
      expect(stderrOutput).toContain('list_state');
    });
  });

  describe('printDebugBlock', () => {
    it('should render a debug block with tool calls and results', () => {
      printDebugBlock(1, [
        { toolName: 'shell', args: { command: 'ls' } },
      ], [
        { toolName: 'shell', result: { ok: true, stdout: 'file1\nfile2', exitCode: 0 } },
      ]);
      expect(stderrOutput).toContain('step 1');
      expect(stderrOutput).toContain('shell');
    });

    it('should do nothing for empty arrays', () => {
      printDebugBlock(1, [], []);
      expect(stderrOutput).toBe('');
    });

    it('should handle error results', () => {
      printDebugBlock(2, [
        { toolName: 'read_file', args: { path: 'missing.txt' } },
      ], [
        { toolName: 'read_file', result: { ok: false, error: 'File not found' } },
      ]);
      expect(stderrOutput).toContain('error');
      expect(stderrOutput).toContain('read_file');
    });
  });

  describe('printToolBlockStart', () => {
    it('should print a debug header with step number', () => {
      printToolBlockStart(3);
      expect(stderrOutput).toContain('step 3');
    });
  });

  describe('printToolCallDebug', () => {
    it('should print tool name and args', () => {
      printToolCallDebug('shell', { command: 'echo hi' });
      expect(stderrOutput).toContain('shell');
      expect(stderrOutput).toContain('echo hi');
    });

    it('should truncate args over 200 chars', () => {
      const longStr = 'x'.repeat(300);
      printToolCallDebug('shell', { command: longStr });
      expect(stderrOutput).toContain('...');
      expect(stderrOutput.length).toBeLessThan(400);
    });
  });

  describe('printToolResultDebug', () => {
    it('should print tool result summary', () => {
      printToolResultDebug('shell', { ok: true, stdout: 'hello', exitCode: 0 });
      expect(stderrOutput).toContain('shell');
    });

    it('should handle null/undefined result', () => {
      printToolResultDebug('shell', null);
      expect(stderrOutput).toContain('done');
    });
  });

  describe('printToolBlockEnd', () => {
    it('should print a debug footer', () => {
      printToolBlockEnd();
      expect(stderrOutput).toBeTruthy();
    });
  });

  describe('printDebug', () => {
    it('should print a debug message', () => {
      printDebug('Test message');
      expect(stderrOutput).toContain('Test message');
    });
  });

  describe('printMemoryBanner', () => {
    it('should print state stats when non-zero', () => {
      printMemoryBanner({
        activeState: 3,
        totalState: 10,
        digestLen: 0,
        recallCalls: 0,
        recallHits: 0,
        autoHydrated: 0,
      });
      expect(stderrOutput).toContain('3/10');
    });

    it('should print digest length when present', () => {
      printMemoryBanner({
        activeState: 0,
        totalState: 0,
        digestLen: 500,
        recallCalls: 0,
        recallHits: 0,
        autoHydrated: 0,
      });
      expect(stderrOutput).toContain('digest');
    });

    it('should print recall stats when calls > 0', () => {
      printMemoryBanner({
        activeState: 0,
        totalState: 0,
        digestLen: 0,
        recallCalls: 3,
        recallHits: 2,
        autoHydrated: 0,
      });
      expect(stderrOutput).toContain('recall');
      expect(stderrOutput).toContain('2h');
    });

    it('should print auto-hydrated count', () => {
      printMemoryBanner({
        activeState: 0,
        totalState: 0,
        digestLen: 0,
        recallCalls: 0,
        recallHits: 0,
        autoHydrated: 5,
      });
      expect(stderrOutput).toContain('auto+5');
    });

    it('should print prompt tokens', () => {
      printMemoryBanner({
        activeState: 0,
        totalState: 0,
        digestLen: 0,
        recallCalls: 0,
        recallHits: 0,
        autoHydrated: 0,
        promptTokens: 2048,
      });
      expect(stderrOutput).toContain('prompt');
      expect(stderrOutput).toContain('2048t');
    });

    it('should do nothing when all stats are zero and no prompt tokens', () => {
      printMemoryBanner({
        activeState: 0,
        totalState: 0,
        digestLen: 0,
        recallCalls: 0,
        recallHits: 0,
        autoHydrated: 0,
      });
      expect(stderrOutput).toBe('');
    });

    it('should combine multiple stats', () => {
      printMemoryBanner({
        activeState: 2,
        totalState: 5,
        digestLen: 300,
        recallCalls: 1,
        recallHits: 1,
        autoHydrated: 1,
        promptTokens: 1500,
      });
      expect(stderrOutput).toContain('2/5');
      expect(stderrOutput).toContain('digest 300c');
      expect(stderrOutput).toContain('1h');
      expect(stderrOutput).toContain('auto+1');
      expect(stderrOutput).toContain('1500t');
    });
  });
});
