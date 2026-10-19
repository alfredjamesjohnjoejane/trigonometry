import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isLuminBootUrl,
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
});
