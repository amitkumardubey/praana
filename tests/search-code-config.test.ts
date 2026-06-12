import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';

let dir = '';
let configPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aria-cfg-'));
  configPath = join(dir, 'aria.config.toml');
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
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (...args: unknown[]) => {
      captured.push(args.join(' '));
    };
    try {
      // TOML coerces numbers — a number would not actually parse as a string,
      // but a quoted number string should also be tolerated. The real test is
      // that loadConfig never throws on bad input.
      writeCfg(`[search_code]\nrg_path = 12345\n`);
      const cfg = loadConfig(configPath);
      // After validation, rg_path should be cleared back to undefined.
      expect(cfg.search_code?.rg_path).toBeUndefined();
      expect(captured.some((l) => l.includes('search_code.rg_path'))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });
});
