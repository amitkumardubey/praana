import { describe, it, expect } from 'vitest';
import { marked, type Tokens } from 'marked';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import {
  extractCellText,
  computeColWidths,
  plainTextFromInlineTokens,
  renderInlineToAnsi,
} from '../src/ui/tui/markdown-render.js';
import { PALETTE } from '../src/ui/tui/palette.js';

const hexToRgb = (hex: string) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(';');
};

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

describe('renderInlineToAnsi', () => {
  it('should return plain text for simple strings', () => {
    const tokens = marked.lexer('Hello world');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as Tokens.Paragraph;
    const ansi = renderInlineToAnsi(paragraph.tokens);
    expect(stripAnsi(ansi)).toBe('Hello world');
  });

  it('should wrap bold text with ANSI bold codes', () => {
    const tokens = marked.lexer('**bold** text');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as Tokens.Paragraph;
    const ansi = renderInlineToAnsi(paragraph.tokens);
    expect(stripAnsi(ansi)).toBe('bold text');
    // Should contain ANSI bold escape sequences
    expect(ansi).toMatch(/\x1b\[1m/);
  });

  it('should wrap italic text with ANSI italic codes', () => {
    const tokens = marked.lexer('*italic* text');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as Tokens.Paragraph;
    const ansi = renderInlineToAnsi(paragraph.tokens);
    expect(stripAnsi(ansi)).toBe('italic text');
    expect(ansi).toMatch(/\x1b\[3m/);
  });

  it('should wrap strikethrough text with ANSI strikethrough codes', () => {
    const tokens = marked.lexer('~~removed~~ text');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as Tokens.Paragraph;
    const ansi = renderInlineToAnsi(paragraph.tokens);
    expect(stripAnsi(ansi)).toBe('removed text');
    expect(ansi).toMatch(/\x1b\[9m/);
  });

  it('should handle code spans with background color', () => {
    const tokens = marked.lexer('use `foo` bar');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as Tokens.Paragraph;
    const ansi = renderInlineToAnsi(paragraph.tokens);
    expect(stripAnsi(ansi)).toBe('use  foo  bar');
    // Background should be the inline-code-span surface colour
    expect(ansi).toContain(`\x1b[48;2;${hexToRgb(PALETTE.codeSpanBg)}m`);
    // Foreground (tool colour) must differ from the background
    expect(ansi).toContain(`\x1b[38;2;${hexToRgb(PALETTE.tool)}m`);
  });

  it('should handle links with underline', () => {
    const tokens = marked.lexer('[click](https://example.com) here');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as Tokens.Paragraph;
    const ansi = renderInlineToAnsi(paragraph.tokens);
    expect(stripAnsi(ansi)).toBe('click (https://example.com) here');
    // Should contain underline escape sequences
    expect(ansi).toMatch(/\x1b\[4m/);
  });

  it('should handle line breaks', () => {
    const tokens = marked.lexer('line1  \nline2');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as Tokens.Paragraph;
    const ansi = renderInlineToAnsi(paragraph.tokens);
    expect(ansi).toContain('\n');
  });

  it('should produce a single contiguous string (no React children)', () => {
    const tokens = marked.lexer('Hello **bold** and *italic* with `code`');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as Tokens.Paragraph;
    const ansi = renderInlineToAnsi(paragraph.tokens);
    // The result should be a plain string, not a React element
    expect(typeof ansi).toBe('string');
    // Code spans have leading/trailing padding spaces (matching original React rendering)
    expect(stripAnsi(ansi)).toBe('Hello bold and italic with  code ');
  });

  it('should preserve nested bold inside italic', () => {
    const tokens = marked.lexer('*italic **bold** end*');
    const paragraph = tokens.find((t) => t.type === 'paragraph') as Tokens.Paragraph;
    const ansi = renderInlineToAnsi(paragraph.tokens);
    expect(stripAnsi(ansi)).toBe('italic bold end');
    // Should contain both bold and italic escape sequences
    expect(ansi).toMatch(/\x1b\[1m/);
    expect(ansi).toMatch(/\x1b\[3m/);
  });

  it('should handle empty tokens', () => {
    expect(renderInlineToAnsi([])).toBe('');
  });

  it('should handle plain string tokens', () => {
    expect(renderInlineToAnsi(['hello ', 'world'])).toBe('hello world');
  });

  it('should flatten list-item text tokens with strong + codespan', () => {
    // This is the token structure from: - **Run tests** — Check with `npm test`
    const tokens = marked.lexer('- **Run tests** — Check that everything passes with `npm test`');
    const list = tokens.find((t) => t.type === 'list') as Tokens.List;
    const textToken = list.items[0]!.tokens[0]! as Tokens.Text;
    // text token has nested inline tokens
    expect(textToken.tokens).toBeDefined();
    expect(textToken.tokens!.length).toBeGreaterThan(0);
    const ansi = renderInlineToAnsi(textToken.tokens!);
    expect(stripAnsi(ansi)).toBe('Run tests — Check that everything passes with  npm test ');
    // Should be a single string — no React sibling Text nodes
    expect(typeof ansi).toBe('string');
  });

  it('should not leave orphan leading spaces after wrap (trim: true)', () => {
    // Simulate wrapping "Just let me know what you're looking to do!" at a narrow width
    const ansi = renderInlineToAnsi([{ type: 'text', text: "Just let me know what you're looking to do!" } as Tokens.Text]);
    const wrapped = wrapAnsi(ansi, 30, { trim: true, hard: false });
    const lines = wrapped.split('\n');
    // No continuation line should start with a space
    for (const line of lines) {
      const plain = stripAnsi(line);
      // First line can start with space (indentation), continuation lines should not
      if (line !== lines[0]) {
        expect(plain).not.toMatch(/^\s+\S/);
      }
    }
  });
});
