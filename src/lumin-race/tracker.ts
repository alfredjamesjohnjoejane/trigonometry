export interface RaceTracker {
  readonly won: boolean;
  readonly finished: number;
  /** Returns true for the first (winning) caller, false afterwards. */
  win(): boolean;
  /** Record one exhausted lane; fires onExhausted exactly once at total. */
  lose(): void;
}

/** Counts a staggered-mirror race: first win cancels the rest, Nth loss fails. */
export function createRaceTracker(total: number, onExhausted: () => void): RaceTracker {
  let won = false;
  let finished = 0;
  let fired = false;
  return {
    get won() {
      return won;
    },
    get finished() {
      return finished;
    },
    win(): boolean {
      if (won) return false;
      won = true;
      return true;
    },
    lose(): void {
      finished += 1;
      if (!won && !fired && finished >= total) {
        fired = true;
        onExhausted();
      }
    },
  };
}
