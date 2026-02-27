import { describe, expect, it } from 'vitest';
import { markdownToSignal, formatStylesForCli } from './signal-format.js';

describe('markdownToSignal', () => {
  // ---- URL protection ----

  it('preserves underscores in bare URLs', () => {
    const url = 'http://localhost:3001/oauth/authorize?response_type=code&client_id=123&code_challenge_method=S256';
    const result = markdownToSignal(url);
    expect(result.text).toBe(url);
    expect(result.styles).toHaveLength(0);
  });

  it('preserves underscores in HTTPS URLs', () => {
    const url = 'https://www.strava.com/oauth/authorize?response_type=code&client_id=202479&redirect_uri=http%3A%2F%2Flocalhost';
    const result = markdownToSignal(url);
    expect(result.text).toBe(url);
    expect(result.styles).toHaveLength(0);
  });

  it('preserves underscores in URLs embedded in text', () => {
    const input = 'Visit http://example.com/path?my_param=value_here to continue.';
    const result = markdownToSignal(input);
    expect(result.text).toBe(input);
    expect(result.styles).toHaveLength(0);
  });

  it('applies italic to non-URL text but preserves URL underscores', () => {
    const input = 'This is _italic_ and http://example.com/my_path?a_b=c_d is a URL.';
    const result = markdownToSignal(input);
    expect(result.text).toBe('This is italic and http://example.com/my_path?a_b=c_d is a URL.');
    expect(result.styles).toHaveLength(1);
    expect(result.styles[0].style).toBe('ITALIC');
    expect(result.text.slice(result.styles[0].start, result.styles[0].start + result.styles[0].length)).toBe('italic');
  });

  it('preserves markdown link URLs with underscores', () => {
    const input = 'Click [here](http://example.com/my_path?response_type=code) to auth.';
    const result = markdownToSignal(input);
    // The markdown link construct should be preserved (underscores in URL not stripped)
    expect(result.text).not.toContain('responsetype');
    // The URL should still have underscores
    expect(result.text).toContain('response_type');
  });

  // ---- Existing formatting still works ----

  it('converts **bold** text', () => {
    const result = markdownToSignal('This is **bold** text.');
    expect(result.text).toBe('This is bold text.');
    expect(result.styles).toHaveLength(1);
    expect(result.styles[0]).toEqual({ start: 8, length: 4, style: 'BOLD' });
  });

  it('converts *bold* text (single asterisk)', () => {
    const result = markdownToSignal('This is *bold* text.');
    expect(result.text).toBe('This is bold text.');
    expect(result.styles).toHaveLength(1);
    expect(result.styles[0]).toEqual({ start: 8, length: 4, style: 'BOLD' });
  });

  it('converts _italic_ text', () => {
    const result = markdownToSignal('This is _italic_ text.');
    expect(result.text).toBe('This is italic text.');
    expect(result.styles).toHaveLength(1);
    expect(result.styles[0]).toEqual({ start: 8, length: 6, style: 'ITALIC' });
  });

  it('converts __italic__ text (double underscore)', () => {
    const result = markdownToSignal('This is __italic__ text.');
    expect(result.text).toBe('This is italic text.');
    expect(result.styles).toHaveLength(1);
    expect(result.styles[0]).toEqual({ start: 8, length: 6, style: 'ITALIC' });
  });

  it('converts `code` text', () => {
    const result = markdownToSignal('Use `console.log` here.');
    expect(result.text).toBe('Use console.log here.');
    expect(result.styles).toHaveLength(1);
    expect(result.styles[0]).toEqual({ start: 4, length: 11, style: 'MONOSPACE' });
  });

  it('converts ~~strikethrough~~ text', () => {
    const result = markdownToSignal('This is ~~deleted~~ text.');
    expect(result.text).toBe('This is deleted text.');
    expect(result.styles).toHaveLength(1);
    expect(result.styles[0]).toEqual({ start: 8, length: 7, style: 'STRIKETHROUGH' });
  });

  it('handles mixed formatting and URLs', () => {
    const input = '**Check** your _Strava_ at http://localhost:3001/oauth/authorize?response_type=code';
    const result = markdownToSignal(input);
    expect(result.text).toBe('Check your Strava at http://localhost:3001/oauth/authorize?response_type=code');
    expect(result.styles).toHaveLength(2);
    expect(result.styles[0].style).toBe('BOLD');
    expect(result.styles[1].style).toBe('ITALIC');
    // URL must be preserved
    expect(result.text).toContain('response_type=code');
  });

  it('returns empty styles for plain text', () => {
    const result = markdownToSignal('No formatting here.');
    expect(result.text).toBe('No formatting here.');
    expect(result.styles).toHaveLength(0);
  });
});

describe('formatStylesForCli', () => {
  it('formats style ranges for signal-cli', () => {
    const styles = [
      { start: 0, length: 4, style: 'BOLD' as const },
      { start: 10, length: 6, style: 'ITALIC' as const },
    ];
    expect(formatStylesForCli(styles)).toEqual(['0:4:BOLD', '10:6:ITALIC']);
  });
});
