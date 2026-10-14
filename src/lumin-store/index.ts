const DB_NAME = 'jesherhead_lumin';
const DB_VERSION = 1;
const STORE = 'scripts';
const ROW_KEY = 'latest-good';

export interface StoredLuminScript {
  url: string;
  code: string;
  savedAt: number;
}

const memory = new Map<string, StoredLuminScript>();
let useMemory = false;
let db: IDBDatabase | null = null;

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function';
  } catch {
    return false;
  }
}

/** @internal - reset for tests */
export function _resetLuminStore(): void {
  db = null;
  memory.clear();
  useMemory = false;
}

function openDb(): Promise<IDBDatabase | null> {
  if (db || useMemory) return Promise.resolve(db);
  if (!idbAvailable()) {
    useMemory = true;
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    let settled = false;
    const done = (v: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (v) db = v;
      else useMemory = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 4000);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      done(null);
      return;
    }
    req.onerror = () => done(null);
    req.onblocked = () => done(null);
    req.onsuccess = () => done(req.result);
    req.onupgradeneeded = () => {
      try {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      } catch {
        /* ignore */
      }
    };
  });
}

/** Heuristic: real lumin.min.js is ~180KB and defines the Lumin global. */
export function looksLikeLuminCode(code: string): boolean {
  if (typeof code !== 'string' || code.length < 50000) return false;
  return code.includes('Lumin');
}

export async function saveLuminScript(url: string, code: string): Promise<void> {
  if (!looksLikeLuminCode(code)) return;
  const row: StoredLuminScript = { url, code, savedAt: Date.now() };
  const database = await openDb().catch(() => null);
  if (!database) {
    memory.set(ROW_KEY, row);
    return;
  }
  await new Promise<void>(resolve => {
    try {
      const tx = database.transaction([STORE], 'readwrite');
      tx.onerror = () => resolve();
      const store = tx.objectStore(STORE);
      const put = store.put({ id: ROW_KEY, ...row });
      put.onsuccess = () => resolve();
      put.onerror = () => resolve();
    } catch {
      memory.set(ROW_KEY, row);
      resolve();
    }
  });
}

export async function getLuminScript(): Promise<StoredLuminScript | null> {
  const mem = memory.get(ROW_KEY);
  const database = await openDb().catch(() => null);
  if (!database) return mem ?? null;
  const fromDb = await new Promise<StoredLuminScript | null>(resolve => {
    try {
      const tx = database.transaction([STORE], 'readonly');
      tx.onerror = () => resolve(null);
      const store = tx.objectStore(STORE);
      const get = store.get(ROW_KEY);
      get.onsuccess = () => {
        const v = get.result as (StoredLuminScript & { id?: string }) | undefined;
        if (v && typeof v.code === 'string') {
          resolve({ url: v.url, code: v.code, savedAt: v.savedAt });
        } else resolve(null);
      };
      get.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  if (fromDb) return fromDb;
  return mem ?? null;
}
