import { describe, it, expect } from 'vitest';
import { escapeAttr, isSafeHttpUrl, buildGameIframeHtml } from './index.js';

describe('escapeAttr', () => {
  it('escapes HTML attribute breakouts', () => {
    expect(escapeAttr('"><script>alert(1)</script>')).toBe(
      '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'
    );
    expect(escapeAttr("it's & quoted")).toBe('it&#39;s &amp; quoted');
  });
});

describe('isSafeHttpUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(isSafeHttpUrl('https://example.com/game.html')).toBe(true);
    expect(isSafeHttpUrl('http://cdn.jsdelivr.net/x')).toBe(true);
  });

  it('rejects script-capable schemes', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isSafeHttpUrl('blob:https://example.com/x')).toBe(false);
  });

  it('rejects credentialed and non-routable hosts', () => {
    expect(isSafeHttpUrl('https://user:pass@example.com/')).toBe(false);
    expect(isSafeHttpUrl('http://localhost/game')).toBe(false);
    expect(isSafeHttpUrl('http://127.0.0.1/x')).toBe(false);
    expect(isSafeHttpUrl('http://192.168.1.1/x')).toBe(false);
    expect(isSafeHttpUrl('http://169.254.169.254/')).toBe(false);
  });

  it('rejects non-strings and bare input', () => {
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

describe('buildGameIframeHtml', () => {
  it('escapes the embedded URL', () => {
    const html = buildGameIframeHtml('https://example.com/g.html');
    expect(html).toContain('src="https://example.com/g.html"');
  });

  it('falls back to / for unsafe URLs', () => {
    const html = buildGameIframeHtml('javascript:alert(1)');
    expect(html).toContain('src="/"');
    expect(html).not.toContain('javascript:');
  });
});
