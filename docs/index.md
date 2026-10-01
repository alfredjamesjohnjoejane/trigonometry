# jesherhead Documentation

## Overview

jesherhead is a static single-page application (SPA) that serves as a game hub with 1000+ games. It's designed to be self-hosted on GitHub Pages with no backend required.

## Documentation Index

### [Architecture](architecture.md)
High-level system design, module structure, boot sequence, and data flow diagrams.

### [Build & Development](build-and-development.md)
Getting started, build process, testing, linting, and deployment instructions.

### [Game System](game-system.md)
Game catalog, rendering, launching, search, sorting, favorites, and play tracking.

### [Security](security.md)
DevTools deterrent, URL validation, HTML escaping, iframe sandboxing, CSP, and settings import sanitization.

### [Cloak & Panic](cloak-and-panic.md)
Tab cloaking (about:blank shell pattern, decoy titles) and panic key system.

### [Storage & Caching](storage-and-caching.md)
localStorage wrapper, IndexedDB game cache, and service worker cache strategies.

### [Service Worker & PWA](service-worker.md)
Offline support, asset caching, update flow, and PWA installability.

### [Analytics](analytics.md)
PostHog analytics configuration, event tracking, and the Cloudflare Worker proxy.

### [Cloudflare Worker](cloudflare-worker.md)
URL Marketplace API, GitHub Issues integration, voting system, rate limiting, and admin panel.

### [Settings & Theming](settings-and-theming.md)
Settings page, import/export, theme system, custom themes, and play timer.

### [UI Module](ui-module.md)
Landing page flow, TOS gate, game status checks, online/offline detection, and PWA install.

### [URL Marketplace](url-marketplace.md)
Community link submission system, voting, categories, and safety screening.

## Quick Reference

### Module Map

```
src/
├── main.ts              # Entry point
├── analytics/           # PostHog analytics
├── cache/               # IndexedDB game cache
├── cloak/               # Tab cloaking
├── games/               # Game catalog & launching
├── mediaos/             # MediaOS streaming page
├── panic/               # Panic key
├── security/            # DevTools deterrent
├── settings/            # Settings & import/export
├── storage/             # localStorage wrapper
├── theme/               # Theme system
├── types/               # TypeScript types & constants
├── ui/                  # UI orchestration
└── utils/               # Shared utilities
```

### Key Files

| File | Purpose |
|------|---------|
| `index.html` | SPA shell with inline CSS and early security script |
| `public/sw.js` | Service worker (offline support, asset caching) |
| `public/manifest.json` | PWA manifest |
| `public/data/games_merged.json` | Game catalog (1000+ entries) |
| `public/urls.html` | URL Marketplace page |
| `public/developers.html` | Developer info page |
| `public/offline.html` | Offline fallback page |
| `public/terms_of_service.txt` | TOS text |
| `worker/src/index.js` | Cloudflare Worker (URL Marketplace API) |
| `scripts/build.mjs` | Post-build version injection |
| `vite.config.ts` | Vite configuration |
| `tsconfig.json` | TypeScript configuration |

### External Services

| Service | Purpose |
|---------|---------|
| GitHub Pages | Static site hosting |
| Cloudflare Worker | URL Marketplace API + PostHog proxy |
| GitHub Issues | Marketplace database |
| Cloudflare KV | Rate limits, vote tallies, config |
| PostHog | Analytics |
| jsDelivr | Game content CDN |
| Lumin SDK | Game loader SDK |
