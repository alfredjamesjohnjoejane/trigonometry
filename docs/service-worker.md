# Service Worker & PWA

## Service Worker

**File**: `public/sw.js`

### Overview

The service worker provides:
- Offline access to the app shell
- Game thumbnail caching
- Automatic updates with user consent
- Cache management and eviction

### Lifecycle

```
Install → Wait → Activate → Fetch (steady state)
```

#### Install Event

```js
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(
        staticAssets().map(url => cache.add(url).catch(...))
      ))
      .then(() => caches.open(IMAGE_CACHE_NAME))
  );
});
```

- Precaches all static assets individually (one 404 doesn't fail the batch)
- Does NOT call `skipWaiting()` — the new worker waits for user consent

#### Activate Event

```js
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => /* delete old caches */)
      .then(() => cleanupCache(CACHE_NAME, MAX_CACHE_ENTRIES))
      .then(() => cleanupCache(IMAGE_CACHE_NAME, MAX_IMAGE_CACHE_ENTRIES))
      .then(() => self.clients.claim())
  );
});
```

- Deletes all caches not matching the current version
- Cleans up expired and excess entries
- Claims all open clients immediately

### Fetch Handling

```js
self.addEventListener('fetch', (event) => {
  // Game images → cache-first
  // Cross-origin HTML → network-first with offline fallback
  // Mutable assets → network-first with offline fallback
  // Static assets → cache-first
  // Everything else → network-first with offline fallback
});
```

### Image Cache

Game thumbnails from `iili.io` and `cdn.jsdelivr.net` are cached separately:

```js
const GAME_IMAGE_ORIGINS = ['iili.io', 'cdn.jsdelivr.net'];
```

- Cache-first strategy
- Stored with `sw-cache-date` header for expiry tracking
- Max 1000 entries, 30-day expiry

### Message Handling

```js
self.addEventListener('message', (event) => {
  if (data === 'skipWaiting') self.skipWaiting();
  if (data === 'getVersion') port.postMessage({ version: CACHE_NAME });
});
```

- `SKIP_WAITING`: Triggers immediate activation
- `getVersion`: Returns the current cache name (used by the update checker)

---

## PWA (Progressive Web App)

### Manifest

**File**: `public/manifest.json`

```json
{
  "name": "jesherhead",
  "short_name": "jesherhead",
  "display": "standalone",
  "background_color": "#111111",
  "theme_color": "#e0e0e0",
  "orientation": "portrait-primary",
  "icons": [/* 72x72 through 512x512, maskable */],
  "categories": ["games", "entertainment"],
  "shortcuts": [
    { "name": "Games", "url": "./" },
    { "name": "Settings", "url": "./?settings=1" }
  ]
}
```

### Install Flow

1. **`beforeinstallprompt`** event fires (Chrome/Edge) — the listener is
   registered at module scope, not in the boot handler, so an event that
   arrives while the document is still parsing is captured too
2. Event is captured (`setDeferredPrompt`) and the install button is (re)wired:
   - prompt available → button calls `installPWA()` → native install dialog
   - no prompt (Firefox/Safari/older Chrome) → button shows the
     "Open browser menu → Install jesherhead" hint
3. `installPWA()` calls `prompt()` and reads `userChoice` **before** dropping
   the event (`prompt()` is single-use)
4. **Install completes** through any of these signals, and each one routes to
   `syncPWAInstallUI()`:
   - `appinstalled` event on this page
   - `userChoice` resolving to `accepted`
   - a later standalone launch (persisted as the `pwaInstalled` flag)
5. Result: enforcement overlay hidden, enforcement layers stopped, install
   button hidden, "✅ Added to home screen" message shown

### Platform Detection

```ts
const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.matchMedia('(display-mode: fullscreen)').matches ||
                     window.navigator.standalone;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
```

- **Standalone mode**: Shows "Added to home screen" message, hides enforcement overlay
- **iOS**: Hides install button (iOS doesn't support `beforeinstallprompt`; user must use Share → Add to Home Screen)
- **Other**: Shows install button when `beforeinstallprompt` fires

### PWA Enforcement Overlay

**File**: `index.html` (overlay markup) + `src/ui/index.ts` (`enforcePWAOverlay`)

The app enforces installation as a PWA — it cannot be used in a regular browser tab.

#### Overlay Behavior

1. **Visible by default** in HTML (`display: flex`) — blocks access even if JS fails or is disabled
2. **`<noscript>` fallback** — reinforces overlay visibility and shows "JavaScript Required" message
3. **Boot evaluates the gate first** (`enforcePWAOverlay()` runs before the rest
   of init) and boots immediately if the module is evaluated after
   `DOMContentLoaded` already fired — otherwise a missed event would leave the
   gate stuck open forever
4. **JS hides the gate** as soon as `syncPWAInstallUI()` sees
   `isStandaloneMode() || isAppInstalled()` — at boot, on `appinstalled`, on an
   accepted `userChoice`, on focus/visibility, and from the watchdog interval

#### `isStandaloneMode()` Detection

```ts
function isStandaloneMode(): boolean {
  // never throws: a failed check must not abort the gate evaluation
  return (
    matches('(display-mode: standalone)') ||
    matches('(display-mode: fullscreen)') ||
    matches('(display-mode: window-controls-overlay)') ||
    matches('(display-mode: tabbed)') ||
    navigator.standalone === true  // iOS
  );
}
```

- `display-mode: standalone` — Standard PWA install (Chrome, Edge, Firefox, Safari on macOS)
- `display-mode: fullscreen` — Fullscreen PWA mode (rare, but valid)
- `display-mode: window-controls-overlay` / `tabbed` — Chrome OS app windows
- `navigator.standalone` — iOS home screen app (legacy, but still used)
- Every `matchMedia` call is wrapped: a throwing/absent API degrades to
  "not standalone" and falls back to the persisted `pwaInstalled` flag instead
  of leaving the gate stuck open

#### Strict Enforcement Layers

Active only while the app is **not** installed; `stopPWAEnforcement()` tears
them all down the moment an install signal arrives, so enforcement can never
fight the dismissal.

1. **MutationObserver** — Watches overlay for `style`/`class` changes AND watches `document.body` for childList changes (catches removal). Re-attaches and re-shows overlay if hidden/removed.

2. **CSS z-index lock** — Injects `!important` z-index to keep overlay above everything.

3. **Resize listener** — Re-checks install state on window resize.

4. **Focus / visibilitychange listener** — Catches installs completed in
   another tab (the shared `pwaInstalled` flag is re-read when the user
   returns).

5. **Periodic check (2s interval)** — Catches edge cases like session restore, back-forward cache, etc. Stops itself once installed.

#### Install Flow from Overlay

1. User clicks "Install App" button (Android/Chrome/Edge)
2. `beforeinstallprompt` captured earlier → `prompt.prompt()` called
3. Browser shows native install dialog
4. On `appinstalled` **or** an accepted `userChoice`: `syncPWAInstallUI()`
   hides the overlay, stops enforcement, persists the `pwaInstalled` flag and
   shows the toast
5. On browsers without `beforeinstallprompt`, the button explains the browser
   menu route (⋮ → Install) instead of doing nothing

#### iOS Handling

- Install button hidden (native prompt not supported)
- Instructions shown: "Tap Share → Add to Home Screen"
- `navigator.standalone` detects iOS home screen launch

### Offline Page

**File**: `public/offline.html`

Shown when:
- Network is down and no cached version exists
- Service worker fetch fails and cache miss occurs

The offline page includes a "Check for Updates" button that posts `getVersion` to the service worker.

---

## Update System

The update system is split between the inline script in `index.html` and the service worker:

### Inline Script (index.html)

```js
// Runs immediately, before the app bundle
navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href)
  .then(reg => {
    // Check for waiting worker from previous session
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg);
    // Track new installations
    reg.addEventListener('updatefound', () => trackInstalling(reg));
    // Initial update check
    checkForUpdate(reg);
    // Periodic checks
    setInterval(() => checkForUpdate(reg), 60 * 60 * 1000);
    // On tab focus
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkForUpdate(reg);
    });
    // On reconnect
    window.addEventListener('online', () => checkForUpdate(reg));
  });
```

### Update Toast

```
┌─────────────────────────────────────┐
│  New version available!  [Update]   │
└─────────────────────────────────────┘
```

- Fixed at bottom center of screen
- Shows once per session
- "Update" button: Posts `SKIP_WAITING`, reloads on `controllerchange`
- Fallback reload after 3 seconds if activation stalls
- Never auto-reloads (would interrupt gameplay)

### Controller Change

When another tab accepts the update:
- If toast already shown: reload immediately
- If toast not shown: show a "Reload" variant (no `SKIP_WAITING` needed)
- `hadController` flag distinguishes first-install claim from real update
