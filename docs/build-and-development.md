# Build & Development Guide

## Prerequisites

- Node.js 18+ and npm
- Git

## Getting Started

```bash
# Install dependencies
npm install

# Start dev server (http://localhost:3000)
npm run dev

# Run tests
npm test

# Type-check
npm run typecheck

# Lint
npm run lint

# Format
npm run format
```

## Build Process

```bash
npm run build
```

The build pipeline has three stages:

1. **`tsc`** — TypeScript type-checking (no emit, just validation)
2. **`vite build`** — Bundles `src/main.ts` and outputs to `dist/`
3. **`node scripts/build.mjs`** — Post-build script that injects a unique version string into `dist/sw.js`

### Build Output

The `dist/` directory contains:
- `index.html` — The SPA (with inlined CSS and the module script)
- `sw.js` — Service worker with injected version
- `manifest.json` — PWA manifest
- `offline.html` — Offline fallback page
- `terms_of_service.txt` — TOS text
- `data/games_merged.json` — Game catalog
- `icons/` — PWA icons (various sizes)
- `background.jpg` — Background image

### Version Injection

The build script (`scripts/build.mjs`) resolves a unique build ID from:
1. Git short SHA (`git rev-parse --short HEAD`)
2. Full git SHA
3. `GITHUB_SHA` environment variable (CI)
4. Timestamp fallback

This build ID is injected into `sw.js` replacing `{{VERSION}}`, ensuring the service worker cache name changes on every deploy. Without this, browsers would never detect updates because the SW file bytes would be identical.

## Vite Configuration

```ts
// vite.config.ts
base: mode === 'production' || mode === 'analyze' ? './' : '/'
```

- **Dev mode**: Base URL is `/` (served from localhost:3000)
- **Production**: Relative base (`./`) — every asset URL is resolved against
  the page, so the same build works on a GitHub Pages project site
  (`/<repo>/`), a custom domain at the root, and `vite preview`. A hardcoded
  `/jesherhead/` 404s the moment the repo is renamed or forked, which leaves
  the install gate stuck because the app bundle never loads.
- **Analyze mode**: Same as production, plus bundle visualizer

## TypeScript Configuration

- **Target**: ES2023
- **Module**: ESNext with bundler resolution
- **Strict mode**: Enabled with `noUncheckedIndexedAccess` and `noImplicitOverride`
- **No emit**: TypeScript only type-checks; Vite handles transpilation

## Testing

Tests use Vitest with jsdom environment:

```bash
npm test              # Run once
npm run test:watch    # Watch mode
```

Test files are co-located with source: `src/**/*.test.ts`

### Test Coverage Areas

| Module | Tests |
|--------|-------|
| `security/` | DevTools shortcut detection, context menu blocking, idempotency |
| `panic/` | URL resolution, javascript: neutralization |
| `storage/` | get/set/remove, error handling |
| `cache/` | IndexedDB init, cache get/put/clear |
| `utils/` | HTML escaping, URL safety validation, iframe HTML builder |

## Linting & Formatting

- **ESLint** with `typescript-eslint` and `prettier` plugin
- **Prettier** for code formatting (`.prettierrc`)
- Lint: `npm run lint`
- Fix: `npm run lint:fix`
- Format: `npm run format`
- Check: `npm run format:check`

## Deployment (GitHub Pages)

1. Push to `main` branch
2. Go to repo Settings → Pages
3. Source: "Deploy from a branch"
4. Branch: `main`, folder: `/ (root)`
5. Save — site is live at `https://<username>.github.io/<repo>/`

## Cloudflare Worker Deployment

The URL Marketplace worker is separate from the main site:

```bash
cd worker/
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put SAFE_BROWSING_KEY  # optional
npx wrangler deploy
```

The worker origin is configured in `src/analytics/index.ts` as `POSTHOG_WORKER_ORIGIN`.
