import { describe, it, expect, beforeEach } from 'vitest';
import { looksLikeLuminCode, saveLuminScript, getLuminScript, _resetLuminStore } from './index.js';

beforeEach(() => {
  _resetLuminStore();
});

describe('looksLikeLuminCode', () => {
  it('rejects tiny or unrelated bodies', () => {
    expect(looksLikeLuminCode('')).toBe(false);
    expect(looksLikeLuminCode('x'.repeat(60000))).toBe(false);
  });

  it('accepts large bodies mentioning Lumin', () => {
    expect(looksLikeLuminCode(`Lumin${'x'.repeat(60000)}`)).toBe(true);
  });
});

describe('lumin script store', () => {
  it('round-trips through the memory fallback', async () => {
    const code = `Lumin${'y'.repeat(60000)}`;
    await saveLuminScript('https://example.com/lumin.min.js', code);
    const got = await getLuminScript();
    expect(got?.code).toBe(code);
    expect(got?.url).toContain('example.com');
  });

  it('refuses to store garbage', async () => {
    await saveLuminScript('https://example.com/bad.js', 'not real code');
    expect(await getLuminScript()).toBeNull();
  });
});
