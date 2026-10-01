import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockStore = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => mockStore.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStore.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    mockStore.delete(key);
  }),
  clear: vi.fn(() => {
    mockStore.clear();
  }),
});

import ST from './index.js';

describe('ST storage wrapper', () => {
  beforeEach(() => {
    mockStore.clear();
    vi.clearAllMocks();
  });

  it('get returns null for missing keys', () => {
    expect(ST.get('nonexistent')).toBeNull();
  });

  it('set and get work correctly', () => {
    ST.set('key1', 'value1');
    expect(ST.get('key1')).toBe('value1');
  });

  it('set handles localStorage errors gracefully', () => {
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
      throw new Error('Storage full');
    });
    expect(() => ST.set('test', 'val')).not.toThrow();
  });

  it('get handles localStorage errors gracefully', () => {
    vi.mocked(localStorage.getItem).mockImplementationOnce(() => {
      throw new Error('Storage blocked');
    });
    expect(ST.get('test')).toBeNull();
  });

  it('overwrites existing values', () => {
    ST.set('key', 'old');
    ST.set('key', 'new');
    expect(ST.get('key')).toBe('new');
  });

  it('remove deletes keys', () => {
    ST.set('key', 'value');
    ST.remove('key');
    expect(ST.get('key')).toBeNull();
  });

  it('remove handles errors gracefully', () => {
    vi.mocked(localStorage.removeItem).mockImplementationOnce(() => {
      throw new Error('Storage error');
    });
    expect(() => ST.remove('test')).not.toThrow();
  });
});
