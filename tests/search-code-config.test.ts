import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTestLogger, setAppLogger } from '../src/logger.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  it('parses a valid scan_timeout_ms into search_code.scan_timeout_ms', () => {
    writeCfg(`[search_code]\nscan_timeout_ms = 10000\n`);
    const cfg = loadConfig(configPath);
    expect(cfg.search_code?.scan_timeout_ms).toBe(10000);
  });

  it('leaves search_code undefined when the section is omitted', () => {
    writeCfg(`[llm]\nmodel = "openai/gpt-4o-mini"\n`);
    const cfg = loadConfig(configPath);
    expect(cfg.search_code).toBeUndefined();
  });

  it('warns and ignores scan_timeout_ms when it is the wrong type', () => {
    const captured: string[] = [];
    setAppLogger(createTestLogger((line) => captured.push(line)));
    try {
      writeCfg(`[search_code]\nscan_timeout_ms = "not-a-number"\n`);
      const cfg = loadConfig(configPath);
      expect(cfg.search_code?.scan_timeout_ms).toBeUndefined();
      expect(captured.some((l) => l.includes('search_code.scan_timeout_ms'))).toBe(true);
    } finally {
      setAppLogger(createTestLogger(() => {}));
    }
  });

  it('warns and ignores scan_timeout_ms when non-positive', () => {
    const captured: string[] = [];
    setAppLogger(createTestLogger((line) => captured.push(line)));
    try {
      writeCfg(`[search_code]\nscan_timeout_ms = -5\n`);
      const cfg = loadConfig(configPath);
      expect(cfg.search_code?.scan_timeout_ms).toBeUndefined();
      expect(captured.some((l) => l.includes('search_code.scan_timeout_ms'))).toBe(true);
    } finally {
      setAppLogger(createTestLogger(() => {}));
    }
  });
});
