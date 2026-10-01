import { describe, it, expect, beforeEach, vi } from 'vitest';

function makeMockIndexedDB() {
  const store = new Map<string, { url: string; html: string; timestamp: number }>();

  const mockObjectStore = {
    put: vi.fn((entry: { url: string; html: string; timestamp: number }) => {
      store.set(entry.url, entry);
      const req = {
        result: undefined,
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null,
      };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    }),
    get: vi.fn((url: string) => {
      const entry = store.get(url);
      const req = {
        result: entry,
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null,
      };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    }),
    clear: vi.fn(() => {
      store.clear();
      const req = {
        result: undefined,
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null,
      };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    }),
    count: vi.fn(() => {
      const req = {
        result: store.size,
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null,
      };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    }),
    index: vi.fn(() => ({
      openCursor: vi.fn(),
      timestamp: {},
    })),
    openCursor: vi.fn(),
  };

  const mockDB = {
    transaction: vi.fn(() => ({
      objectStore: vi.fn(() => mockObjectStore),
    })),
    objectStoreNames: { contains: vi.fn(() => true) },
    createObjectStore: vi.fn(),
    close: vi.fn(),
  };

  return { mockDB, store };
}

describe('Cache module', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('initCache creates database successfully', async () => {
    const { mockDB } = makeMockIndexedDB();
    const { _resetCache, initCache } = await import('./index.js');
    _resetCache();

    const openReq = {
      result: mockDB,
      error: null,
      onsuccess: null as (() => void) | null,
      onerror: null,
      onupgradeneeded: null,
    };
    vi.stubGlobal('indexedDB', { open: vi.fn(() => openReq) });
    setTimeout(() => openReq.onsuccess?.(), 0);

    const db = await initCache();
    expect(db).toBe(mockDB);
  });

  it('cacheGame and getCachedGame work end-to-end', async () => {
    const { mockDB } = makeMockIndexedDB();
    const { _resetCache, initCache, cacheGame, getCachedGame } = await import('./index.js');
    _resetCache();

    const openReq = {
      result: mockDB,
      error: null,
      onsuccess: null as (() => void) | null,
      onerror: null,
      onupgradeneeded: null,
    };
    vi.stubGlobal('indexedDB', { open: vi.fn(() => openReq) });
    setTimeout(() => openReq.onsuccess?.(), 0);

    await initCache();
    await cacheGame('https://example.com/game.html', '<html>game</html>');
    const cached = await getCachedGame('https://example.com/game.html');
    expect(cached).toBe('<html>game</html>');
  });
});
