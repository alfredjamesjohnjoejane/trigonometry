import type { CacheEntry } from '../types/index.js';
import { DB_NAME, DB_VERSION, GAME_STORE, MAX_CACHE_ENTRIES } from '../types/index.js';

let db: IDBDatabase | null = null;
// In-memory fallback when IndexedDB is unavailable (private mode, blocked
// storage): the old code crashed on `db!` after a rejected initCache.
const memoryFallback = new Map<string, CacheEntry>();
let useMemoryFallback = false;

/** @internal - used by tests to reset module state */
export function _resetCache(): void {
  db = null;
  memoryFallback.clear();
  useMemoryFallback = false;
}

function indexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function';
  } catch {
    return false;
  }
}

export async function initCache(): Promise<IDBDatabase | null> {
  if (!indexedDBAvailable()) {
    useMemoryFallback = true;
    return null;
  }
  return new Promise(resolve => {
    let settled = false;
    const done = (v: IDBDatabase | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (!v) useMemoryFallback = true;
        else db = v;
        resolve(v);
      }
    };
    // Hang guard: if open neither succeeds, errors, nor blocks, every cache
    // op would wait forever. Fall back to memory after 5s.
    const timer = setTimeout(() => done(null), 5000);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      done(null);
      return;
    }
    request.onerror = () => {
      done(null);
    };
    request.onsuccess = () => {
      done(request.result);
    };
    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const database = (event.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(GAME_STORE)) {
        const store = database.createObjectStore(GAME_STORE, { keyPath: 'url' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    request.onblocked = () => {
      done(null);
    };
  });
}

let ensureDbPromise: Promise<IDBDatabase | null> | null = null;

async function ensureDb(): Promise<IDBDatabase | null> {
  if (db || useMemoryFallback) return db;
  if (!ensureDbPromise) {
    ensureDbPromise = initCache().finally(() => {
      ensureDbPromise = null;
    });
  }
  return ensureDbPromise;
}

export async function getCachedGame(url: string): Promise<string | null> {
  const database = await ensureDb();
  if (!database) {
    const entry = memoryFallback.get(url);
    return entry ? entry.html : null;
  }
  return new Promise(resolve => {
    let resolved = false;
    const done = (v: string | null) => {
      if (!resolved) {
        resolved = true;
        resolve(v);
      }
    };
    try {
      const transaction = database.transaction([GAME_STORE], 'readonly');
      transaction.onerror = () => done(null);
      const store = transaction.objectStore(GAME_STORE);
      const request = store.get(url);
      request.onsuccess = () => {
        if (request.result) {
          console.log('[Game Cache] Cache HIT for:', url);
          done(request.result.html);
        } else {
          console.log('[Game Cache] Cache MISS for:', url);
          done(null);
        }
      };
      request.onerror = () => {
        console.error('[Game Cache] Error getting cached game:', request.error);
        done(null);
      };
    } catch (e) {
      console.error('[Game Cache] Transaction failed:', e);
      done(null);
    }
  });
}

export async function cacheGame(url: string, html: string): Promise<void> {
  const database = await ensureDb();
  if (!database) {
    memoryFallback.set(url, { url, html, timestamp: Date.now() });
    enforceMemoryLimit();
    return;
  }
  return new Promise(resolve => {
    try {
      const transaction = database.transaction([GAME_STORE], 'readwrite');
      transaction.onerror = () => resolve();
      const store = transaction.objectStore(GAME_STORE);
      const entry: CacheEntry = { url, html, timestamp: Date.now() };
      const request = store.put(entry);
      request.onsuccess = () => {
        console.log('[Game Cache] Successfully cached:', url);
        void enforceCacheLimit().catch(() => {});
        resolve();
      };
      request.onerror = () => {
        console.error('[Game Cache] Error caching game:', request.error);
        resolve();
      };
    } catch (e) {
      console.error('[Game Cache] Transaction failed:', e);
      resolve();
    }
  });
}

function enforceMemoryLimit(): void {
  if (memoryFallback.size <= MAX_CACHE_ENTRIES) return;
  const ordered = [...memoryFallback.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
  for (let i = 0; i < ordered.length - MAX_CACHE_ENTRIES; i++) {
    const key = ordered[i]?.[0];
    if (key !== undefined) memoryFallback.delete(key);
  }
}

export async function clearGameCache(): Promise<void> {
  memoryFallback.clear();
  const database = await ensureDb();
  if (!database) return;
  return new Promise(resolve => {
    try {
      const transaction = database.transaction([GAME_STORE], 'readwrite');
      const store = transaction.objectStore(GAME_STORE);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function enforceCacheLimit(): Promise<void> {
  const database = await ensureDb();
  if (!database) {
    enforceMemoryLimit();
    return;
  }
  return new Promise(resolve => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction([GAME_STORE], 'readwrite');
    } catch {
      resolve();
      return;
    }
    transaction.onerror = () => resolve();
    const store = transaction.objectStore(GAME_STORE);
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      const count = countRequest.result;
      if (count > MAX_CACHE_ENTRIES) {
        const excess = count - MAX_CACHE_ENTRIES;
        const index = store.index('timestamp');
        const cursorRequest = index.openCursor();
        let deleted = 0;
        cursorRequest.onsuccess = (event: Event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor && deleted < excess) {
            try {
              const del = cursor.delete();
              del.onsuccess = () => {
                deleted++;
                cursor.continue();
              };
              del.onerror = () => {
                deleted++;
                try {
                  cursor.continue();
                } catch {
                  resolve();
                }
              };
            } catch {
              deleted++;
              try {
                cursor.continue();
              } catch {
                resolve();
              }
            }
          } else {
            console.log('[Game Cache] Enforced limit, removed', deleted, 'oldest entries');
            resolve();
          }
        };
        cursorRequest.onerror = () => resolve();
      } else {
        resolve();
      }
    };
    countRequest.onerror = () => resolve();
  });
}

export async function getCacheSize(): Promise<number> {
  const database = await ensureDb();
  if (!database) return memoryFallback.size;
  return new Promise(resolve => {
    try {
      const transaction = database.transaction([GAME_STORE], 'readonly');
      transaction.onerror = () => resolve(0);
      const store = transaction.objectStore(GAME_STORE);
      const countRequest = store.count();
      countRequest.onsuccess = () => resolve(countRequest.result);
      countRequest.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

export async function updateCacheSizeDisplay(): Promise<void> {
  const gameCount = await getCacheSize();
  const gameEl = document.getElementById('cache-size');
  const limitEl = document.getElementById('cache-limit');
  if (gameEl) gameEl.textContent = gameCount.toString();
  if (limitEl) limitEl.textContent = MAX_CACHE_ENTRIES.toString();
}

export async function handleClearCache(): Promise<void> {
  if (!confirm('Clear all cached games?')) return;
  try {
    await clearGameCache();
    await updateCacheSizeDisplay();
  } catch (e) {
    console.error('[Cache] Failed to clear:', e);
  }
}
