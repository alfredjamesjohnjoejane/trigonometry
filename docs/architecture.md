# Architecture Overview

## What is jesherhead?

jesherhead is a static single-page application (SPA) that serves as a game hub with 1000+ games. It is a fork of HammerHeadHub, designed to be self-hosted on GitHub Pages with no backend required. The site features:

- **Game catalog** with search, filtering, sorting, and favorites
- **Panic key** for quick escape to a decoy site
- **Tab cloaking** to disguise the site as Google Classroom, Docs, or Drive
- **Offline support** via a service worker
- **PWA installability** for mobile and desktop
- **URL Marketplace** powered by a Cloudflare Worker
- **Analytics** via PostHog (proxied through the Cloudflare Worker)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Build tool | Vite 5 |
| Language | TypeScript 5.6 (strict mode) |
| Runtime | Vanilla JS (no framework) |
| Styling | Inline CSS in `index.html` + CSS custom properties |
| Testing | Vitest 2 + jsdom |
| Linting | ESLint 9 + Prettier |
| Analytics | PostHog JS |
| Backend (marketplace) | Cloudflare Worker |
| Deployment | GitHub Pages |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Client)                     │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  index.html  │  │  Service     │  │  IndexedDB    │  │
│  │  (SPA shell) │  │  Worker      │  │  (game cache) │  │
│  │              │  │  (sw.js)     │  │               │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────────┘  │
│         │                  │                              │
│  ┌──────┴──────────────────┴───────┐                     │
│  │         src/main.ts             │                     │
│  │  (module entry, boot sequence)  │                     │
│  └──┬──────┬──────┬──────┬─────────┘                     │
│     │      │      │      │                                │
│  ┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐                           │
│  │games││ui/  ││secur││cloak│  ... (12 modules)         │
│  └─────┘└─────┘└─────┘└─────┘                           │
└─────────────────────────────────────────────────────────┘
                           │
                           │ fetch (games_merged.json, TOS)
                           ▼
┌─────────────────────────────────────────────────────────┐
│              GitHub Pages (Static Hosting)               │
│  index.html, sw.js, manifest.json, data/, icons/         │
└─────────────────────────────────────────────────────────┘
                           │
                           │ API calls (marketplace, analytics)
                           ▼
┌─────────────────────────────────────────────────────────┐
│           Cloudflare Worker (url-marketplace)             │
│  /list, /submit, /react, /report, /admin/*, /ph/*       │
│  GitHub Issues API + KV storage + PostHog proxy          │
└─────────────────────────────────────────────────────────┘
```

## Module Structure

```
src/
├── main.ts              # Entry point: imports all modules, boot sequence
├── analytics/           # PostHog analytics initialization
├── cache/               # IndexedDB game HTML cache
├── cloak/               # Tab cloaking (about:blank shell, decoy title)
├── games/               # Game catalog loading, rendering, launching
│   ├── index.ts         # Core game logic (574 lines)
│   └── html.ts          # HTML source game fetching + injection
├── mediaos/             # MediaOS streaming page (base64-encoded)
├── panic/               # Panic key handler
├── security/            # DevTools deterrent, right-click blocking
├── settings/            # Settings page, import/export, theme
├── storage/             # localStorage wrapper (safe, error-handling)
├── theme/               # Theme system (mono, shadow, midnight, custom)
├── types/               # TypeScript interfaces and constants
├── ui/                  # UI orchestration, TOS, status checks, PWA
│   ├── index.ts         # Main UI module (845 lines)
│   └── apps.ts          # Calculator, Proxy, CinemaOS launchers
└── utils/               # Shared utilities (URL safety, HTML escaping)
```

## Boot Sequence

The application boots in a specific order to ensure security and functionality:

1. **Module evaluation** (`main.ts` top-level):
   - `installDevtoolsProtection()` — blocks DevTools shortcuts, right-click
   - `initAnalytics()` — initializes PostHog

2. **DOMContentLoaded**:
   - `setupBlockedUrlGuards()` — prevents navigation to blocked ported domain
   - `scrubPortedLinks()` — removes blocked URLs from DOM
   - Online/offline detection setup
   - PWA install prompt capture
   - `setRandomLandingText()` — easter egg subtext
   - `showTOSPopup()` — Terms of Service gate
   - `initHomepageTest()` — Lumin SDK game loader
   - `initViewFromHash()` — hash router for #settings

3. **Window load**:
   - Store original base URL in localStorage
   - `loadGames()` — fetch game catalog from `data/games_merged.json`
   - Cloak iframe detection
   - `loadSettings()` — restore user preferences
   - `installCloakFocusHandlers()` — tab cloak on blur
   - `startPlayTimer()` — track play time
   - `handlePanicKey` — keyboard listener for panic key
   - `checkGameStatus()` — ping CDN targets
   - Periodic status checks every 5 minutes

## Data Flow

### Game Catalog
```
data/games_merged.json  ──fetch──>  loadGames()  ──>  GAMES[]
                                                        │
                                                        ▼
                                              renderGames()  ──>  DOM grid
                                                        │
                                                        ▼
                                              launchGame()   ──>  iframe overlay
```

### Game Launch Flow
```
User clicks Play
       │
       ▼
launchGame(url, name)
       │
       ├── Track analytics (PostHog)
       ├── Increment play count (localStorage)
       ├── Set iframe sandbox attributes
       │
       ├── If HTML source URL:
       │     └── buildRenderableHtml(url)  ──>  fetch + inject <base>
       │
       ├── If Lumin SDK test:
       │     └── getTestPageHtml()  ──>  Lumin.init()
       │
       └── Otherwise:
             └── buildGameIframeHtml(url)  ──>  wrapper iframe
```

### Cloak Flow
```
User clicks Cloak button
       │
       ▼
openLandingInAboutBlank()
       │
       ├── openAboutBlankShell(title, icon)  ──>  about:blank popup
       ├── appendShellIframe(shell, {src: siteUrl})  ──>  iframe the site
       └── location.replace(cloakUrl)  ──>  redirect current tab to decoy
```

## Key Design Decisions

1. **No framework**: Vanilla TS + DOM APIs for minimal bundle size and maximum portability
2. **Static hosting**: Everything runs client-side; no server needed for the hub itself
3. **Security-first**: Extensive URL validation, HTML escaping, sandboxed iframes, CSP headers
4. **Offline-first**: Service worker precaches all assets; games cache in IndexedDB
5. **about:blank pattern**: Cloaking uses `window.open('about:blank')` + DOM manipulation instead of `document.write` (which re-URLs the tab in Chrome)
6. **GitHub Issues as database**: The URL Marketplace uses GitHub Issues as a simple, free database via the Cloudflare Worker
