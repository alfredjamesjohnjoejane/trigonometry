# UI Module

**Module**: `src/ui/index.ts` (845 lines)

The UI module orchestrates the main user interface: landing page, game overlay, settings page, TOS gate, status checks, and PWA install.

## Responsibilities

| Area | Functions |
|------|-----------|
| Landing page | `setRandomLandingText()`, `showLandingChoice()`, `enterHub()` |
| TOS gate | `showTOSPopup()`, `acknowledgeTOS()`, `declineTOS()`, `showTOSViewer()` |
| DMCA | `showDCMAInfo()`, `closeDCMAViewer()` |
| Game status | `checkGameStatus()`, `pingTarget()`, `showMaintenance()` |
| PWA | `enforcePWAOverlay()`, `syncPWAInstallUI()`, `checkPWAInstallAvailability()`, `installPWA()` |
| Online/offline | `updateOnlineStatus()` |
| Play timer | `startPlayTimer()` |
| Cloak | `openCloak()` |
| Media | `openMedia1()`, `openUrlInAboutBlank()` |
| Settings | `showSettingsPage()`, `showGamesPage()`, `goMainHomepage()` |
| Info popup | `showInfoPopup()`, `closeInfoPopup()` |

## Window Bridge Pattern

The UI module exposes many functions on `window` so inline `onclick` handlers in `index.html` can call them:

```ts
(window as unknown as Record<string, unknown>).showInfoPopup = showInfoPopup;
(window as unknown as Record<string, unknown>).enterHub = enterHub;
(window as unknown as Record<string, unknown>).launchGame = launchGame;
// ... 30+ more
```

This is necessary because the HTML uses inline event handlers (`onclick="enterHub()"`) rather than `addEventListener`.

## Landing Page Flow

```
Landing Page (#lp)
    │
    ├── "Continue →" → enterHub()
    │     │
    │     ├── TOS valid? → Show main content
    │     └── TOS invalid? → Show TOS modal
    │
    ├── "Settings" → showLandingChoice('settings')
    │     └── showSettingsPage()
    │
    ├── "TOS" → showTOSViewer()
    │
    ├── "Padlet" → window.open(Padlet URL)
    │
    └── "Media" → showLandingChoice('media')
          └── openMedia1()
```

## TOS (Terms of Service) Gate

### First Visit

```ts
function showTOSPopup(): void
```

1. Fetches `terms_of_service.txt`
2. Computes FNV-1a hash of the text
3. Compares with stored hash in localStorage
4. If match and < 7 days old: no modal needed
5. If mismatch or expired: show modal

### TOS Modal Behavior

- **NOT dismissable via backdrop click** (must click "I Agree" or "Decline")
- Backdrop clicks are swallowed with `e.stopPropagation()`
- "I Agree": Stores agreement + hash + timestamp, closes modal
- "Decline": Shows message that hub stays locked, no close option

### TOS Hash

```ts
function computeTOSHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36) + ':' + text.length;
}
```

FNV-1a hash over the FULL text (not just a prefix), with length appended. This ensures any edit to the TOS invalidates previous agreements.

### TOS Viewer

The landing page "TOS" button opens a read-only viewer that IS dismissable via backdrop click (unlike the first-visit gate).

## Game Status Check

```ts
async function checkGameStatus(_showToast = true): Promise<void>
```

Pings CDN targets concurrently:

```ts
const CDN_TARGETS = [
  { name: 'jsDelivr', url: 'https://cdn.jsdelivr.net/favicon.ico' },
  { name: 'Lumin SDK', url: 'https://cdn.jsdelivr.net/gh/luminsdk/script@latest/lumin.min.js' },
];
```

### Ping Mechanism

```ts
async function pingTarget(name: string, url: string): Promise<StatusResult> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 5000);
  await fetch(url, { signal: c.signal, mode: 'no-cors', cache: 'no-store' });
  return { name, status: 'pass', ms: Math.round(performance.now() - start) };
}
```

- Uses `no-cors` mode to avoid CORS errors from CDNs without CORS headers
- 5-second timeout
- Opaque responses can't expose status codes, but reachability is sufficient

### Status Display

Results are shown in the settings page:

```
✅ Online (2/2 CDNs reachable)
  jsDelivr ✓ (245ms)
  Lumin SDK ✓ (189ms)
```

### Maintenance Mode

If all CDNs are unreachable:
- Shows maintenance overlay (`#maintenance-page`)
- "Games Offline" message with retry and media buttons
- Status updates every 5 minutes

## Online/Offline Detection

```ts
function updateOnlineStatus(): void {
  isOnline = navigator.onLine;
  const offlineOverlay = document.getElementById('offline-overlay');
  if (offlineOverlay) {
    offlineOverlay.style.display = isOnline ? 'none' : 'flex';
  }
  renderGames();
}
```

- Listens to `window.online` and `window.offline` events
- Shows a full-screen overlay when offline
- Re-renders games (to show/hide based on availability)

## Info Popup

```ts
function showInfoPopup(): void
```

Shows information about jesherhead:
- Open source & free
- Safe & secure
- Blazing fast
- The competition (comparison to HammerHeadHub)
- Built by the community

## Media Launcher

```ts
async function openMedia1(): Promise<void>
```

Opens a media streaming page in an about:blank shell:

1. Decodes base64-encoded MediaOS HTML (`MEDIAOS_BASE64` from `src/mediaos/page.ts`)
2. Opens about:blank shell with media icon
3. Embeds decoded HTML as a data URL in a sandboxed iframe
4. The iframe has a toolbar with Back, title, and Close buttons

## Hash Router

```ts
function initViewFromHash(): void {
  if (location.hash === '#settings') showSettingsPage();
}
```

- Called on load and on `hashchange`
- `#settings` opens the settings page
- No other hash routes

## Landing Choice Modal

```ts
function showLandingChoice(action: string, label: string): void
```

Shows a modal asking "Open this?" with options:
- **Stay in this tab**: Runs the action in the current tab
- **Open new tab**: Opens in an about:blank shell
- **Cancel**: Closes the modal

Used for: Settings, Media, and other external links.
