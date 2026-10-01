# Security

## Overview

Security in jesherhead is multi-layered, covering client-side protections, URL validation, iframe sandboxing, and content security policy.

## DevTools Deterrent

**Module**: `src/security/index.ts`

A passive deterrent that makes DevTools usage annoying without breaking the app:

### Blocked Shortcuts

| Shortcut | Action |
|----------|--------|
| F12 | DevTools |
| ContextMenu key | Right-click menu |
| Shift+F10 | Keyboard context menu |
| Ctrl/Cmd+Shift+I | Inspect element |
| Ctrl/Cmd+Shift+J | Console |
| Ctrl/Cmd+Shift+C | Element picker |
| Ctrl/Cmd+Shift+K | Command palette |
| Ctrl/Cmd+Shift+E | Network panel |
| Ctrl/Cmd+Shift+M | Device toolbar |
| Ctrl/Cmd+Shift+P | Command palette |
| Cmd+Opt+I/J/C/U | macOS DevTools |
| Ctrl/Cmd+U | View source |
| Ctrl/Cmd+S | Save page |

### Deliberately NOT Blocked

- Ctrl+C/V/F/X/A (copy/paste/find)
- Ctrl+P (print)
- F5 / Ctrl+R (refresh)
- Normal typing

### Panic Key Exception

If the user's configured panic key (default `` ` ``) is pressed without modifiers, it is never blocked by the security handler — the panic redirect always works.

### Deterrent Mechanism

```ts
function startDevtoolsDeterrent(): void
```

Runs every 3 seconds:
1. **`debugger` statement**: Only pauses when DevTools is open (makes stepping painful)
2. **Viewport size check**: Compares `outerWidth/Height` vs `innerWidth/Height` — docked DevTools creates a >200px difference
3. **Console warning**: Clears console and prints "DevTools is disabled on this site."

### Injected Styles

```css
body { -webkit-touch-callout: none; }
body { -webkit-user-select: none; user-select: none; }
input, textarea, select, [contenteditable] { -webkit-user-select: text; user-select: text; }
img { -webkit-user-drag: none; user-drag: none; }
```

Text selection and image dragging are blocked globally, except in form fields.

### Inline Head Script

The same protections are inlined in `index.html`'s `<head>` as a `<script>` block, so they run before the module bundle loads. This ensures protection from the first paint.

## URL Safety Validation

**Module**: `src/utils/index.ts` → `isSafeHttpUrl()`

A strict URL validator used throughout the app for any user-controllable URL:

```ts
function isSafeHttpUrl(raw: string | null | undefined): boolean
```

### Rejected

| Pattern | Example | Reason |
|---------|---------|--------|
| Non-http(s) schemes | `javascript:`, `data:`, `blob:` | Script execution |
| Credentialed URLs | `https://user:pass@host/` | Phishing |
| localhost | `http://localhost/` | Intranet probe |
| 0.0.0.0 | `http://0.0.0.0/` | Intranet probe |
| .local TLD | `http://host.local/` | Intranet probe |
| .localhost | `http://host.localhost/` | Intranet probe |
| .internal | `http://host.internal/` | Intranet probe |
| .lan | `http://host.lan/` | Intranet probe |
| 127.x.x.x | `http://127.0.0.1/` | Loopback |
| 10.x.x.x | `http://10.0.0.1/` | Private network |
| 192.168.x.x | `http://192.168.1.1/` | Private network |
| 172.16-31.x.x | `http://172.16.0.1/` | Private network |
| 169.254.x.x | `http://169.254.169.254/` | Link-local (cloud metadata) |

### Accepted

- `http://` and `https://` URLs to public, routable hosts
- No credentials in URL
- No non-routable addresses

## Blocked Ported Domain

**Module**: `src/utils/index.ts`

The domain `sites.google.com/auburnsd.org/jesherheadgames` is blocked throughout the app:

```ts
function isBlockedPortedUrl(url: string): boolean
function sanitizePortedUrl(url: string): string | null
function scrubPortedLinks(): void
function setupBlockedUrlGuards(): void
```

### Guards

1. **`window.open` wrapper**: Sanitizes URL before opening
2. **`location.assign/replace` wrappers**: Sanitizes URL before navigation
3. **Click handler**: Intercepts clicks on `<a>` elements with blocked URLs
4. **Submit handler**: Intercepts form submissions to blocked URLs
5. **MutationObserver**: Watches for dynamically added blocked URLs and scrubs them
6. **DOMContentLoaded**: Initial scrub of all links, iframes, forms, meta refresh tags

## HTML Escaping

**Module**: `src/utils/index.ts`

Two escaping functions:

```ts
function escapeHtml(value: string): string    // For text content
function escapeAttr(value: string): string    // For attribute values
```

Both escape: `&`, `<`, `>`, `"`, `'`

Used when:
- Injecting game names into the direct launch overlay
- Building iframe HTML with game URLs
- Rendering status display content

## Iframe Sandboxing

All game iframes use strict sandbox attributes:

```html
<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals"
        allow="storage-access *; autoplay; fullscreen">
```

### What's Allowed
- `allow-scripts`: JavaScript execution
- `allow-forms`: Form submission
- `allow-popups`: Window.open
- `allow-modals`: Alert/confirm/prompt

### What's NOT Allowed
- `allow-same-origin`: Prevents reading parent DOM/localStorage
- `allow-top-navigation`: Prevents navigating the parent page
- `allow-downloads`: No file downloads

### Storage Access

The `allow="storage-access *"` attribute lets games use `requestStorageAccess()` for save data. The browser gates this on user activation, so it doesn't compromise security.

## Content Security Policy

Defined in `index.html` as a `<meta>` tag:

```
default-src 'self' https: data: blob:;
script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob: data:;
worker-src 'self' blob: https: data:;
style-src 'self' 'unsafe-inline' https:;
img-src 'self' https: data: blob:;
media-src 'self' https: data: blob:;
font-src 'self' https: data:;
frame-src 'self' https: data: blob:;
connect-src 'self' https: blob: data:;
object-src 'none';
base-uri 'self';
form-action 'self';
```

### Why `unsafe-eval`?

The Lumin SDK boot loader fetches its implementation as JSON and runs it via `(0, Function)(code)()`. Without `unsafe-eval`, `Lumin.init()` silently never resolves.

### Why `worker-src blob:`?

Lumin creates a Worker from a `blob:` URL. Without an explicit `worker-src`, the browser falls back to `script-src` and blocks it.

## Settings Import Sanitization

**Module**: `src/settings/index.ts`

When importing settings from a code string:

1. **Size cap**: Max 1MB input (prevents main-thread blocking)
2. **Version check**: Must be `version: 2`
3. **Key allowlist**: Only specific keys can be restored
4. **Value validation**:
   - `panicUrl`/`cloakUrl`: Must pass `isSafeHttpUrl()`
   - `customPrimary`/`customAccent`: Must match `/^#[0-9a-f]{6}$/i`
   - `theme`: Must match `/^[a-z0-9_-]{1,32}$/i`
   - `landingAnims`: Must be `'true'` or `'false'`
   - `pk`: Max 16 characters
   - `favs`: Max 5000 entries
   - `playCount`/`totalPlayTime`: Must be non-negative finite numbers

## TOS Hash Verification

**Module**: `src/ui/index.ts`

The Terms of Service agreement is verified using an FNV-1a hash:

```ts
function computeTOSHash(text: string): string
```

- Hash is computed over the FULL TOS text (not just a prefix)
- Stored in localStorage with timestamp
- Agreement expires after 7 days
- If TOS content changes, hash changes and user must re-agree
