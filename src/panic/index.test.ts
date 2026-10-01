import { describe, it, expect } from 'vitest';
import { resolvePanicUrl, DEFAULT_PANIC_URL } from './index.js';

describe('resolvePanicUrl', () => {
  it('passes through public https URLs', () => {
    expect(resolvePanicUrl('https://classroom.google.com/')).toBe('https://classroom.google.com/');
  });

  it('neutralizes javascript: import payloads', () => {
    expect(resolvePanicUrl('javascript:alert(1)')).toBe(DEFAULT_PANIC_URL);
    expect(resolvePanicUrl('data:text/html,x')).toBe(DEFAULT_PANIC_URL);
  });

  it('falls back on null, empty, and intranet URLs', () => {
    expect(resolvePanicUrl(null)).toBe(DEFAULT_PANIC_URL);
    expect(resolvePanicUrl('')).toBe(DEFAULT_PANIC_URL);
    expect(resolvePanicUrl('http://localhost/')).toBe(DEFAULT_PANIC_URL);
  });
});
