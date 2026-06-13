import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTestLogger, setAppLogger } from '../src/logger.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';

let dir = '';
let configPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'praana-cfg-'));
  configPath = join(dir, 'praana.config.toml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCfg(body: string) {
  writeFileSync(configPath, body, 'utf-8');
}

describe('loadConfig: [search_code]', () => {
  it('parses a valid rg_path string into search_code.rg_path', () => {
    writeCfg(`[search_code]\nrg_path = "/opt/homebrew/bin/rg"\n`);
    const cfg = loadConfig(configPath);
    expect(cfg.search_code?.rg_path).toBe('/opt/homebrew/bin/rg');
  });

  it('expands ~ in rg_path to the user home directory', () => {
    writeCfg(`[search_code]\nrg_path = "~/bin/rg"\n`);
    const cfg = loadConfig(configPath);
    expect(cfg.search_code?.rg_path).toBe(join(homedir(), 'bin', 'rg'));
  });

  it('leaves search_code undefined when the section is omitted', () => {
    writeCfg(`[llm]\nmodel = "openai/gpt-4o-mini"\n`);
    const cfg = loadConfig(configPath);
    expect(cfg.search_code).toBeUndefined();
  });

  it('warns and ignores rg_path when it is the wrong type', () => {
    const captured: string[] = [];
    setAppLogger(createTestLogger((line) => captured.push(line)));
    try {
      writeCfg(`[search_code]\nrg_path = 12345\n`);
      const cfg = loadConfig(configPath);
      expect(cfg.search_code?.rg_path).toBeUndefined();
      expect(captured.some((l) => l.includes('search_code.rg_path'))).toBe(true);
    } finally {
      setAppLogger(createTestLogger(() => {}));
    }
  });
});
