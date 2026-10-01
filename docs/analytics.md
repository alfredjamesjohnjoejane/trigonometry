# Analytics

## Overview

**Module**: `src/analytics/index.ts`

Analytics uses PostHog, a product analytics platform. The PostHog JS SDK is the only runtime dependency in `package.json`.

## Configuration

```ts
export const POSTHOG_KEY = 'phc_osP2cJgkWEZ2FWpPD5NXM6rB2h5XNDrxgVwJqgB8YCoG';
export const POSTHOG_WORKER_ORIGIN = 'https://url-marketplace.jesherhead.workers.dev';
export const POSTHOG_HOST = POSTHOG_WORKER_ORIGIN + '/ph';
```

### Why a Proxy?

PostHog's default hosts (`*.i.posthog.com`) are on adblock lists. By proxying through the Cloudflare Worker at `/ph/*`, analytics requests bypass adblockers.

## Initialization

```ts
export function initAnalytics(): void
```

Called during module evaluation (before DOMContentLoaded):

```ts
posthog.init(POSTHOG_KEY, {
  api_host: POSTHOG_HOST,
  defaults: '2026-05-30',
  capture_pageview: false,        // Manual capture below
  capture_performance: { web_vitals: true },
  respect_dnt: false,
});
posthog.capture('$pageview');
```

### Settings

| Setting | Value | Reason |
|---------|-------|--------|
| `capture_pageview` | `false` | Manual capture is deterministic |
| `capture_performance.web_vitals` | `true` | Force web vitals regardless of project settings |
| `respect_dnt` | `false` | DNT is voluntary, not law; honoring it made DNT browsers invisible |
| `defaults` | `'2026-05-30'` | API version pinning |

## Events

### `$pageview`

Captured once on initialization. Manual capture ensures it fires regardless of SDK autocapture defaults.

### `game_play`

```ts
export function trackGamePlay(name: string, url: string): void
```

Captured on every game launch:

```ts
posthog.capture('game_play', { game: name, url });
```

## Error Handling

All analytics calls are wrapped in try/catch — analytics must never break the app:

```ts
try {
  posthog.capture('game_play', { game: name, url });
} catch {
  /* ignore */
}
```

## PostHog Proxy (Cloudflare Worker)

The Cloudflare Worker (`worker/src/index.js`) proxies PostHog requests:

```js
// GET/POST /ph/<posthog-path> → https://us.i.posthog.com/<posthog-path>
async function proxyPosthog(request, url) {
  const upstreamPath = url.pathname.replace(/^\/ph/, '') || '/';
  const target = new URL(upstreamPath + url.search, POSTHOG_UPSTREAM);
  // ... forwards method, headers, body
}
```

- Handled before the `GITHUB_TOKEN` check (analytics never depends on marketplace config)
- Never rate-limited
- Never gated on marketplace mode
- Adds CORS headers for the jesherhead origin

## Privacy Considerations

- **No personal data collected**: Only page views and game play events
- **No user identification**: No user IDs, emails, or PII
- **DNT not respected**: Documented decision — DNT is a voluntary signal
- **Self-hostable**: The PostHog key can be replaced with a self-hosted instance
