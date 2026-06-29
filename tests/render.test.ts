import { describe, it, expect, spyOn } from "bun:test";
import { renderMarkdown, writeMarkdown } from '../src/render.js';
describe('renderMarkdown', () => {
  it('should return empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('should render plain text', () => {
    const result = renderMarkdown('Hello world');
    expect(result).toContain('Hello world');
  });

  it('should render heading', () => {
    const result = renderMarkdown('# Heading 1');
    // In non-TTY, chalk strips colors — we get plain text
    expect(result).toContain('Heading 1');
  });

  it('should render bold text', () => {
    const result = renderMarkdown('This is **bold** text');
    expect(result).toContain('bold');
  });

  it('should render italic text', () => {
    const result = renderMarkdown('This is *italic* text');
    expect(result).toContain('italic');
  });

  it('should render inline code', () => {
    const result = renderMarkdown('Use `code` inline');
    expect(result).toContain('code');
  });

  it('should render code blocks', () => {
    const result = renderMarkdown('```\nconst x = 1;\n```');
    expect(result).toContain('const x = 1');
  });

  it('should render unordered lists', () => {
    const result = renderMarkdown('- Item 1\n- Item 2\n- Item 3');
    expect(result).toContain('Item 1');
    expect(result).toContain('Item 2');
    expect(result).toContain('Item 3');
  });

  it('should render ordered lists', () => {
    const result = renderMarkdown('1. First\n2. Second');
    expect(result).toContain('First');
    expect(result).toContain('Second');
  });

  it('should render links', () => {
    const result = renderMarkdown('[GitHub](https://github.com)');
    expect(result).toContain('GitHub');
  });

  it('should render blockquotes', () => {
    const result = renderMarkdown('> A wise quote');
    expect(result).toContain('wise quote');
  });

  it('should render tables', () => {
    const result = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('1');
    expect(result).toContain('2');
  });

  it('should render horizontal rules', () => {
    const result = renderMarkdown('---');
    // Should produce something (a line/rule)
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle multiple headings', () => {
    const result = renderMarkdown('# H1\n## H2\n### H3');
    expect(result).toContain('H1');
    expect(result).toContain('H2');
    expect(result).toContain('H3');
  });

  it('should handle mixed formatting', () => {
    const result = renderMarkdown('# Title\n\nThis is a paragraph with **bold** and *italic*.\n\n- List item 1\n- List item 2');
    expect(result).toContain('Title');
    expect(result).toContain('bold');
    expect(result).toContain('italic');
    expect(result).toContain('List item');
  });

  it('should handle nested formatting', () => {
    const result = renderMarkdown('**bold and *italic* inside**');
    expect(result).toContain('bold');
    expect(result).toContain('italic');
  });

  it('should handle special characters', () => {
    const result = renderMarkdown('Special: & < > " \'');
    expect(result).toBeTruthy();
  });

  it('should not crash on malformed markdown', () => {
    const result = renderMarkdown('**unclosed bold');
    expect(result).toContain('unclosed bold');
  });

  it('should handle very long lines', () => {
    const longText = 'x'.repeat(500);
    const result = renderMarkdown(longText);
    expect(result.length).toBeGreaterThan(400);
  });

  it('should handle multi-line paragraphs', () => {
    const result = renderMarkdown('Line 1\nLine 2\n\nLine 3');
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
    expect(result).toContain('Line 3');
  });
});

describe('writeMarkdown', () => {
  it('should write rendered markdown to stream', () => {
    const writes: string[] = [];
    const mockStream = {
      write: (s: string) => { writes.push(s); },
    } as any;

    writeMarkdown('Hello **world**', mockStream);
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('Hello');
    expect(writes[0]).toContain('world');
  });

  it('should add trailing newline if missing', () => {
    const writes: string[] = [];
    const mockStream = {
      write: (s: string) => { writes.push(s); },
    } as any;

    // renderMarkdown('a') may or may not end with \n in non-TTY — test that we add one if needed
    writeMarkdown('a', mockStream);
    const lastWrite = writes[writes.length - 1];
    // The function either adds the newline to the write or it's already there
    expect(lastWrite.endsWith('\n')).toBe(true);
  });

  it('should do nothing for empty text', () => {
    const writes: string[] = [];
    const mockStream = {
      write: (s: string) => { writes.push(s); },
    } as any;

    writeMarkdown('', mockStream);
    expect(writes.length).toBe(0);
  });

  it('should default to process.stdout', () => {
    const spy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    writeMarkdown('test');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
