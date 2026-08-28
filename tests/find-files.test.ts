import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createFindFilesTool,
  runFindFiles,
  buildFindFilesQuery,
} from '../src/tools/find-files.js';
import { tryGetNative } from '../src/native/index.js';

async function canUseNativeSearch(): Promise<boolean> {
  return (await tryGetNative()) !== null;
}

const testDir = '/tmp/praana-test-find-files';

function setupFixture() {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, 'src'), { recursive: true });
  mkdirSync(join(testDir, 'src/components'), { recursive: true });
  mkdirSync(join(testDir, 'node_modules'), { recursive: true });

  writeFileSync(join(testDir, 'src/main.ts'), 'export const main = 1;\n');
  writeFileSync(join(testDir, 'src/components/button.tsx'), 'export const Button = () => null;\n');
  writeFileSync(join(testDir, 'src/components/card.tsx'), 'export const Card = () => null;\n');
  writeFileSync(join(testDir, 'src/utils.ts'), 'export const util = 1;\n');
  writeFileSync(join(testDir, 'README.md'), '# test\n');
  writeFileSync(join(testDir, 'node_modules/dep.ts'), 'export const dep = 1;\n');
}

describe('buildFindFilesQuery', () => {
  it('returns the pattern unchanged when no path constraint', () => {
    expect(buildFindFilesQuery({ pattern: 'button' }, testDir, testDir)).toBe('button');
  });

  it('prepends path constraint when path is provided', () => {
    const q = buildFindFilesQuery({ pattern: 'button', path: 'src' }, testDir, join(testDir, 'src'));
    expect(q).toContain('src');
    expect(q).toContain('button');
  });
});

describe('runFindFiles (live native)', async () => {
  let nativeAvailable = false;
  beforeAll(async () => {
    nativeAvailable = await canUseNativeSearch();
  });

  beforeEach(() => {
    setupFixture();
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('finds files by fuzzy name', async () => {
    if (!nativeAvailable) return;
    const r = await runFindFiles({ pattern: 'button' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
    expect(r.matches.some((m) => m.name === 'button.tsx')).toBe(true);
  });

  it('returns metadata for matches', async () => {
    if (!nativeAvailable) return;
    const r = await runFindFiles({ pattern: 'button' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.matches[0];
    expect(typeof m.file).toBe('string');
    expect(typeof m.relative_path).toBe('string');
    expect(typeof m.size).toBe('number');
    expect(typeof m.modified).toBe('number');
    expect(typeof m.git_status).toBe('string');
  });

  it('supports glob mode', async () => {
    if (!nativeAvailable) return;
    const r = await runFindFiles({ pattern: '**/*.tsx', mode: 'glob' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.length).toBeGreaterThanOrEqual(2);
    for (const m of r.matches) {
      expect(m.relative_path).toMatch(/\.tsx$/);
    }
  });

  it('scopes to a path constraint', async () => {
    if (!nativeAvailable) return;
    const r = await runFindFiles({ pattern: 'button', path: 'src/components' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.matches) {
      expect(m.relative_path).toContain('src/components');
    }
  });

  it('honors max_results', async () => {
    if (!nativeAvailable) return;
    const r = await runFindFiles({ pattern: 'tsx', max_results: 1 }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for no matches', async () => {
    if (!nativeAvailable) return;
    const r = await runFindFiles({ pattern: 'zzzznothing' }, testDir, undefined, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(0);
  });
});

describe('createFindFilesTool', async () => {
  let nativeAvailable = false;
  beforeAll(async () => {
    nativeAvailable = await canUseNativeSearch();
  });

  beforeEach(() => {
    setupFixture();
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('exposes a find_files tool with parameters schema', () => {
    const tools = createFindFilesTool({ cwd: testDir });
    expect(tools.find_files).toBeDefined();
    expect(tools.find_files.description).toMatch(/native/i);
    expect(tools.find_files.parameters).toBeDefined();
  });

  it('runs end-to-end through the tool', async () => {
    if (!nativeAvailable) return;
    const tools = createFindFilesTool({ cwd: testDir });
    const r = (await tools.find_files.execute({
      pattern: 'button',
    })) as { ok: boolean; matches: Array<{ name: string }> };
    expect(r.ok).toBe(true);
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid arguments', async () => {
    const tools = createFindFilesTool({ cwd: testDir });
    const r = (await tools.find_files.execute({
      pattern: '',
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid arguments|pattern/i);
  });
});
