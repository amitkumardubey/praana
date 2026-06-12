import { describe, it, expect } from 'vitest';
import { marked, type Tokens } from 'marked';
import {
  extractCellText,
  computeColWidths,
  plainTextFromInlineTokens,
} from '../src/ui/tui/markdown-render.js';

describe('Markdown token processing', () => {
  it('should extract text from string cells', () => {
    const cell = { text: 'hello', tokens: [] };
    expect(extractCellText(cell)).toBe('hello');
  });

  it('should extract text from token cells', () => {
    const cell = { text: undefined as unknown as string, tokens: ['foo ', { raw: 'bar', type: 'text' } as Tokens.Text] };
    expect(extractCellText(cell)).toBe('foo bar');
  });

  it('should flatten bold markdown inside table cells', () => {
    const tokens = marked.lexer('| Val |\n| --- |\n| **+578** |');
    const table = tokens.find((t) => t.type === 'table') as Tokens.Table;
    const cell = table.rows[0]![0]!;
    expect(extractCellText(cell)).toBe('+578');
    expect(cell.text).toBe('**+578**');
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

  it('should cap column width relative to terminal width', () => {
    const long = 'x'.repeat(100);
    const widths = computeColWidths([long], [[long]], 80);
    expect(widths[0]).toBeLessThanOrEqual(48);
    expect(widths[0]).toBeGreaterThanOrEqual(8);
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

  it('should flatten nested inline tokens inside list items', () => {
    const tokens = marked.lexer('- **Write or edit code** — features');
    const list = tokens.find((t) => t.type === 'list') as import('marked').Tokens.List;
    const itemTokens = list.items[0]!.tokens;
    expect(plainTextFromInlineTokens(itemTokens)).toBe(
      'Write or edit code — features'
    );
  });

  it('should flatten bold in paragraphs', () => {
    const tokens = marked.lexer('Hello **world**');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as import('marked').Tokens.Paragraph;
    expect(plainTextFromInlineTokens(paragraph.tokens)).toBe('Hello world');
  });

  it('should flatten bold inside table cells', () => {
    const tokens = marked.lexer('| Val |\n| --- |\n| **+578** |');
    const table = tokens.find((t) => t.type === 'table') as Tokens.Table;
    const cell = table.rows[0]![0]!;
    expect(extractCellText(cell)).toBe('+578');
  });

  it('should flatten code spans inside table cells', () => {
    const tokens = marked.lexer('| Key |\n| --- |\n| `foo` |');
    const table = tokens.find((t) => t.type === 'table') as Tokens.Table;
    expect(extractCellText(table.rows[0]![0]!)).toBe('foo');
  });

  it('should flatten strikethrough inline tokens', () => {
    const tokens = marked.lexer('~~removed~~');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as import('marked').Tokens.Paragraph;
    expect(plainTextFromInlineTokens(paragraph.tokens)).toBe('removed');
  });

  it('should flatten bold inside blockquotes', () => {
    const tokens = marked.lexer('> **Important** note');
    const quote = tokens.find((t) => t.type === 'blockquote') as import('marked').Tokens.Blockquote;
    const paragraph = quote.tokens.find((t) => t.type === 'paragraph') as import('marked').Tokens.Paragraph;
    expect(plainTextFromInlineTokens(paragraph.tokens)).toBe('Important note');
  });

  it('should flatten nested list item text', () => {
    const tokens = marked.lexer('- outer\n  - inner **bold**');
    const list = tokens.find((t) => t.type === 'list') as import('marked').Tokens.List;
    const nested = list.items[0]!.tokens.find((t) => t.type === 'list') as import('marked').Tokens.List;
    const nestedItem = nested.items[0]!.tokens;
    expect(plainTextFromInlineTokens(nestedItem)).toBe('inner bold');
  });
});
