import posthog from 'posthog-js';

// PostHog project key (publishable `phc_` key — safe to ship client-side).
// PostHog Dashboard > Project settings > Project API key, then replace below.
export const POSTHOG_KEY: string = 'phc_osP2cJgkWEZ2FWpPD5NXM6rB2h5XNDrxgVwJqgB8YCoG';
// Proxied through your Cloudflare Worker (worker/src/index.js `/ph/*`) so
// requests never touch adblock-listed *.i.posthog.com. Replace with your
// deployed worker origin (Cloudflare Dashboard > Workers, or
// `npx wrangler deployments` inside worker/), keeping the trailing /ph.
export const POSTHOG_WORKER_ORIGIN = 'https://url-marketplace.jesherhead.workers.dev';
export const POSTHOG_HOST = POSTHOG_WORKER_ORIGIN + '/ph';

let started = false;

export function initAnalytics(): void {
  if (started || POSTHOG_KEY === 'phc_REPLACE_ME') return;
  started = true;
  try {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      defaults: '2026-05-30',
      // Manual $pageview below: PostHog's installation health check looks for
      // it explicitly, and explicit capture is deterministic regardless of
      // autocapture default changes across SDK versions.
      capture_pageview: false,
      // capture_performance defaults to undefined ("ask the project"), which
      // leaves web vitals off unless enabled in project settings. Force it
      // here so $web_vitals events flow regardless of remote config.
      // network_timing left alone: it only feeds Session Replay.
      capture_performance: { web_vitals: true },
      // DNT is a voluntary signal, not law, and honoring it made all DNT
      // browsers (e.g. the owner's laptop) invisible in stats. Revert to
      // true if you ever want strict DNT honoring back.
      respect_dnt: false,
    });
    posthog.capture('$pageview');
  } catch {
    /* analytics must never break the app */
  }
}

export function trackGamePlay(name: string, url: string): void {
  if (!started) return;
  try {
    posthog.capture('game_play', { game: name, url });
  } catch {
    /* ignore */
  }
}
