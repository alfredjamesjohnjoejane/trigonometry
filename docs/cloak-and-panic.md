# Cloak & Panic Systems

## Tab Cloaking

**Module**: `src/cloak/index.ts`

Tab cloaking disguises the site by changing the tab title and favicon to look like a Google service, and optionally redirecting the current tab to a decoy URL.

### Cloak Presets

Defined in `src/types/index.ts`:

| Preset | Title | URL | Icon |
|--------|-------|-----|------|
| `classroom` | Google Classroom | `https://classroom.google.com/` | classroom favicon |
| `docs` | Google Docs | `https://docs.google.com/document/u/0/` | docs favicon |
| `drive` | Google Drive | `https://drive.google.com/` | drive favicon |
| `normal` | jesherhead | (empty — no cloak) | icon.png |

### Custom Cloaks

Users can set custom cloak settings:
- **Title**: Any string (stored in `localStorage.cloakTitle`)
- **URL**: Must pass `isSafeHttpUrl()` (stored in `localStorage.cloakUrl`)
- **Icon**: URL or `data:image/` (stored in `localStorage.cloakIcon`)

If no icon is provided, one is auto-generated from the cloak URL using Google's favicon service:
```
https://www.google.com/s2/favicons?sz=64&domain_url=<cloakUrl>
```

### Cloak Activation

Cloaking only activates after the tab has lost focus at least once:

```ts
let cloakArmed = false;

export function installCloakFocusHandlers(): void {
  window.addEventListener('blur', arm);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) arm();
    else updateCloakTabState();
  });
  window.addEventListener('focus', updateCloakTabState);
}
```

This prevents the decoy title from showing on the active tab during initial load (when `document.hasFocus()` is false until first interaction).

### Cloak State Logic

```ts
export function updateCloakTabState(): void {
  const c = getCloakSettings();
  if (!c.url) {
    document.title = HAMMER_TITLE;
    setFavicon(HAMMER_ICON);
    return;
  }
  const blurred = !document.hasFocus() || document.hidden;
  const showDecoy = cloakArmed && blurred;
  document.title = showDecoy ? c.title : HAMMER_TITLE;
  setFavicon(showDecoy ? c.icon : HAMMER_ICON);
}
```

- **Focused tab**: Always shows "jesherhead" title
- **Blurred tab (after first blur)**: Shows decoy title/icon
- **No cloak URL**: Always shows normal title

### About:Blank Shell Pattern

The core cloaking mechanism uses `about:blank` popups:

```ts
export function openAboutBlankShell(title: string, icon: string): AboutBlankShell | null
```

1. Opens `window.open('about:blank', '_blank', 'noopener,noreferrer')`
2. Sets `opener = null` (prevents reverse tabnabbing)
3. Sets document title and favicon via DOM APIs
4. Injects base CSS (margin reset, iframe fullscreen)

**Why not `document.write`?** In current Chrome, calling `document.open()`/`write()` on a new tab re-URLs it to the opener's URL almost instantly, defeating the cloak. DOM manipulation never navigates, so the tab stays on `about:blank`.

### Full Cloak Flow

```ts
export function openLandingInAboutBlank(): void
```

1. Opens `about:blank` shell with decoy title/icon
2. Appends a sandboxed iframe pointing to the real site URL
3. After 300ms, redirects the current tab to the cloak URL via `location.replace()`

Result: The new tab shows the real site (inside an iframe) while the current tab shows the decoy.

### Shell Iframe

```ts
export function appendShellIframe(
  shell: AboutBlankShell,
  opts: { src?: string; srcdoc?: string }
): HTMLIFrameElement | null
```

- `src`: Navigates only the iframe (parent URL stays `about:blank`)
- `srcdoc`: Renders inline HTML with scripts running
- Sandboxed: `allow-scripts allow-forms allow-popups allow-modals`
- `allow="storage-access *; autoplay; fullscreen"`

### Cloak Button Hiding

When running inside a cloak iframe (detected via `window.self !== window.top`), the cloak button is hidden:

```ts
if (window.self !== window.top) document.body.classList.add('cloaked-window');
```

```css
body.cloaked-window .cloak-btn,
body.cloaked-window #global-cloak-btn,
body.cloaked-window #landing-cloak-btn {
  display: none !important;
}
```

---

## Panic Key

**Module**: `src/panic/index.ts`

The panic key is a keyboard shortcut that instantly redirects the user to a decoy site.

### Configuration

| Setting | localStorage Key | Default |
|---------|-----------------|---------|
| Key | `pk` | `` ` `` (backtick) |
| URL | `panicUrl` | `https://www.google.com` |

### Handler

```ts
export function handlePanicKey(e: KeyboardEvent): void
```

- Bound in capture phase (`true` third argument)
- Ignores keypresses while typing in inputs/textareas/contenteditable
- Uses `window.location.replace()` (doesn't add to browser history)
- Falls back to `window.location.href` if `replace()` throws

### URL Safety

```ts
export function resolvePanicUrl(raw: string | null): string
```

The panic URL must pass `isSafeHttpUrl()` — a crafted settings import can never turn the panic key into script execution. Falls back to `https://www.google.com` for any invalid URL.

### Panic Presets

| Preset | Key | URL |
|--------|-----|-----|
| Google | `` ` `` | `https://www.google.com` |
| Classroom | `Escape` | `https://classroom.google.com/` |
| Google Docs | `Shift` | `https://docs.google.com/document/u/0/` |
| Google Drive | `Alt` | `https://drive.google.com/` |

### Security Integration

The panic key is integrated with the DevTools deterrent — if the panic key is pressed without modifiers, it is never blocked by the security handler:

```ts
// src/security/index.ts
export function handleSecurityKeydown(e: KeyboardEvent): boolean {
  if (!isDevtoolsShortcut(e)) return false;
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === getSavedPanicKey()) {
    return false; // Panic key always wins
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}
```

---

## About:Blank Shell Utilities

The cloak module exports reusable shell utilities used by other parts of the app:

| Function | Used By |
|----------|---------|
| `openAboutBlankShell()` | Games, Media, Calculator, Proxy, CinemaOS |
| `appendShellIframe()` | Games, Media, Calculator, Proxy, CinemaOS |
| `openLandingInAboutBlank()` | Cloak button |

All shell-based launchers follow the same pattern:
1. Open `about:blank` popup
2. Build UI via DOM APIs (never `document.write`)
3. Append sandboxed iframe
4. Focus the new window
