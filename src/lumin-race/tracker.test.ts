import { describe, it, expect, vi } from 'vitest';
import { createRaceTracker } from './tracker.js';

describe('createRaceTracker', () => {
  it('fires onExhausted exactly once at total losses', () => {
    const onExhausted = vi.fn();
    const t = createRaceTracker(3, onExhausted);
    t.lose();
    t.lose();
    expect(onExhausted).not.toHaveBeenCalled();
    t.lose();
    expect(onExhausted).toHaveBeenCalledTimes(1);
    t.lose();
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('first win sticks and suppresses exhaustion', () => {
    const onExhausted = vi.fn();
    const t = createRaceTracker(2, onExhausted);
    expect(t.win()).toBe(true);
    expect(t.win()).toBe(false);
    expect(t.won).toBe(true);
    t.lose();
    t.lose();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('tracks finished count', () => {
    const t = createRaceTracker(5, () => {});
    t.lose();
    t.lose();
    expect(t.finished).toBe(2);
  });
});
