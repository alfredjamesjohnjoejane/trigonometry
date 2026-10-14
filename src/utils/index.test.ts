import { describe, it, expect } from 'vitest';
import {
  escapeAttr,
  isSafeHttpUrl,
  stripHtmlMetachars,
  buildGameIframeHtml,
  LUMIN_SDK_URLS,
  LUMIN_VENDOR_PATH,
  luminScriptUrls,
  formatMirrorAttempts,
  getTestPageHtml,
} from './index.js';
import { LUMIN_BACKEND_TARGETS } from '../types/index.js';

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

describe('stripHtmlMetachars', () => {
  it('is a no-op for legitimate URLs', () => {
    expect(stripHtmlMetachars('https://classroom.google.com/')).toBe(
      'https://classroom.google.com/'
    );
    // Encoded query sequences (%3A) and data-image favicons must survive.
    expect(
      stripHtmlMetachars(
        'https://www.google.com/s2/favicons?sz=64&domain_url=https%3A%2F%2Fexample.com%2F'
      )
    ).toBe('https://www.google.com/s2/favicons?sz=64&domain_url=https%3A%2F%2Fexample.com%2F');
    expect(stripHtmlMetachars('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
    );
    expect(stripHtmlMetachars('icon.png')).toBe('icon.png');
  });

  it('strips HTML metacharacters and whitespace', () => {
    expect(stripHtmlMetachars('\'"><script>alert(1)</script>')).toBe('scriptalert(1)/script');
    expect(stripHtmlMetachars('https://example.com/a b')).toBe('https://example.com/ab');
    expect(stripHtmlMetachars('`x`')).toBe('x');
  });

  it('does not allowlist by itself (javascript: survives stripping)', () => {
    // The scheme allowlist (isSafeHttpUrl/isSafeFaviconUrl) does the real
    // blocking; stripping only guarantees no markup reinterpretation.
    expect(stripHtmlMetachars('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(isSafeHttpUrl(stripHtmlMetachars('javascript:alert(1)'))).toBe(false);
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

describe('lumin mirrors', () => {
  it('lists only verified gh-path mirrors', () => {
    expect(LUMIN_SDK_URLS.length).toBe(4);
    for (const u of LUMIN_SDK_URLS) {
      expect(u).toContain('/gh/luminsdk/script');
      expect(u).not.toContain('/npm/luminsdk');
    }
  });

  it('formats mirror attempts for logs and reports', () => {
    const text = formatMirrorAttempts([
      {
        url: 'https://a/x.js',
        tier: 'tag',
        ok: false,
        ms: 12,
        errorName: 'TypeError',
        errorMessage: 'Failed to fetch',
      },
      {
        url: 'https://b/x.js',
        tier: 'fetch-blob',
        ok: true,
        ms: 50,
        errorName: null,
        errorMessage: null,
      },
    ]);
    expect(text).toContain('FAIL');
    expect(text).toContain('OK');
    expect(text).toContain('[tag]');
    expect(text).toContain('[fetch-blob]');
  });

  it('puts the same-origin vendor copy first', () => {
    expect(LUMIN_VENDOR_PATH).toBe('vendor/lumin.min.js');
    const urls = luminScriptUrls();
    expect(urls.length).toBe(LUMIN_SDK_URLS.length + 2);
    expect(urls[0]).toContain('vendor/lumin.min.js');
    expect(urls[1]).toContain('/lumin/script');
  });

  it('lists the decoded backend boot hosts', () => {
    expect(LUMIN_BACKEND_TARGETS.length).toBe(6);
    expect(LUMIN_BACKEND_TARGETS[0]?.url).toContain('/lumin/boot');
    expect(LUMIN_BACKEND_TARGETS[1]?.url).toContain('a.luminsdk.com');
  });

  it('test page tries mirrors in order', () => {
    const html = getTestPageHtml();
    expect(html).toContain('fastly.jsdelivr.net/gh/luminsdk/script');
    expect(html).toContain('/lumin/script');
    expect(html).toContain('Lumin.init');
  });
});
