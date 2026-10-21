import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetLuminState,
  claimLuminInit,
  luminInitInFlight,
  luminInitPromise,
  luminInitSnapshot,
  markLuminInitFailed,
  markLuminInitOk,
  recordLuminFetchUrl,
  setLuminInitPromise,
} from './index.js';

describe('lumin init state', () => {
  beforeEach(() => {
    _resetLuminState();
  });

  it('hands the init slot to the first caller only', () => {
    expect(claimLuminInit()).toBe(true);
    // Every later mirror must be refused: a second Lumin.init() destroys the
    // rendered grid and then fails with "domain fetch failed".
    expect(claimLuminInit()).toBe(false);
    expect(claimLuminInit()).toBe(false);
    expect(luminInitSnapshot().attempts).toBe(1);
  });

  it('reports the phase transitions', () => {
    expect(luminInitSnapshot().phase).toBe('idle');
    expect(luminInitInFlight()).toBe(false);

    claimLuminInit();
    expect(luminInitSnapshot().phase).toBe('loading');
    expect(luminInitInFlight()).toBe(true);

    markLuminInitOk();
    expect(luminInitSnapshot().phase).toBe('ok');
    expect(luminInitInFlight()).toBe(true);
  });

  it('keeps the failure reason', () => {
    claimLuminInit();
    markLuminInitFailed(new Error('domain fetch failed'));
    const snap = luminInitSnapshot();
    expect(snap.phase).toBe('failed');
    expect(snap.errorName).toBe('Error');
    expect(snap.errorMessage).toBe('domain fetch failed');
    expect(luminInitInFlight()).toBe(false);
  });

  it('collects the URLs the SDK fetched during init', () => {
    claimLuminInit();
    recordLuminFetchUrl('https://a.luminsdk.com/api/v1/boot?t=abc');
    recordLuminFetchUrl('https://a.luminsdk.com/api/v1/boot?t=abc');
    recordLuminFetchUrl('https://a.luminsdk.com/v1/lumin.worker.js');
    expect(luminInitSnapshot().fetchUrls).toEqual([
      'https://a.luminsdk.com/api/v1/boot?t=abc',
      'https://a.luminsdk.com/v1/lumin.worker.js',
    ]);
  });

  it('exposes the init promise', async () => {
    expect(luminInitPromise()).toBeNull();
    const p = Promise.resolve(true);
    setLuminInitPromise(p);
    expect(luminInitPromise()).toBe(p);
    await expect(luminInitPromise()).resolves.toBe(true);
  });

  it('resets back to idle', () => {
    claimLuminInit();
    markLuminInitFailed(new Error('boom'));
    _resetLuminState();
    expect(luminInitSnapshot().phase).toBe('idle');
    expect(luminInitSnapshot().attempts).toBe(0);
    expect(luminInitPromise()).toBeNull();
    expect(claimLuminInit()).toBe(true);
  });
});
