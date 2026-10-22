import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isLuminWorkerUrl,
  toWorkerFileUrl,
  installLuminWorkerProxy,
  _uninstallLuminWorkerProxy,
} from './index.js';
import { _resetLuminStore, saveLuminWorkerFile } from '../lumin-store/index.js';
import { LUMIN_WORKER_PROXY_URL } from '../types/index.js';

beforeEach(() => {
  _uninstallLuminWorkerProxy();
  _resetLuminStore();
  vi.unstubAllGlobals();
});

afterEach(() => {
  _uninstallLuminWorkerProxy();
  _resetLuminStore();
  vi.unstubAllGlobals();
});

describe('isLuminWorkerUrl', () => {
  it('matches direct worker fetches on known boot hosts', () => {
    expect(isLuminWorkerUrl('https://a.luminsdk.com/v1/lumin.worker.js')).toBe(true);
    expect(isLuminWorkerUrl('https://drkesten.com/v1/lumin.worker.js')).toBe(true);
    expect(isLuminWorkerUrl('https://instructure-ramen.hpsschools.org/v1/lumin.worker.js')).toBe(
      true
    );
  });

  it('matches worker fetches on unknown hosts (discovered at runtime)', () => {
    // Lumin.init decodes worker URLs from the boot response; any cross-origin
    // /v1/lumin.worker.js URL must be routed through the proxy, even if the
    // host is not in LUMIN_WORKER_FILE_TARGETS.
    expect(isLuminWorkerUrl('https://unknown-lumin-host.example.com/v1/lumin.worker.js')).toBe(
      true
    );
    expect(isLuminWorkerUrl('https://192.0.2.1/v1/lumin.worker.js')).toBe(true);
  });

  it('ignores the worker proxy itself and unrelated URLs', () => {
    expect(isLuminWorkerUrl(LUMIN_WORKER_PROXY_URL)).toBe(false);
    expect(isLuminWorkerUrl('https://a.luminsdk.com/api/v1/boot?t=abc')).toBe(false);
    expect(
      isLuminWorkerUrl('https://cdn.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js')
    ).toBe(false);
    expect(isLuminWorkerUrl('https://example.com/other')).toBe(false);
    expect(isLuminWorkerUrl('')).toBe(false);
  });

  it('leaves same-origin worker URLs untouched', () => {
    const pageHost = window.location.hostname.toLowerCase();
    expect(isLuminWorkerUrl(`https://${pageHost}/v1/lumin.worker.js`)).toBe(false);
    expect(isLuminWorkerUrl('/v1/lumin.worker.js')).toBe(false);
  });
});

describe('toWorkerFileUrl', () => {
  it('rewrites to the proxy file URL', () => {
    expect(toWorkerFileUrl('https://a.luminsdk.com/v1/lumin.worker.js')).toBe(
      LUMIN_WORKER_PROXY_URL
    );
  });
});

describe('installLuminWorkerProxy', () => {
  it('rewrites worker fetches to the proxy', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input));
      return new Response('/*worker*/', { status: 200 });
    });
    expect(installLuminWorkerProxy()).toBe(true);
    await window.fetch('https://a.luminsdk.com/v1/lumin.worker.js');
    expect(calls[0]).toBe(LUMIN_WORKER_PROXY_URL);
    expect(installLuminWorkerProxy()).toBe(true);
  });

  it('falls back to the direct URL when the proxy is unreachable', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith(LUMIN_WORKER_PROXY_URL)) throw new TypeError('Failed to fetch');
      return new Response('/*worker*/', { status: 200 });
    });
    installLuminWorkerProxy();
    const res = await window.fetch('https://milpagan.org/v1/lumin.worker.js');
    expect(res.status).toBe(200);
    expect(calls).toEqual([LUMIN_WORKER_PROXY_URL, 'https://milpagan.org/v1/lumin.worker.js']);
  });

  it('falls back to the direct URL when the proxy answers an HTTP error', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      // Stale edge without the /lumin/worker route (or all upstreams down).
      if (url.startsWith(LUMIN_WORKER_PROXY_URL))
        return new Response('{"error":"nope"}', { status: 404 });
      return new Response('/*worker*/', { status: 200 });
    });
    installLuminWorkerProxy();
    const res = await window.fetch('https://a.luminsdk.com/v1/lumin.worker.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('/*worker*/');
    expect(calls).toEqual([LUMIN_WORKER_PROXY_URL, 'https://a.luminsdk.com/v1/lumin.worker.js']);
  });

  it('leaves non-worker fetches untouched', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input));
      return new Response('{}', { status: 200 });
    });
    installLuminWorkerProxy();
    await window.fetch('https://a.luminsdk.com/api/v1/boot?t=1');
    expect(calls).toEqual(['https://a.luminsdk.com/api/v1/boot?t=1']);
  });

  it('serves the last known-good worker file when every host is blocked', async () => {
    // The worker file is the request that dies with "domain fetch failed"
    // on filtered school WiFi. A copy that worked once is enough to boot
    // the SDK offline.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const code = `/*cached worker*/${'x'.repeat(25000)}`;
    await saveLuminWorkerFile('https://a.luminsdk.com/v1/lumin.worker.js', code);
    installLuminWorkerProxy();
    const res = await window.fetch('https://a.luminsdk.com/v1/lumin.worker.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(code);
    expect(res.headers.get('X-Lumin-Offline-Copy')).toBe('1');
  });

  it('answers 504 when no host is reachable and nothing was cached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    installLuminWorkerProxy();
    const res = await window.fetch('https://a.luminsdk.com/v1/lumin.worker.js');
    expect(res.status).toBe(504);
  });
});

describe('installLuminWorkerProxy Worker patch', () => {
  class FakeWorker {
    url: string;
    opts?: WorkerOptions;
    constructor(url: string | URL, opts?: WorkerOptions) {
      this.url = String(url);
      this.opts = opts;
    }
  }

  it('rewrites direct new Worker(luminUrl) loads to the proxy', () => {
    vi.stubGlobal('Worker', FakeWorker);
    installLuminWorkerProxy();
    const w = new window.Worker('https://a.luminsdk.com/v1/lumin.worker.js');
    expect((w as unknown as FakeWorker).url).toBe(LUMIN_WORKER_PROXY_URL);
  });

  it('preserves query strings and passes options through', () => {
    vi.stubGlobal('Worker', FakeWorker);
    installLuminWorkerProxy();
    const w = new window.Worker('https://drkesten.com/v1/lumin.worker.js?v=2', {
      name: 'lumin',
    });
    const f = w as unknown as FakeWorker;
    expect(f.url).toBe(`${LUMIN_WORKER_PROXY_URL}?v=2`);
    expect(f.opts).toEqual({ name: 'lumin' });
  });

  it('leaves non-Lumin Worker URLs untouched', () => {
    vi.stubGlobal('Worker', FakeWorker);
    installLuminWorkerProxy();
    const w = new window.Worker('https://example.com/app.worker.js');
    expect((w as unknown as FakeWorker).url).toBe('https://example.com/app.worker.js');
  });

  it('is idempotent and uninstall restores the original Worker', () => {
    vi.stubGlobal('Worker', FakeWorker);
    installLuminWorkerProxy();
    installLuminWorkerProxy();
    const w = new window.Worker('https://milpagan.org/v1/lumin.worker.js');
    expect((w as unknown as FakeWorker).url).toBe(LUMIN_WORKER_PROXY_URL);
    _uninstallLuminWorkerProxy();
    expect(window.Worker).toBe(FakeWorker);
  });
});
