import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isLuminBootUrl,
  isLuminProbeUrl,
  toWorkerBootUrl,
  installLuminBootProxy,
  _uninstallLuminBootProxy,
} from './index.js';
import { LUMIN_WORKER_BOOT_URL } from '../types/index.js';

beforeEach(() => {
  _uninstallLuminBootProxy();
  vi.unstubAllGlobals();
});

afterEach(() => {
  _uninstallLuminBootProxy();
  vi.unstubAllGlobals();
});

describe('isLuminBootUrl', () => {
  it('matches direct boot hosts on any path', () => {
    expect(isLuminBootUrl('https://a.luminsdk.com/api/v1/boot?t=abc')).toBe(true);
    expect(isLuminBootUrl('https://drkesten.com/api/v1/boot')).toBe(true);
    expect(isLuminBootUrl('https://a.luminsdk.com/some-config?t=x')).toBe(true);
  });

  it('ignores the worker proxy itself and unrelated URLs', () => {
    expect(isLuminBootUrl(`${LUMIN_WORKER_BOOT_URL}?t=abc`)).toBe(false);
    expect(isLuminBootUrl('https://cdn.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js')).toBe(
      false
    );
    expect(isLuminBootUrl('https://example.com/other')).toBe(false);
    expect(isLuminBootUrl('')).toBe(false);
  });

  it('leaves the handshake documents out of the boot route', () => {
    // The boot route appends the path to /api/v1/boot and would answer 404,
    // which kills one of the SDK's two reachability channels.
    expect(isLuminBootUrl('https://a.luminsdk.com/g/_iframe_probe')).toBe(false);
    expect(isLuminBootUrl('https://a.luminsdk.com/g/abc/__lumin_canary/?__lp=x')).toBe(false);
  });
});

describe('isLuminProbeUrl', () => {
  it('matches the SDK handshake documents', () => {
    expect(isLuminProbeUrl('https://a.luminsdk.com/g/_iframe_probe')).toBe(true);
    expect(isLuminProbeUrl('https://drkesten.com/g/abc/__lumin_canary/?__lp=1')).toBe(true);
  });

  it('ignores boot URLs and other hosts', () => {
    expect(isLuminProbeUrl('https://a.luminsdk.com/api/v1/boot?t=1')).toBe(false);
    expect(isLuminProbeUrl('https://example.com/g/_iframe_probe')).toBe(false);
    expect(isLuminProbeUrl('')).toBe(false);
  });
});

describe('toWorkerBootUrl', () => {
  it('preserves the boot path and token query', () => {
    expect(toWorkerBootUrl('https://a.luminsdk.com/api/v1/boot?t=xyz')).toBe(
      `${LUMIN_WORKER_BOOT_URL}/api/v1/boot?t=xyz`
    );
  });

  it('preserves other paths on boot hosts', () => {
    expect(toWorkerBootUrl('https://drkesten.com/some-config?t=1')).toBe(
      `${LUMIN_WORKER_BOOT_URL}/some-config?t=1`
    );
  });
});

describe('installLuminBootProxy', () => {
  it('rewrites boot fetches to the proxy', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input));
      return new Response('{}', { status: 200 });
    });
    expect(installLuminBootProxy()).toBe(true);
    await window.fetch('https://a.luminsdk.com/api/v1/boot?t=1');
    expect(calls[0]).toBe(`${LUMIN_WORKER_BOOT_URL}/api/v1/boot?t=1`);
    expect(installLuminBootProxy()).toBe(true);
  });

  it('falls back to the direct URL when the proxy is unreachable', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith(LUMIN_WORKER_BOOT_URL)) throw new TypeError('Failed to fetch');
      return new Response('{}', { status: 200 });
    });
    installLuminBootProxy();
    const res = await window.fetch('https://a.luminsdk.com/api/v1/boot?t=2');
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      `${LUMIN_WORKER_BOOT_URL}/api/v1/boot?t=2`,
      'https://a.luminsdk.com/api/v1/boot?t=2',
    ]);
  });

  it('proxies non-boot paths on boot hosts too', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input));
      return new Response('{}', { status: 200 });
    });
    installLuminBootProxy();
    await window.fetch('https://a.luminsdk.com/some-config?t=x');
    expect(calls[0]).toBe(`${LUMIN_WORKER_BOOT_URL}/some-config?t=x`);
  });

  it('leaves non-boot fetches untouched', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input));
      return new Response('{}', { status: 200 });
    });
    installLuminBootProxy();
    await window.fetch('https://example.com/data.json');
    expect(calls).toEqual(['https://example.com/data.json']);
  });

  it('keeps handshake documents off the boot route', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input));
      return new Response('ok', { status: 200 });
    });
    installLuminBootProxy();
    await window.fetch('https://a.luminsdk.com/g/_iframe_probe');
    // Never the boot route: it would answer 404 and kill the channel.
    expect(calls[0]).toBe('https://a.luminsdk.com/g/_iframe_probe');
  });

  it('answers the handshake locally when the network fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    installLuminBootProxy();
    const res = await window.fetch('https://a.luminsdk.com/g/_iframe_probe');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Lumin-Handshake')).toBe('local');
    expect(await res.text()).toContain('lumin-ok-frame');
  });

  it('echoes the canary nonce in the local answer', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    installLuminBootProxy();
    const res = await window.fetch('https://a.luminsdk.com/g/abc/__lumin_canary/?__lp=nonce42');
    const text = await res.text();
    expect(text).toContain('frame-ok');
    expect(text).toContain('nonce42');
  });
});

describe('installLuminHandshakeShim', () => {
  it('answers the SDK handshake with the Lumin origin', () => {
    installLuminBootProxy();
    const seen: MessageEvent[] = [];
    const listener = (e: Event): void => {
      seen.push(e as MessageEvent);
    };
    window.addEventListener('message', listener);
    const frame = document.createElement('iframe');
    frame.src = 'https://a.luminsdk.com/g/_iframe_probe';
    document.body.appendChild(frame);
    const probe = seen.find(m => m.data === 'lumin-ok-frame');
    expect(probe).toBeTruthy();
    // The SDK checks the origin: a blob: frame would carry the page origin.
    expect(probe?.origin).toBe('https://a.luminsdk.com');

    seen.length = 0;
    const canary = document.createElement('iframe');
    canary.src = 'https://drkesten.com/g/abc/__lumin_canary/?__lp=nonce42';
    document.body.appendChild(canary);
    const canaryMsg = seen.find(
      m => typeof m.data === 'object' && (m.data as { game?: string })?.game === '__lumin_canary'
    );
    expect(canaryMsg).toBeTruthy();
    expect(canaryMsg?.origin).toBe('https://drkesten.com');
    expect((canaryMsg?.data as { nonce?: string })?.nonce).toBe('nonce42');
    window.removeEventListener('message', listener);
  });

  it('leaves other iframes alone', () => {
    installLuminBootProxy();
    const frame = document.createElement('iframe');
    frame.src = 'https://example.com/embed';
    expect(frame.src).toBe('https://example.com/embed');
  });
});

describe('installLuminUrlRewrite', () => {
  it('loads Lumin game frames through the proxy', () => {
    installLuminBootProxy();
    const frame = document.createElement('iframe');
    frame.src = 'https://a.luminsdk.com/g/abc/selenite/game/?__lp=n1';
    document.body.appendChild(frame);
    expect(frame.src).toBe(
      'https://url-marketplace.jesherhaed.workers.dev/lumin/x/a.luminsdk.com/g/abc/selenite/game/?__lp=n1'
    );
  });

  it('loads Lumin thumbnails through the proxy', () => {
    installLuminBootProxy();
    const img = document.createElement('img');
    img.src = 'https://a.luminsdk.com/api/v1/icon/session/selenite/game';
    expect(img.src).toBe(
      'https://url-marketplace.jesherhaed.workers.dev/lumin/x/a.luminsdk.com/api/v1/icon/session/selenite/game'
    );
  });

  it('leaves non-Lumin images alone', () => {
    installLuminBootProxy();
    const img = document.createElement('img');
    img.src = 'https://example.com/icon.png';
    expect(img.src).toBe('https://example.com/icon.png');
  });

  it('re-stamps messages from a proxied frame with the Lumin origin', () => {
    installLuminBootProxy();
    const frame = document.createElement('iframe');
    frame.src = 'https://a.luminsdk.com/g/abc/selenite/game/?__lp=n2';
    document.body.appendChild(frame);
    const seen: MessageEvent[] = [];
    const listener = (e: Event): void => {
      seen.push(e as MessageEvent);
    };
    window.addEventListener('message', listener);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { __lumin: 'frame-ok', game: 'selenite/game', nonce: 'n2' },
        origin: 'https://url-marketplace.jesherhaed.workers.dev',
        source: frame.contentWindow,
      })
    );
    window.removeEventListener('message', listener);
    // Exactly one delivery, with the origin the SDK validates against.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe('https://a.luminsdk.com');
    expect((seen[0]?.data as { game?: string }).game).toBe('selenite/game');
  });

  it('leaves messages from other origins untouched', () => {
    installLuminBootProxy();
    const frame = document.createElement('iframe');
    frame.src = 'https://a.luminsdk.com/g/abc/selenite/game/';
    document.body.appendChild(frame);
    const seen: MessageEvent[] = [];
    const listener = (e: Event): void => {
      seen.push(e as MessageEvent);
    };
    window.addEventListener('message', listener);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: 'hello',
        origin: 'https://example.com',
        source: frame.contentWindow,
      })
    );
    window.removeEventListener('message', listener);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe('https://example.com');
  });
});
