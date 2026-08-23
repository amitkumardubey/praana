import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFffConstraints,
  buildFffGrepQuery,
  createSearchCodeTool,
  runFffSearch,
} from '../src/tools/search-code.js';
import {
  fileTypeToConstraint,
  pathToConstraint,
  buildFffQuery,
  clearFffCache,
} from '../src/fff.js';

const testDir = '/tmp/praana-test-search-code';

async function canUseFff(): Promise<boolean> {
  try {
    const { FileFinder } = await import('@ff-labs/fff-bun');
    return FileFinder.isAvailable();
  } catch {
    return false;
  }
}

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

  writeFileSync(join(testDir, 'src/c.txt'), ['first line', 'HELLO uppercase', 'third line'].join('\n'));

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

describe('fff query helpers', () => {
  it('buildFffQuery prepends constraints before the pattern', () => {
    expect(buildFffQuery('foo', ['*.ts', 'src/'])).toBe('*.ts src/ foo');
    expect(buildFffQuery('foo', [])).toBe('foo');
    expect(buildFffQuery('foo', ['', 'src/'])).toBe('src/ foo');
  });

  it('fileTypeToConstraint maps known types to extension globs', () => {
    expect(fileTypeToConstraint('ts')).toBe('*.ts');
    expect(fileTypeToConstraint('rust')).toBe('*.rs');
    expect(fileTypeToConstraint('unknown')).toBe('*.unknown');
  });

  it('pathToConstraint converts absolute path under basePath to relative', () => {
    expect(pathToConstraint(testDir, join(testDir, 'src'))).toBe('src/');
    expect(pathToConstraint(testDir, 'src')).toBe('src/');
    expect(pathToConstraint(testDir, testDir)).toBeNull();
    expect(pathToConstraint(testDir, '/outside/base')).toBeNull();
  });

  it('buildFffConstraints includes path, file_type, globs, excludes', () => {
    const c = buildFffConstraints(
      { pattern: 'foo', path: 'src', file_type: 'ts', glob: '*.tsx', glob_exclude: 'node_modules' },
      testDir,
      join(testDir, 'src'),
    );
    expect(c).toContain('src/');
    expect(c).toContain('*.ts');
    expect(c).toContain('*.tsx');
    expect(c).toContain('!node_modules');
  });

  it('buildFffGrepQuery prefixes (?i) for case_insensitive in regex mode', () => {
    const q = buildFffGrepQuery({ pattern: 'hello', case_insensitive: true }, testDir, testDir);
    expect(q).toMatch(/^\(\?i\)hello/);
  });
});

describe('runFffSearch (live fff)', async () => {
  let fffAvailable = false;
  beforeAll(async () => {
    fffAvailable = await canUseFff();
  });

  beforeEach(() => {
    setupFixture();
    clearFffCache();
  });
  afterEach(() => {
    clearFffCache();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('finds a simple match and reports column 1-indexed', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    const r = await runFffSearch({ pattern: 'alpha' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.matches.find((x) => x.text.includes('alpha'));
    expect(m).toBeDefined();
    expect(m!.text).toBe('export function alpha() {');
    expect(m!.column).toBeGreaterThanOrEqual(1);
    expect(r.stats.totalMatches).toBeGreaterThanOrEqual(1);
    expect(r.stats.filesWithMatches).toBeGreaterThanOrEqual(1);
  });

  it('returns empty matches for no hits', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    const r = await runFffSearch({ pattern: 'nonexistentstring' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(0);
    expect(r.stats.totalMatches).toBe(0);
  });

  it('respects case_insensitive flag', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    const r = await runFffSearch({ pattern: 'HELLO', case_insensitive: true }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Should find uppercase c.txt
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('honors max_results', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    const r = await runFffSearch({ pattern: 'export', max_results: 1 }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.length).toBeLessThanOrEqual(1);
  });

  it('returns context_before and context_after lines with context:1', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    writeFileSync(join(testDir, 'src/target.txt'), 'before-line\nTARGET line\nafter-line');
    const r = await runFffSearch({ pattern: 'TARGET', context: 1 }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.matches.find((m) => m.text.includes('TARGET'));
    expect(t).toBeDefined();
    expect(t!.context_before).toContain('before-line');
    expect(t!.context_after).toContain('after-line');
  });

  it('searches a specific path relative to cwd', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    const r = await runFffSearch({ pattern: 'alpha', path: 'src' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
    for (const m of r.matches) {
      expect(m.file).toContain('src');
    }
  });

  it('reports duration_ms as a non-negative number', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    const r = await runFffSearch({ pattern: 'alpha' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.duration_ms).toBe('number');
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('honors glob_exclude to drop node_modules', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    const r = await runFffSearch(
      { pattern: 'hello', case_insensitive: true, glob_exclude: 'node_modules' },
      testDir,
      undefined,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.matches) {
      expect(m.file).not.toContain('node_modules');
    }
  });

  it('surfaces regex_fallback when fff falls back from regex to literal', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    // 'foo(' is an invalid regex (unclosed group) — fff should fall back to literal
    const r = await runFffSearch({ pattern: 'foo(' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toHaveProperty('regex_fallback');
    expect(typeof r.regex_fallback).toBe('string');
  });
});

describe('createSearchCodeTool', async () => {
  let fffAvailable = false;
  beforeAll(async () => {
    fffAvailable = await canUseFff();
  });

  beforeEach(() => {
    setupFixture();
    clearFffCache();
  });
  afterEach(() => {
    clearFffCache();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('exposes a search_code tool with parameters schema', () => {
    const tools = createSearchCodeTool({ cwd: testDir });
    expect(tools.search_code).toBeDefined();
    expect(tools.search_code.description).toMatch(/fff/i);
    expect(tools.search_code.parameters).toBeDefined();
  });

  it('runs the underlying fff end-to-end through the tool', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    const tools = createSearchCodeTool({ cwd: testDir });
    const r = (await tools.search_code.execute({
      pattern: 'alpha',
    })) as { ok: boolean; matches: Array<{ text: string }> };
    expect(r.ok).toBe(true);
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
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
      pattern: 'alpha',
      path: join(testDir, '..'),
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sandbox/i);
  });

  it('allows paths inside the sandbox allowlist', async () => {
    if (!fffAvailable) throw new Error('fff not available');
    const tools = createSearchCodeTool({
      cwd: testDir,
      sandbox: { enabled: true, allowed_paths: [join(testDir, 'src')] },
    });
    const r = (await tools.search_code.execute({
      pattern: 'alpha',
      path: 'src',
    })) as { ok: boolean; matches: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
  });
});
