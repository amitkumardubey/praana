import { describe, it, expect } from 'vitest';
import { marked, type Tokens } from 'marked';
import { extractCellText, computeColWidths } from '../src/ui/tui/markdown-render.js';

describe('Markdown token processing', () => {
  it('should extract text from string cells', () => {
    const cell = { text: 'hello', tokens: [] };
    expect(extractCellText(cell)).toBe('hello');
  });

  it('should extract text from token cells', () => {
    const cell = { text: undefined as unknown as string, tokens: ['foo ', { raw: 'bar', type: 'text' } as Tokens.Text] };
    expect(extractCellText(cell)).toBe('foo bar');
  });

  it('should compute column widths from header and body', () => {
    const header = ['Name', 'Ver'];
    const body = [['alpha', '1.0'], ['short', '2.3.4']];
    const widths = computeColWidths(header, body);
    expect(widths).toEqual([5, 5]);
  });

  it('should enforce minimum column width of 4', () => {
    const widths = computeColWidths(['a'], [['b']]);
    expect(widths[0]).toBe(4);
  });

  it('should cap column width at 40', () => {
    const long = 'x'.repeat(100);
    const widths = computeColWidths([long], [[long]]);
    expect(widths[0]).toBe(40);
  });

  it('should handle tables with varying row widths', () => {
    const header = ['Col'];
    const body = [['a'], ['bb'], ['ccc'], ['dddd']];
    const widths = computeColWidths(header, body);
    expect(widths[0]).toBe(4);
  });

  it('should handle empty body rows', () => {
    const header = ['H1', 'H2'];
    const widths = computeColWidths(header, []);
    expect(widths).toEqual([4, 4]);
  });
});
