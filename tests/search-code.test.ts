import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRipgrepArgs,
  createSearchCodeTool,
  createParseState,
  feedParseState,
  parseRipgrepEvents,
  runRipgrep,
} from '../src/tools/search-code.js';
// Probe rg at module load. Skip live integration tests if missing.
const hasRg = (() => {
  const r = spawnSync('rg', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
})();

const testDir = '/tmp/aria-test-search-code';

function setupFixture() {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, 'src'), { recursive: true });
  mkdirSync(join(testDir, 'node_modules'), { recursive: true });

  writeFileSync(
    join(testDir, 'src/a.ts'),
    [
      'export function alpha() {',
      '  return "alpha";',
      '}',
      'export function beta() {',
      '  return "beta";',
      '}',
    ].join('\n'),
  );

  writeFileSync(
    join(testDir, 'src/b.tsx'),
    [
      'export const greeting = "hello world";',
      'export const farewell = "hello darkness";',
    ].join('\n'),
  );

  writeFileSync(
    join(testDir, 'src/c.txt'),
    ['first line', 'HELLO uppercase', 'third line'].join('\n'),
  );

  // noise in node_modules (should be ignored by default)
  writeFileSync(
    join(testDir, 'node_modules/lib.ts'),
    'export const hello = "should be ignored by default";',
  );

  // hidden file (should be ignored by default)
  writeFileSync(
    join(testDir, 'src/.hidden.ts'),
    'export const hiddenHello = "shh";',
  );
}

describe('buildRipgrepArgs', () => {
  it('passes pattern as positional after -- with safe separator', () => {
    const argv = buildRipgrepArgs({ pattern: 'foo' }, '/tmp');
    const sepIdx = argv.indexOf('--');
    expect(sepIdx).toBeGreaterThan(-1);
    expect(argv[sepIdx + 1]).toBe('foo');
    expect(argv[sepIdx + 2]).toBe('/tmp');
  });

  it('adds case_insensitive flag for -i', () => {
    expect(buildRipgrepArgs({ pattern: 'foo', case_insensitive: true }, '.')).toContain('-i');
  });

  it('adds context flag for -C when context > 0', () => {
    const argv = buildRipgrepArgs({ pattern: 'foo', context: 3 }, '.');
    const i = argv.indexOf('-C');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('3');
  });

  it('does not add -C when context is 0 or undefined', () => {
    expect(buildRipgrepArgs({ pattern: 'foo' }, '.')).not.toContain('-C');
    expect(buildRipgrepArgs({ pattern: 'foo', context: 0 }, '.')).not.toContain('-C');
  });

  it('expands a single glob string into --glob', () => {
    const argv = buildRipgrepArgs({ pattern: 'foo', glob: '*.ts' }, '.');
    const i = argv.indexOf('--glob');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('*.ts');
  });

  it('expands an array of globs into multiple --glob flags', () => {
    const argv = buildRipgrepArgs({ pattern: 'foo', glob: ['*.ts', '*.tsx'] }, '.');
    const count = argv.filter((a) => a === '--glob').length;
    expect(count).toBe(2);
  });

  it('prefixes excluded globs with !', () => {
    const argv = buildRipgrepArgs(
      { pattern: 'foo', glob_exclude: ['*.test.ts', 'node_modules'] },
      '.',
    );
    const globs: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '--glob') globs.push(argv[i + 1]);
    }
    expect(globs).toContain('!*.test.ts');
    expect(globs).toContain('!node_modules');
  });

  it('combines include and exclude globs', () => {
    const argv = buildRipgrepArgs(
      { pattern: 'foo', glob: '*.ts', glob_exclude: '*.d.ts' },
      '.',
    );
    const pairs: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '--glob') pairs.push(argv[i + 1]);
    }
    expect(pairs).toContain('*.ts');
    expect(pairs).toContain('!*.d.ts');
  });

  it('passes --hidden and --no-ignore when requested', () => {
    const argv = buildRipgrepArgs(
      { pattern: 'foo', include_hidden: true, no_ignore: true },
      '.',
    );
    expect(argv).toContain('--hidden');
    expect(argv).toContain('--no-ignore');
  });

  it('passes --type and -U for multiline', () => {
    const argv = buildRipgrepArgs(
      { pattern: 'foo', file_type: 'ts', multiline: true },
      '.',
    );
    expect(argv).toContain('--type');
    expect(argv[argv.indexOf('--type') + 1]).toBe('ts');
    expect(argv).toContain('-U');
  });
});

describe('parseRipgrepEvents', () => {
  it('returns empty results for empty input', () => {
    const r = parseRipgrepEvents([], 0, undefined, () => {});
    expect(r).toEqual({
      matches: [],
      totalMatches: 0,
      filesWithMatches: 0,
      truncated: false,
    });
  });

  it('parses a single match with no context', () => {
    const events = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a.ts' },
          lines: { text: 'const x = 1;\n' },
          line_number: 1,
          submatches: [{ match: { text: 'x' }, start: 6, end: 7 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: '/x/a.ts' } } }),
      JSON.stringify({ type: 'summary', data: { stats: {} } }),
    ];
    const r = parseRipgrepEvents(events, 0, undefined, () => {});
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toEqual({
      file: '/x/a.ts',
      line: 1,
      column: 7,
      text: 'const x = 1;',
      context_before: [],
      context_after: [],
    });
    expect(r.totalMatches).toBe(1);
    expect(r.filesWithMatches).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('strips trailing newline from matched line text', () => {
    const events = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/a' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: 'no newline at end' },
          line_number: 1,
          submatches: [{ match: { text: 'no' }, start: 0, end: 2 }],
        },
      }),
    ];
    const r = parseRipgrepEvents(events, 0, undefined, () => {});
    expect(r.matches[0].text).toBe('no newline at end');
  });

  it('populates context_before and context_after from -C events', () => {
    const events = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/a' } } }),
      JSON.stringify({
        type: 'context',
        data: { path: { text: '/x/a' }, lines: { text: 'before-1\n' }, line_number: 1 },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: 'MATCH\n' },
          line_number: 2,
          submatches: [{ match: { text: 'MATCH' }, start: 0, end: 5 }],
        },
      }),
      JSON.stringify({
        type: 'context',
        data: { path: { text: '/x/a' }, lines: { text: 'after-1\n' }, line_number: 3 },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: '/x/a' } } }),
    ];
    const r = parseRipgrepEvents(events, 1, undefined, () => {});
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].context_before).toEqual(['before-1']);
    expect(r.matches[0].context_after).toEqual(['after-1']);
  });

  it('back-fills after-context for the last match in a file on end', () => {
    const events = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/a' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: 'MATCH\n' },
          line_number: 5,
          submatches: [{ match: { text: 'MATCH' }, start: 0, end: 5 }],
        },
      }),
      JSON.stringify({
        type: 'context',
        data: { path: { text: '/x/a' }, lines: { text: 'after-1\n' }, line_number: 6 },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: '/x/a' } } }),
    ];
    const r = parseRipgrepEvents(events, 1, undefined, () => {});
    expect(r.matches[0].context_after).toEqual(['after-1']);
  });

  it('handles multiple matches in one file without duplicating context lines', () => {
    // Live-attribute (on context event) and back-fill (on end event) both
    // touch the same per-file line map. With two matches, the same line can
    // be live-attributed as a context for one match AND appear in the
    // back-fill window for another. Verify neither match duplicates.
    const events = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/a' } } }),
      JSON.stringify({
        type: 'context',
        data: { path: { text: '/x/a' }, lines: { text: 'line1\n' }, line_number: 1 },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: 'match1\n' },
          line_number: 2,
          submatches: [{ match: { text: 'match1' }, start: 0, end: 6 }],
        },
      }),
      JSON.stringify({
        type: 'context',
        data: { path: { text: '/x/a' }, lines: { text: 'between\n' }, line_number: 3 },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: 'match2\n' },
          line_number: 4,
          submatches: [{ match: { text: 'match2' }, start: 0, end: 6 }],
        },
      }),
      JSON.stringify({
        type: 'context',
        data: { path: { text: '/x/a' }, lines: { text: 'after2\n' }, line_number: 5 },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: '/x/a' } } }),
    ];
    const r = parseRipgrepEvents(events, 1, undefined, () => {});
    expect(r.matches).toHaveLength(2);
    expect(r.matches[0].context_before).toEqual(['line1']);
    expect(r.matches[0].context_after).toEqual(['between']);
    expect(r.matches[1].context_before).toEqual(['between']);
    expect(r.matches[1].context_after).toEqual(['after2']);
  });
  it('skips malformed lines without throwing', () => {
    const events = [
      'not-json',
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/a' } } }),
      '{also-bad',
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: 'OK\n' },
          line_number: 1,
          submatches: [{ match: { text: 'OK' }, start: 0, end: 2 }],
        },
      }),
    ];
    const r = parseRipgrepEvents(events, 0, undefined, () => {});
    expect(r.matches).toHaveLength(1);
  });

  it('counts distinct files only once for filesWithMatches', () => {
    const mk = (line: number, sub: string) =>
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: sub + '\n' },
          line_number: line,
          submatches: [{ match: { text: sub }, start: 0, end: sub.length }],
        },
      });
    const events = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/a' } } }),
      mk(1, 'one'),
      mk(2, 'two'),
      mk(3, 'three'),
    ];
    const r = parseRipgrepEvents(events, 0, undefined, () => {});
    expect(r.totalMatches).toBe(3);
    expect(r.filesWithMatches).toBe(1);
  });

  it('sets truncated and fires onTruncate when max_results is reached', () => {
    const onTruncate = vi.fn();
    const mk = (n: number) =>
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: `m${n}\n` },
          line_number: n,
          submatches: [{ match: { text: `m${n}` }, start: 0, end: 2 }],
        },
      });
    const events = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/a' } } }),
      mk(1),
      mk(2),
      mk(3),
      mk(4),
    ];
    const r = parseRipgrepEvents(events, 0, 2, onTruncate);
    expect(r.matches).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(onTruncate).toHaveBeenCalledTimes(1);
  });

  it('feedParseState accumulates state across multiple feed calls', () => {
    const state = createParseState();
    const onTruncate = vi.fn();

    // Split a single multi-file log across 3 feed calls
    const log = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/a' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: 'm1\n' },
          line_number: 1,
          submatches: [{ match: { text: 'm1' }, start: 0, end: 2 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: '/x/a' } } }),
      JSON.stringify({ type: 'begin', data: { path: { text: '/x/b' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/b' },
          lines: { text: 'm2\n' },
          line_number: 1,
          submatches: [{ match: { text: 'm2' }, start: 0, end: 2 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: '/x/b' } } }),
    ];
    feedParseState(state, log.slice(0, 2), 0, undefined, onTruncate);
    feedParseState(state, log.slice(2, 4), 0, undefined, onTruncate);
    feedParseState(state, log.slice(4), 0, undefined, onTruncate);

    expect(state.totalMatches).toBe(2);
    expect(state.matches.map((m) => m.file)).toEqual(['/x/a', '/x/b']);
    expect(state.truncated).toBe(false);
    expect(onTruncate).not.toHaveBeenCalled();
  });

  it('feedParseState stops processing further lines once truncated', () => {
    const state = createParseState();
    const onTruncate = vi.fn();
    const mk = (n: number) =>
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/x/a' },
          lines: { text: `m${n}\n` },
          line_number: n,
          submatches: [{ match: { text: `m${n}` }, start: 0, end: 2 }],
        },
      });
    feedParseState(state, [mk(1), mk(2), mk(3)], 0, 2, onTruncate);
    expect(state.matches).toHaveLength(2);
    expect(state.truncated).toBe(true);
    expect(onTruncate).toHaveBeenCalledTimes(1);
  });
});
// ---- Live ripgrep integration ----

(hasRg ? describe : describe.skip)('runRipgrep (live rg)', () => {
  beforeEach(setupFixture);
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('finds a simple match and reports column 1-indexed', async () => {
    const r = await runRipgrep(
      { pattern: '^export function alpha' },
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].text).toBe('export function alpha() {');
    expect(r.matches[0].column).toBe(1);
    expect(r.stats.totalMatches).toBe(1);
    expect(r.stats.filesWithMatches).toBe(1);
    expect(r.stats.truncated).toBe(false);
  });

  it('returns empty matches for no hits (rg exit 1)', async () => {
    const r = await runRipgrep(
      { pattern: 'nonexistentstring' },
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(0);
    expect(r.stats.totalMatches).toBe(0);
  });

  it('respects case_insensitive flag', async () => {
    const r = await runRipgrep(
      { pattern: 'hello', case_insensitive: true },
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Should find lowercase (a.tsx, b.tsx) and uppercase (c.txt) — at least 3 matches
    expect(r.matches.length).toBeGreaterThanOrEqual(3);
  });

  it('honors max_results with truncated flag', async () => {
    const r = await runRipgrep(
      { pattern: 'hello', case_insensitive: true, max_results: 1 },
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(1);
    expect(r.stats.truncated).toBe(true);
  });

  it('sets stats.dropped=1 (>= 1) when truncated, 0 otherwise', async () => {
    const truncated = await runRipgrep(
      { pattern: 'hello', case_insensitive: true, max_results: 1 },
      'rg',
      testDir,
      undefined,
    );
    expect(truncated.ok).toBe(true);
    if (truncated.ok) {
      expect(truncated.stats.dropped).toBeGreaterThanOrEqual(1);
    }

    const complete = await runRipgrep(
      { pattern: 'function alpha' },
      'rg',
      testDir,
      undefined,
    );
    expect(complete.ok).toBe(true);
    if (complete.ok) {
      expect(complete.stats.dropped).toBe(0);
    }
  });

  it('returns context_before and context_after lines with context:1', async () => {
    // create a file with known surrounding lines
    writeFileSync(join(testDir, 'src/target.txt'), 'before-line\nTARGET line\nafter-line');
    const r = await runRipgrep(
      { pattern: 'TARGET', context: 1 },
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.matches.find((m) => m.text.includes('TARGET'));
    expect(t).toBeDefined();
    expect(t!.context_before).toContain('before-line');
    expect(t!.context_after).toContain('after-line');
  });

  it('returns regex parse error for invalid pattern (rg exit 2)', async () => {
    const r = await runRipgrep(
      { pattern: '[' }, // unclosed character class
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/ripgrep error|regex/i);
  });

  it('returns ENOENT-style error when rg binary is missing', async () => {
    const r = await runRipgrep(
      { pattern: 'foo' },
      '/no/such/path/rg-binary',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not found|ENOENT|Failed to run ripgrep/);
  });

  it('respects already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runRipgrep(
      { pattern: 'alpha' },
      'rg',
      testDir,
      undefined,
      () => ac.signal,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Interrupted/);
  });

  it('searches a specific path relative to cwd', async () => {
    const r = await runRipgrep(
      { pattern: 'function alpha', path: 'src' },
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].file).toContain('src/a.ts');
  });
  it('reports duration_ms as a non-negative number', async () => {
    const r = await runRipgrep(
      { pattern: 'alpha' },
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.duration_ms).toBe('number');
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('honors glob include filter', async () => {
    const r = await runRipgrep(
      { pattern: 'hello', case_insensitive: true, glob: '*.ts' },
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // a.tsx contains "hello world" but should be excluded by *.ts glob
    for (const m of r.matches) {
      expect(m.file).toMatch(/\.ts$/);
    }
  });

  it('honors glob_exclude to drop node_modules', async () => {
    const r = await runRipgrep(
      { pattern: 'hello', case_insensitive: true, glob_exclude: 'node_modules' },
      'rg',
      testDir,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.matches) {
      expect(m.file).not.toContain('node_modules');
    }
  });
});

(hasRg ? describe : describe.skip)('createSearchCodeTool', () => {
  beforeEach(setupFixture);
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('exposes a search_code tool with parameters schema', () => {
    const tools = createSearchCodeTool({ cwd: testDir });
    expect(tools.search_code).toBeDefined();
    expect(tools.search_code.description).toMatch(/ripgrep/i);
    expect(tools.search_code.parameters).toBeDefined();
  });
  it('runs the underlying rg end-to-end through the tool', async () => {
    const tools = createSearchCodeTool({ cwd: testDir });
    const r = (await tools.search_code.execute({
      pattern: 'function alpha',
    })) as { ok: boolean; matches: Array<{ text: string }> };
    expect(r.ok).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].text).toContain('alpha');
  });
  it('rejects invalid arguments with a structured error', async () => {
    const tools = createSearchCodeTool({ cwd: testDir });
    const r = (await tools.search_code.execute({
      pattern: '', // zod min(1) violation
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid arguments|pattern/i);
  });

  it('blocks paths outside the sandbox allowlist', async () => {
    const tools = createSearchCodeTool({
      cwd: testDir,
      sandbox: { enabled: true, allowed_paths: [join(testDir, 'src')] },
    });
    const r = (await tools.search_code.execute({
      pattern: 'function alpha',
      path: join(testDir, '..'),
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sandbox/i);
  });

  it('allows paths inside the sandbox allowlist', async () => {
    const tools = createSearchCodeTool({
      cwd: testDir,
      sandbox: { enabled: true, allowed_paths: [join(testDir, 'src')] },
    });
    const r = (await tools.search_code.execute({
      pattern: 'function alpha',
      path: 'src',
    })) as { ok: boolean; matches: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.matches).toHaveLength(1);
  });

  it('uses the rgPath override when provided', async () => {
    const tools = createSearchCodeTool({ cwd: testDir, rgPath: 'rg' });
    const r = (await tools.search_code.execute({
      pattern: 'function alpha',
    })) as { ok: boolean; matches: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.matches).toHaveLength(1);
  });

  it('returns the rg-not-found error when rgPath points at a missing binary', async () => {
    const tools = createSearchCodeTool({
      cwd: testDir,
      rgPath: '/definitely/does/not/exist/rg-aria-test',
    });
    const r = (await tools.search_code.execute({
      pattern: 'function alpha',
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found in PATH|search_code\.rg_path/);
  });
});
