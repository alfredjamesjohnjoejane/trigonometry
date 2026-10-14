import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isLuminWorkerUrl,
  toWorkerFileUrl,
  installLuminWorkerProxy,
  _uninstallLuminWorkerProxy,
} from './index.js';
import { LUMIN_WORKER_PROXY_URL } from '../types/index.js';

beforeEach(() => {
  _uninstallLuminWorkerProxy();
  vi.unstubAllGlobals();
});

afterEach(() => {
  _uninstallLuminWorkerProxy();
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

  it('ignores the worker proxy itself and unrelated URLs', () => {
    expect(isLuminWorkerUrl(LUMIN_WORKER_PROXY_URL)).toBe(false);
    expect(isLuminWorkerUrl('https://a.luminsdk.com/api/v1/boot?t=abc')).toBe(false);
    expect(
      isLuminWorkerUrl('https://cdn.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js')
    ).toBe(false);
    expect(isLuminWorkerUrl('https://example.com/other')).toBe(false);
    expect(isLuminWorkerUrl('')).toBe(false);
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
});
